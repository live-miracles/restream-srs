import { execFile } from 'child_process';
import type { Express } from 'express';
import {
    fetchSrsClientsForHealth,
    fetchSrsStreams,
    rtmpPullUrl,
    srtPullUrl,
    type SrsStream,
    type SrsClient,
    type SrsStreamVideo,
    type SrsStreamAudio,
    type AudioTrackInfo,
} from '../utils/srs.js';
import type { Db } from '../types.js';
import type { OutputService } from './outputs.js';
import type { SrtRelayService, SrtRelayStats, SrtRelayStreamStatus } from './srtRelay.js';

const FFPROBE_CMD = process.env.FFPROBE_PATH || 'ffprobe';
const FFPROBE_TIMEOUT_MS = 15000;
const FFPROBE_FAST_REFRESH_MS = 15000;
const FFPROBE_HEALTHY_REFRESH_MS = 30000;
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
    connected: boolean;
    live: boolean;
    isSrt: boolean;
    mediaOk: boolean | null;
    mediaCheckedAt: number | null;
    mediaError: string | null;
    recvBitrateKbps: number | null;
    sendBitrateKbps: number | null;
    readers: number;
    uptimeMs: number | null;
    publisherIp: string | null;
    publisherType: string | null;
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
    warningReason: string | null;
    lastError: string | null;
}

interface PipelineHealth {
    input: InputHealth;
    outputs: Record<string, OutputHealth>;
    srtBonding: SrtRelayStreamStatus;
}

export interface HealthSnapshot {
    generatedAt: string;
    srsReachable: boolean;
    srtRelay: SrtRelayStats;
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

interface ProbeStatus {
    result: ProbeResult | null;
    checkedAt: number;
    ok: boolean;
    error: string | null;
}

export function isProbeUsable(result: ProbeResult | null): boolean {
    const video = result?.video;
    return !!video?.codec && video.width > 0 && video.height > 0;
}

function hasUsableSrsVideo(stream: SrsStream | undefined): boolean {
    const video = stream?.video;
    return !!video?.codec && video.width > 0 && video.height > 0;
}

function probeError(result: ProbeResult | null): string {
    if (!result) return 'ffprobe did not detect a readable media stream';
    const video = result.video;
    if (!video) return 'ffprobe did not detect a video stream';
    if (!video.codec) return 'ffprobe detected video without codec metadata';
    if (video.width <= 0 || video.height <= 0) return 'ffprobe detected video without dimensions';
    return 'ffprobe media validation failed';
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
        srtRelay: srtRelayService.getStats(),
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

    const inputConnected = new Map<number, boolean>();
    const inputLive = new Map<number, boolean>();
    // Protocol the live input is currently published with, detected from the SRS
    // stream's tcUrl. Consumed by the output and preview services to decide
    // whether to pull the input back via SRT or RTMP (with srt_to_rtmp off an SRT
    // input only exists over SRT and an RTMP input only over RTMP). Set while the
    // input is live, cleared when it drops.
    const inputProtocol = new Map<number, 'srt' | 'rtmp'>();
    const inputLiveStartMs = new Map<number, number>();
    const ffprobeResults = new Map<number, ProbeStatus>();
    const ffprobeTimers = new Map<number, NodeJS.Timeout>();
    const ffprobeInFlight = new Set<number>();
    const ffprobeGenerations = new Map<number, number>();

    function clearFfprobeState(pipelineId: number): void {
        const timer = ffprobeTimers.get(pipelineId);
        if (timer) clearTimeout(timer);
        ffprobeTimers.delete(pipelineId);
        ffprobeInFlight.delete(pipelineId);
        ffprobeResults.delete(pipelineId);
        ffprobeGenerations.set(pipelineId, (ffprobeGenerations.get(pipelineId) ?? 0) + 1);
    }

    function scheduleFfprobe(pipelineId: number, streamKey: string, isSrt: boolean, delayMs = 0) {
        if (ffprobeTimers.has(pipelineId) || ffprobeInFlight.has(pipelineId)) return;
        const url = isSrt ? srtPullUrl(streamKey) : rtmpPullUrl(streamKey);
        const generation = ffprobeGenerations.get(pipelineId) ?? 0;
        const timer = setTimeout(async () => {
            ffprobeTimers.delete(pipelineId);
            ffprobeInFlight.add(pipelineId);
            try {
                const result = await runFfprobe(url);
                if ((ffprobeGenerations.get(pipelineId) ?? 0) !== generation) return;
                const ok = isProbeUsable(result);
                ffprobeResults.set(pipelineId, {
                    result,
                    checkedAt: Date.now(),
                    ok,
                    error: ok ? null : probeError(result),
                });
            } finally {
                ffprobeInFlight.delete(pipelineId);
            }
        }, delayMs);
        ffprobeTimers.set(pipelineId, timer);
        timer.unref?.();
    }

    function schedulePeriodicFfprobe(
        pipelineId: number,
        streamKey: string,
        isSrt: boolean,
        stagger: number,
    ): void {
        if (ffprobeTimers.has(pipelineId) || ffprobeInFlight.has(pipelineId)) return;
        const status = ffprobeResults.get(pipelineId);
        const refreshMs = status?.ok ? FFPROBE_HEALTHY_REFRESH_MS : FFPROBE_FAST_REFRESH_MS;
        if (status && Date.now() - status.checkedAt < refreshMs) return;
        scheduleFfprobe(pipelineId, streamKey, isSrt, stagger * FFPROBE_STAGGER_MS);
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
        let clients: SrsClient[] = [];
        let srsReachable = true;
        const [streamsResult, clientsResult] = await Promise.allSettled([
            fetchSrsStreams(),
            fetchSrsClientsForHealth(),
        ]);
        if (streamsResult.status === 'fulfilled') {
            streams = streamsResult.value;
        } else {
            srsReachable = false;
            if (prevSrsReachable !== false) {
                const reason = streamsResult.reason;
                const msg = `Unreachable: ${reason instanceof Error ? reason.message : String(reason)}`;
                pushSrsEvent('down', msg);
                console.warn(`[srs] ${msg}`);
            }
        }
        if (clientsResult.status === 'fulfilled') {
            clients = clientsResult.value;
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
        const publisherByCid = new Map<string, SrsClient>();
        for (const client of clients) {
            if (client.publish && client.id) publisherByCid.set(client.id, client);
        }

        const pipelinesHealth: Record<string, PipelineHealth> = {};
        const relayStats = srtRelayService.getStats();
        let ffprobeStagger = 0;
        let restartStagger = 0;
        for (const pipeline of pipelines) {
            const path = `live/${pipeline.streamKey}`;
            // When SRS is unreachable we can't distinguish a real stream drop from a
            // transient API failure. Preserve the last known live state so we don't
            // fire spurious offline/online transitions or mass-restart all outputs.
            const prevConnected = inputConnected.get(pipeline.id) ?? false;
            const prevLive = inputLive.get(pipeline.id) ?? false;
            const s = srsReachable ? liveByPath.get(path) : undefined;
            const nowConnected = srsReachable ? !!s : prevConnected;
            const probe = ffprobeResults.get(pipeline.id) ?? null;
            const nowLive = srsReachable
                ? nowConnected && (probe?.ok ?? hasUsableSrsVideo(s))
                : prevLive;
            // UI should reflect whether the input is currently usable through SRS.
            // Keep nowLive sticky internally for restart/logging behavior during an
            // SRS outage, but don't present a stale green input while SRS is down.
            const displayLive = srsReachable ? nowLive : false;
            const displayConnected = srsReachable ? nowConnected : false;

            if (srsReachable) {
                inputConnected.set(pipeline.id, nowConnected);
                inputLive.set(pipeline.id, nowLive);
                if (nowConnected && s) {
                    inputProtocol.set(pipeline.id, s.tcUrl?.startsWith('srt://') ? 'srt' : 'rtmp');
                    const isSrt = !!s.tcUrl?.startsWith('srt://');
                    schedulePeriodicFfprobe(
                        pipeline.id,
                        pipeline.streamKey,
                        isSrt,
                        ffprobeStagger++,
                    );
                } else if (!nowConnected) {
                    inputProtocol.delete(pipeline.id);
                }

                if (!prevLive && nowLive) {
                    inputLiveStartMs.set(pipeline.id, Date.now());
                    restartStagger += outputService.restartPipelineOutputs(
                        pipeline.id,
                        restartStagger,
                    );
                    try {
                        db.appendPipelineLog(
                            pipeline.id,
                            'online',
                            `Input media detected (${inputProtocol.get(pipeline.id) ?? 'unknown'})`,
                        );
                    } catch {
                        /* non-critical */
                    }
                }

                if (prevLive && !nowLive && nowConnected) {
                    const uptimeSec = Math.round(
                        (Date.now() - (inputLiveStartMs.get(pipeline.id) ?? Date.now())) / 1000,
                    );
                    inputLiveStartMs.delete(pipeline.id);
                    try {
                        db.appendPipelineLog(
                            pipeline.id,
                            'media_lost',
                            `Input media lost (was valid for ${uptimeSec}s)`,
                        );
                    } catch {
                        /* non-critical */
                    }
                }

                if (prevConnected && !nowConnected) {
                    const liveStartMs = inputLiveStartMs.get(pipeline.id);
                    const uptimeSec =
                        liveStartMs != null ? Math.round((Date.now() - liveStartMs) / 1000) : null;
                    inputConnected.delete(pipeline.id);
                    inputLive.set(pipeline.id, false);
                    inputLiveStartMs.delete(pipeline.id);
                    clearFfprobeState(pipeline.id);
                    try {
                        db.appendPipelineLog(
                            pipeline.id,
                            'offline',
                            uptimeSec == null
                                ? 'Input disconnected'
                                : `Input disconnected (was live for ${uptimeSec}s)`,
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
                    bitrateKbps: displayLive ? stats.bitrateKbps : null,
                    failures: stats.failures,
                    lastError: lastErrorById.get(outId) ?? null,
                };
            }

            const srtStream = displayLive && s?.tcUrl?.startsWith('srt://');
            const mediaProbe = ffprobeResults.get(pipeline.id) ?? null;
            const bondingStreamId = `#!::r=live/${pipeline.streamKey},m=publish`;
            const bondingStatus = srtRelayService.getStreamStatus(bondingStreamId);
            const publisher = s?.publish?.cid ? publisherByCid.get(s.publish.cid) : undefined;

            pipelinesHealth[String(pipeline.id)] = {
                input: {
                    connected: displayConnected,
                    live: displayLive,
                    isSrt:
                        !!srtStream ||
                        (displayConnected && inputProtocol.get(pipeline.id) === 'srt'),
                    mediaOk: displayConnected ? (mediaProbe?.ok ?? null) : null,
                    mediaCheckedAt: displayConnected ? (mediaProbe?.checkedAt ?? null) : null,
                    mediaError: displayConnected ? (mediaProbe?.error ?? null) : null,
                    recvBitrateKbps: s?.kbps?.recv_30s ?? null,
                    sendBitrateKbps: s?.kbps?.send_30s ?? null,
                    readers: s ? Math.max(0, (s.clients ?? 0) - 1) : 0,
                    uptimeMs: displayLive
                        ? Date.now() - (inputLiveStartMs.get(pipeline.id) ?? Date.now())
                        : null,
                    publisherIp: displayConnected ? (publisher?.ip ?? null) : null,
                    publisherType: displayConnected ? (publisher?.type ?? null) : null,
                    video:
                        mediaProbe?.result?.video ?? (s?.video ? { ...s.video, fps: null } : null),
                    audio: mediaProbe?.result?.audio ?? s?.audio ?? null,
                    audioTracks: mediaProbe?.result?.audioTracks ?? [],
                },
                outputs: outputsHealth,
                srtBonding: bondingStatus,
            };
        }

        snapshot = {
            generatedAt: new Date().toISOString(),
            srsReachable,
            srtRelay: relayStats,
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
