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
import type { SrtRelayService, SrtRelayStats } from './srtRelay.js';

const FFPROBE_CMD = process.env.FFPROBE_PATH || 'ffprobe';
const FFPROBE_DELAYS_MS = [3000, 10000, 20000, 40000];
const FFPROBE_TIMEOUT_MS = 15000;
// Stagger concurrent ffprobe launches instead of capping concurrency with a
// semaphore. The real risk is the thundering-herd burst (all N pipelines firing
// at the same millisecond after a mass reconnect), not the sustained overlap —
// probes read different streams so there is no shared bottleneck. Stagger is
// simpler and mirrors the output restart pattern; a semaphore would be needed
// only if memory pressure from simultaneous ffprobe processes became a concern.
const FFPROBE_STAGGER_MS = 200;
const POLL_INTERVAL_MS = 5000;
const MAX_SRS_EVENTS = 200;

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

// Per-output entry in the health snapshot: live process stats (OutputStats from
// the output service) merged with the persisted lastError read from the DB.
// lastError is not part of the runtime stats — it's joined in here so the UI can
// show the last failure alongside live status.
interface OutputHealth {
    status: string;
    pid: number | null;
    bitrateKbps: number | null;
    startedAtMs: number | null;
    failures: number;
    lastError: string | null;
}

interface PipelineHealth {
    input: InputHealth;
    outputs: Record<string, OutputHealth>;
    srtRelay: SrtRelayStats;
}

export interface HealthSnapshot {
    generatedAt: string;
    srsReachable: boolean;
    // Config revision at snapshot time. Clients compare this against the rev they
    // loaded /api/config at; a mismatch means the config was edited elsewhere and
    // the client should reload. Carried on the health snapshot so it reaches every
    // client on the regular 5s poll without an extra request.
    configRev: number;
    pipelines: Record<string, PipelineHealth>;
}

export interface SrsEvent {
    ts: number;
    type: 'up' | 'down';
    message: string;
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
            { timeout: FFPROBE_TIMEOUT_MS },
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
                                  fieldOrder: (vs.field_order as string) || null,
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

export function createHealthService(
    db: Db,
    outputService: OutputService,
    srtRelayService: SrtRelayService,
) {
    let snapshot: HealthSnapshot = {
        generatedAt: new Date().toISOString(),
        srsReachable: false,
        configRev: db.getConfigRev(),
        pipelines: {},
    };

    const srsEvents: SrsEvent[] = [];
    let prevSrsReachable: boolean | null = null;
    let lastSrsReachable = false;

    function pushSrsEvent(type: 'up' | 'down', message: string): void {
        srsEvents.push({ ts: Date.now(), type, message });
        if (srsEvents.length > MAX_SRS_EVENTS) srsEvents.shift();
    }

    const inputLive = new Map<number, boolean>();
    // Protocol the live input is currently published with, detected from the SRS
    // stream's tcUrl. Consumed by the output and preview services to decide
    // whether to pull the input back via SRT or RTMP (with srt_to_rtmp off an SRT
    // input only exists over SRT and an RTMP input only over RTMP). Set while the
    // input is live, cleared when it drops.
    const inputProtocol = new Map<number, 'srt' | 'rtmp'>();
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
        stagger = 0,
    ): void {
        if (attempt >= FFPROBE_DELAYS_MS.length) return;
        const url = isSrt ? srtPullUrl(streamKey) : rtmpPullUrl(streamKey);
        const entry: { timer: NodeJS.Timeout | null; attempt: number } = { timer: null, attempt };
        ffprobeRetries.set(pipelineId, entry);
        const delay = FFPROBE_DELAYS_MS[attempt] + stagger * FFPROBE_STAGGER_MS;
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
        }, delay);
        entry.timer?.unref?.();
    }

    // An output may only be (re)started when SRS is reachable and the pipeline's
    // input is live — otherwise ffmpeg would just hang or churn against a dead input.
    function isInputReady(pipelineId: number): boolean {
        return lastSrsReachable && (inputLive.get(pipelineId) ?? false);
    }

    // Pull protocol for the pipeline's currently-live input, or null if not live
    // / not yet detected. Callers fall back to RTMP when null.
    function getInputProtocol(pipelineId: number): 'srt' | 'rtmp' | null {
        return inputProtocol.get(pipelineId) ?? null;
    }

    let pollInProgress = false;

    async function poll(): Promise<void> {
        if (pollInProgress) return;
        pollInProgress = true;
        try {
            await doPoll();
        } finally {
            pollInProgress = false;
        }
    }

    async function doPoll(): Promise<void> {
        const pipelines = db.listPipelines();
        const outputsByPipeline = new Map<number, string[]>();
        const lastErrorById = new Map<string, string | null>();
        for (const o of db.listOutputIds()) {
            const ids = outputsByPipeline.get(o.pipelineId);
            if (ids) ids.push(o.id);
            else outputsByPipeline.set(o.pipelineId, [o.id]);
            lastErrorById.set(o.id, o.lastError);
        }

        let streams: SrsStream[] = [];
        let srsReachable = true;
        try {
            streams = await fetchSrsStreams();
        } catch (e) {
            srsReachable = false;
            if (prevSrsReachable !== false) {
                const msg = `Unreachable: ${e instanceof Error ? e.message : String(e)}`;
                pushSrsEvent('down', msg);
                console.warn(`[srs] ${msg}`);
            }
        }
        if (srsReachable && prevSrsReachable === false) {
            pushSrsEvent('up', 'SRS is reachable again');
            console.log('[srs] reachable again');
        }
        prevSrsReachable = srsReachable;
        lastSrsReachable = srsReachable;

        const liveByPath = new Map<string, SrsStream>();
        for (const s of streams) {
            if (s.publish?.active) {
                liveByPath.set(`${s.app}/${s.name}`, s);
            }
        }

        const pipelinesHealth: Record<string, PipelineHealth> = {};
        let ffprobeStagger = 0;
        let restartStagger = 0;
        for (const pipeline of pipelines) {
            const path = `live/${pipeline.streamKey}`;
            // When SRS is unreachable we can't distinguish a real stream drop from a
            // transient API failure. Preserve the last known live state so we don't
            // fire spurious offline/online transitions or mass-restart all outputs.
            const prevLive = inputLive.get(pipeline.id) ?? false;
            const s = srsReachable ? liveByPath.get(path) : undefined;
            const nowLive = srsReachable ? !!s : prevLive;

            if (srsReachable) {
                inputLive.set(pipeline.id, nowLive);
                if (nowLive && s) {
                    inputProtocol.set(pipeline.id, s.tcUrl?.startsWith('srt://') ? 'srt' : 'rtmp');
                } else if (!nowLive) {
                    inputProtocol.delete(pipeline.id);
                }

                if (!prevLive && nowLive) {
                    inputLiveStartMs.set(pipeline.id, Date.now());
                    restartStagger += outputService.restartPipelineOutputs(
                        pipeline.id,
                        restartStagger,
                    );
                    const isSrt = !!s?.tcUrl?.startsWith('srt://');
                    scheduleFfprobe(pipeline.id, pipeline.streamKey, isSrt, 0, ffprobeStagger++);
                    try {
                        db.appendPipelineLog(
                            pipeline.id,
                            'online',
                            `Input connected (${isSrt ? 'SRT' : 'RTMP'})`,
                        );
                    } catch {
                        /* non-critical */
                    }
                }

                if (prevLive && !nowLive) {
                    const uptimeSec = Math.round(
                        (Date.now() - (inputLiveStartMs.get(pipeline.id) ?? Date.now())) / 1000,
                    );
                    inputLiveStartMs.delete(pipeline.id);
                    clearFfprobeState(pipeline.id);
                    try {
                        db.appendPipelineLog(
                            pipeline.id,
                            'offline',
                            `Input disconnected (was live for ${uptimeSec}s)`,
                        );
                    } catch {
                        /* non-critical */
                    }
                }
            }

            const outputsHealth: Record<string, OutputHealth> = {};
            for (const outId of outputsByPipeline.get(pipeline.id) ?? []) {
                const stats = outputService.getStats(outId);
                outputsHealth[outId] = {
                    ...stats,
                    // Bitrate from ffmpeg is meaningless when the input is offline
                    // (ffmpeg may still be connected to the destination, draining
                    // buffered data). Hide it so the UI doesn't show a high bitrate
                    // alongside a red/error status.
                    bitrateKbps: nowLive ? stats.bitrateKbps : null,
                    failures: stats.failures,
                    lastError: lastErrorById.get(outId) ?? null,
                };
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
                srtRelay: srtRelayService.getStats(pipeline.id),
            };
        }

        snapshot = {
            generatedAt: new Date().toISOString(),
            srsReachable,
            configRev: db.getConfigRev(),
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

    return {
        start,
        registerRoutes,
        isInputReady,
        getInputProtocol,
        getSrsEvents: (): SrsEvent[] => [...srsEvents],
    };
}
