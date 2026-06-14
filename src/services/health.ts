import { execFile } from 'child_process';
import type { Express } from 'express';
import {
    fetchSrsStreams,
    rtmpPullUrl,
    srtPullUrl,
    type SrsStream,
    type SrsStreamVideo,
    type SrsStreamAudio,
    type AudioTrackInfo,
} from '../utils/srs.js';
import type { Db } from '../types.js';
import type { OutputService } from './outputs.js';

const FFPROBE_CMD = process.env.FFPROBE_PATH || 'ffprobe';
const FFPROBE_DELAYS_MS = [3000, 10000, 20000, 40000];
const POLL_INTERVAL_MS = 5000;

export interface InputHealth {
    live: boolean;
    isSrt: boolean;
    recvBitrateKbps: number | null;
    sendBitrateKbps: number | null;
    readers: number;
    uptimeMs: number | null;
    video: SrsStreamVideo | null;
    audio: SrsStreamAudio | null;
    audioTracks: AudioTrackInfo[];
}

interface PipelineHealth {
    input: InputHealth;
    outputs: Record<
        string,
        {
            status: string;
            pid: number | null;
            bitrateKbps: number | null;
            retries: number;
            startedAtMs: number | null;
        }
    >;
}

export interface HealthSnapshot {
    generatedAt: string;
    srsReachable: boolean;
    pipelines: Record<string, PipelineHealth>;
}

interface ProbeResult {
    video: SrsStreamVideo | null;
    audio: SrsStreamAudio | null;
    audioTracks: AudioTrackInfo[];
}

function parseFrameRate(str: unknown): number | null {
    if (!str) return null;
    const parts = String(str).split('/');
    if (parts.length !== 2) return null;
    const num = Number(parts[0]);
    const den = Number(parts[1]);
    if (!den || !Number.isFinite(num) || !Number.isFinite(den)) return null;
    const fps = num / den;
    return Number.isFinite(fps) && fps > 0 ? Number(fps.toFixed(3)) : null;
}

function runFfprobe(url: string): Promise<ProbeResult | null> {
    return new Promise((resolve) => {
        execFile(
            FFPROBE_CMD,
            ['-v', 'quiet', '-print_format', 'json', '-show_streams', url],
            { timeout: 15000 },
            (err, stdout) => {
                if (err) {
                    resolve(null);
                    return;
                }
                try {
                    const data = JSON.parse(stdout) as { streams?: Record<string, unknown>[] };
                    const streams = data.streams || [];
                    const vs = streams.find((s) => s.codec_type === 'video') ?? null;
                    const audioStreams = streams.filter((s) => s.codec_type === 'audio');
                    const as_ = audioStreams[0] ?? null;
                    const audioTracks: AudioTrackInfo[] = audioStreams.map((s, idx) => {
                        const tags = (s.tags ?? {}) as Record<string, string>;
                        return {
                            index: idx,
                            codec: (s.codec_name as string) || '',
                            sampleRate: s.sample_rate ? Number(s.sample_rate) : 0,
                            channels: (s.channels as number) || 0,
                            profile: (s.profile as string) || '',
                            language: tags.language ?? null,
                            title: tags.title ?? null,
                        };
                    });
                    resolve({
                        video: vs
                            ? {
                                  codec: (vs.codec_name as string) || '',
                                  width: (vs.width as number) || 0,
                                  height: (vs.height as number) || 0,
                                  fps: parseFrameRate(vs.r_frame_rate),
                                  profile: (vs.profile as string) || '',
                                  level: vs.level != null ? String(Number(vs.level) / 10) : '',
                              }
                            : null,
                        audio: as_
                            ? {
                                  codec: (as_.codec_name as string) || '',
                                  sample_rate: as_.sample_rate ? Number(as_.sample_rate) : 0,
                                  channel: (as_.channels as number) || 0,
                                  profile: (as_.profile as string) || '',
                              }
                            : null,
                        audioTracks,
                    });
                } catch {
                    resolve(null);
                }
            },
        );
    });
}

export function createHealthService(db: Db, outputService: OutputService) {
    let snapshot: HealthSnapshot = {
        generatedAt: new Date().toISOString(),
        srsReachable: false,
        pipelines: {},
    };

    const inputLive = new Map<number, boolean>();
    const inputLiveStartMs = new Map<number, number>();
    const ffprobeResults = new Map<number, ProbeResult>();
    const ffprobeRetries = new Map<number, { timer: NodeJS.Timeout | null; attempt: number }>();

    function clearFfprobeState(pipelineId: number): void {
        const entry = ffprobeRetries.get(pipelineId);
        if (entry?.timer) clearTimeout(entry.timer);
        ffprobeRetries.delete(pipelineId);
        ffprobeResults.delete(pipelineId);
    }

    function scheduleFfprobe(
        pipelineId: number,
        streamKey: string,
        isSrt: boolean,
        attempt = 0,
    ): void {
        if (attempt >= FFPROBE_DELAYS_MS.length) return;
        const url = isSrt ? srtPullUrl(streamKey) : rtmpPullUrl(streamKey);
        const entry: { timer: NodeJS.Timeout | null; attempt: number } = { timer: null, attempt };
        ffprobeRetries.set(pipelineId, entry);
        entry.timer = setTimeout(async () => {
            entry.timer = null;
            if (!ffprobeRetries.has(pipelineId)) return;
            const result = await runFfprobe(url);
            if (!ffprobeRetries.has(pipelineId)) return;
            if (result) {
                ffprobeResults.set(pipelineId, result);
                ffprobeRetries.delete(pipelineId);
            } else if (attempt + 1 < FFPROBE_DELAYS_MS.length) {
                scheduleFfprobe(pipelineId, streamKey, isSrt, attempt + 1);
            } else {
                ffprobeRetries.delete(pipelineId);
                console.warn(`[ffprobe] exhausted all attempts for pipeline ${pipelineId}`);
            }
        }, FFPROBE_DELAYS_MS[attempt]);
        entry.timer?.unref?.();
    }

    function isInputLive(pipelineId: number): boolean {
        return inputLive.get(pipelineId) ?? false;
    }

    async function poll(): Promise<void> {
        const pipelines = db.listPipelines();
        const outputs = db.listOutputs();

        let streams: SrsStream[] = [];
        let srsReachable = true;
        try {
            streams = await fetchSrsStreams();
        } catch {
            srsReachable = false;
        }

        const liveByPath = new Map<string, SrsStream>();
        for (const s of streams) {
            const rtmpLive = s.publish?.active;
            const srtLive = s.tcUrl?.startsWith('srt://') && (s.kbps?.recv_30s ?? 0) > 0;
            if (rtmpLive || srtLive) {
                liveByPath.set(`${s.app}/${s.name}`, s);
            }
        }

        const pipelinesHealth: Record<string, PipelineHealth> = {};
        for (const pipeline of pipelines) {
            const path = `live/${pipeline.streamKey}`;
            const s = liveByPath.get(path);
            const wasLive = inputLive.get(pipeline.id) ?? false;
            const nowLive = !!s;
            inputLive.set(pipeline.id, nowLive);

            if (!wasLive && nowLive) {
                inputLiveStartMs.set(pipeline.id, Date.now());
                outputService.restartPipelineOutputs(pipeline.id);
                const isSrt = !!s?.tcUrl?.startsWith('srt://');
                scheduleFfprobe(pipeline.id, pipeline.streamKey, isSrt);
            }

            if (wasLive && !nowLive) {
                inputLiveStartMs.delete(pipeline.id);
                clearFfprobeState(pipeline.id);
            }

            const pipelineOutputs = outputs.filter((o) => o.pipelineId === pipeline.id);
            const outputsHealth: Record<
                string,
                {
                    status: string;
                    pid: number | null;
                    bitrateKbps: number | null;
                    retries: number;
                    startedAtMs: number | null;
                }
            > = {};
            for (const out of pipelineOutputs) {
                outputsHealth[out.id] = outputService.getStats(out.id);
            }

            const srtStream = nowLive && s?.tcUrl?.startsWith('srt://');
            const probe = ffprobeResults.get(pipeline.id) ?? null;

            pipelinesHealth[String(pipeline.id)] = {
                input: {
                    live: nowLive,
                    isSrt: !!srtStream,
                    recvBitrateKbps: s?.kbps?.recv_30s ?? null,
                    sendBitrateKbps: s?.kbps?.send_30s ?? null,
                    readers: s ? Math.max(0, (s.clients ?? 0) - 1) : 0,
                    uptimeMs: nowLive
                        ? Date.now() - (inputLiveStartMs.get(pipeline.id) ?? Date.now())
                        : null,
                    video: probe?.video ?? (s?.video ? { ...s.video, fps: null } : null),
                    audio: probe?.audio ?? s?.audio ?? null,
                    audioTracks: probe?.audioTracks ?? [],
                },
                outputs: outputsHealth,
            };
        }

        snapshot = {
            generatedAt: new Date().toISOString(),
            srsReachable,
            pipelines: pipelinesHealth,
        };
    }

    function start(): void {
        void poll();
        setInterval(() => void poll(), POLL_INTERVAL_MS).unref();
    }

    function registerRoutes(app: Express): void {
        app.get('/api/health', (_req, res) => {
            res.json(snapshot);
        });
    }

    return { start, registerRoutes, isInputLive };
}
