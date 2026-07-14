import { execFile } from 'child_process';
import type { ChildProcess } from 'child_process';
import type { Express } from 'express';
import {
    fetchSrsClientsForHealth,
    fetchSrsStreams,
    type SrsStream,
    type SrsClient,
    type SrsStreamVideo,
    type SrsStreamAudio,
    type AudioTrackInfo,
} from '../utils/srs.js';
import { readAppConfig } from '../utils/appConfig.js';
import { readSrsConfigValues } from '../utils/srsConfig.js';
import type { Db } from '../types.js';
import type { OutputService } from './outputs.js';
import type { SrtRelayService, SrtRelayStats, SrtRelayStreamStatus } from './srtRelay.js';
import { inputPullUrl, type InputProtocol, type InputState } from './inputState.js';

const FFPROBE_CMD = readAppConfig().ffprobePath;
const FFPROBE_TIMEOUT_MS = 15000;
const FFPROBE_FAILED_REFRESH_MS = 30000;
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
    mediaProbeStartedAt: number | null;
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
    hasErrorHistory: boolean;
    memoryUsageBytes: number | null;
    memoryLimitBytes: number | null;
}

interface PipelineHealth {
    input: InputHealth;
    outputs: Record<string, OutputHealth>;
    srtBonding: SrtRelayStreamStatus & {
        acceptedBySrs: boolean;
        publishConflict: boolean;
        srsPublisher: SrsPublisherInfo | null;
        localSrtPublisherConflict: boolean;
    };
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
    source: 'srs' | 'relay';
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
    startedAt: number;
    checkedAt: number;
    ok: boolean;
    error: string | null;
}

interface SrsPublisherInfo {
    id: string;
    ip: string | null;
    type: string | null;
}

export function isProbeUsable(result: ProbeResult | null): boolean {
    const video = result?.video;
    return !!video?.codec && video.width > 0 && video.height > 0;
}

export function isLoopbackIp(ip: string | null | undefined): boolean {
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function srsClientLooksLikeRelayPublisher(client: SrsClient | undefined): boolean {
    if (!client) return false;
    if (!isLoopbackIp(client.ip)) return false;
    return !client.type || client.type === 'srt-publish';
}

function srsPublisherInfo(client: SrsClient | undefined): SrsPublisherInfo | null {
    if (!client) return null;
    return {
        id: client.id,
        ip: client.ip ?? null,
        type: client.type ?? null,
    };
}

function isLocalSrsHost(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return (
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '::1' ||
        host.startsWith('127.') ||
        host === '::ffff:7f00:1' ||
        host.startsWith('::ffff:127.')
    );
}

function extractStreamResource(value: string): string | null {
    const candidates = [value];
    try {
        candidates.push(decodeURIComponent(value));
    } catch {
        /* keep the raw candidate only */
    }

    for (const candidate of candidates) {
        const match = /(?:^|[?,&#]|::|,)r=([^,&#]+)/.exec(candidate);
        if (!match?.[1]) continue;
        return match[1].replace(/^\/+/, '');
    }

    return null;
}

export function localSrtOutputTargetsStream(url: string, streamKey: string): boolean {
    if (!url.startsWith('srt://')) return false;

    const srs = readSrsConfigValues();
    try {
        const parsed = new URL(url);
        const port = parsed.port ? Number(parsed.port) : 0;
        if (port !== srs.srtPort) return false;
        if (!isLocalSrsHost(parsed.hostname)) return false;
    } catch {
        return false;
    }

    return extractStreamResource(url) === `live/${streamKey}`;
}

export function hasBondedRelayPublishConflict(params: {
    inputConnected: boolean;
    relayInputActive: boolean;
    relayAcceptedBySrs: boolean;
}): boolean {
    return params.inputConnected && params.relayInputActive && !params.relayAcceptedBySrs;
}

function formatTimeOfDay(ts: number): string {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function probeError(result: ProbeResult | null, checkedAt: number): string {
    const prefix = formatTimeOfDay(checkedAt);
    if (!result) return `${prefix} ffprobe did not detect a readable media stream`;
    const video = result.video;
    if (!video) return `${prefix} ffprobe did not detect a video stream`;
    if (!video.codec) return `${prefix} ffprobe detected video without codec metadata`;
    if (video.width <= 0 || video.height <= 0)
        return `${prefix} ffprobe detected video without dimensions`;
    return `${prefix} ffprobe media validation failed`;
}

// ffprobe reports each mpegts elementary stream's PID as a hex string (e.g.
// "0x65"); RTMP/FLV sources have no PID concept and leave this field absent.
function parseMpegtsPid(id: unknown): number | null {
    if (typeof id !== 'string') return null;
    const pid = Number.parseInt(id, 16);
    return Number.isFinite(pid) ? pid : null;
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

function runFfprobe(
    url: string,
    onChild?: (child: ChildProcess) => void,
): Promise<ProbeResult | null> {
    return new Promise((resolve) => {
        const child = execFile(
            FFPROBE_CMD,
            ['-v', 'quiet', '-print_format', 'json', '-show_streams', url],
            { timeout: FFPROBE_TIMEOUT_MS, killSignal: 'SIGKILL' },
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
                            pid: parseMpegtsPid(s.id),
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
        onChild?.(child);
    });
}

export function createHealthService(
    db: Db,
    outputService: OutputService,
    srtRelayService: SrtRelayService,
    inputState: InputState,
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
    // Only 'failed' (was reachable, now isn't) is worth a "down" event — 'stopped'
    // also covers a relay that has simply never been started (no bonding pipeline
    // configured), which would otherwise fire a spurious down event on every boot.
    let prevRelayFailed = false;

    function pushSrsEvent(source: 'srs' | 'relay', type: 'up' | 'down', message: string): void {
        srsEvents.push({ ts: Date.now(), source, type, message });
        if (srsEvents.length > MAX_SRS_EVENTS) srsEvents.shift();
    }

    const inputConnected = new Map<number, boolean>();
    const inputLiveStartMs = new Map<number, number>();
    const inputPublisherCid = new Map<number, string>();
    const ffprobeResults = new Map<number, ProbeStatus>();
    const ffprobeTimers = new Map<number, NodeJS.Timeout>();
    const ffprobeInFlight = new Set<number>();
    const ffprobeStartedAt = new Map<number, number>();
    const ffprobeChildren = new Map<number, ChildProcess>();
    const ffprobeGenerations = new Map<number, number>();

    function clearFfprobeState(pipelineId: number): void {
        if (
            !ffprobeTimers.has(pipelineId) &&
            !ffprobeInFlight.has(pipelineId) &&
            !ffprobeResults.has(pipelineId)
        ) {
            return;
        }
        const timer = ffprobeTimers.get(pipelineId);
        if (timer) clearTimeout(timer);
        ffprobeTimers.delete(pipelineId);
        ffprobeInFlight.delete(pipelineId);
        ffprobeStartedAt.delete(pipelineId);
        const child = ffprobeChildren.get(pipelineId);
        if (child && child.exitCode == null && child.signalCode == null) {
            child.kill('SIGKILL');
        }
        ffprobeChildren.delete(pipelineId);
        ffprobeResults.delete(pipelineId);
        ffprobeGenerations.set(pipelineId, (ffprobeGenerations.get(pipelineId) ?? 0) + 1);
    }

    function scheduleFfprobe(
        pipelineId: number,
        streamKey: string,
        protocol: InputProtocol,
        delayMs = 0,
    ) {
        if (ffprobeTimers.has(pipelineId) || ffprobeInFlight.has(pipelineId)) return;
        const url = inputPullUrl(streamKey, protocol);
        const generation = ffprobeGenerations.get(pipelineId) ?? 0;
        const timer = setTimeout(async () => {
            ffprobeTimers.delete(pipelineId);
            ffprobeInFlight.add(pipelineId);
            const startedAt = Date.now();
            ffprobeStartedAt.set(pipelineId, startedAt);
            try {
                const result = await runFfprobe(url, (child) => {
                    ffprobeChildren.set(pipelineId, child);
                });
                if ((ffprobeGenerations.get(pipelineId) ?? 0) !== generation) return;
                const ok = isProbeUsable(result);
                const checkedAt = Date.now();
                ffprobeResults.set(pipelineId, {
                    result,
                    startedAt,
                    checkedAt,
                    ok,
                    error: ok ? null : probeError(result, checkedAt),
                });
            } finally {
                ffprobeInFlight.delete(pipelineId);
                ffprobeStartedAt.delete(pipelineId);
                ffprobeChildren.delete(pipelineId);
            }
        }, delayMs);
        ffprobeTimers.set(pipelineId, timer);
        timer.unref?.();
    }

    // Probes once per connected publisher; if that probe fails, keeps retrying
    // every FFPROBE_FAILED_REFRESH_MS until it succeeds. Once a probe succeeds
    // for this publisher, it stops re-probing (avoids repeated SRT play/teardown
    // cycles once the input is known healthy).
    function scheduleFfprobeUntilHealthy(
        pipelineId: number,
        streamKey: string,
        protocol: InputProtocol,
        stagger: number,
    ): void {
        if (ffprobeTimers.has(pipelineId) || ffprobeInFlight.has(pipelineId)) return;
        const status = ffprobeResults.get(pipelineId);
        if (status?.ok) return;
        if (status && Date.now() - status.checkedAt < FFPROBE_FAILED_REFRESH_MS) return;
        scheduleFfprobe(pipelineId, streamKey, protocol, stagger * FFPROBE_STAGGER_MS);
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
        const activePipelineIds = new Set(pipelines.map((pipeline) => pipeline.id));
        for (const pipelineId of inputConnected.keys()) {
            if (!activePipelineIds.has(pipelineId)) inputConnected.delete(pipelineId);
        }
        for (const pipelineId of inputLiveStartMs.keys()) {
            if (!activePipelineIds.has(pipelineId)) inputLiveStartMs.delete(pipelineId);
        }
        for (const pipelineId of inputPublisherCid.keys()) {
            if (!activePipelineIds.has(pipelineId)) inputPublisherCid.delete(pipelineId);
        }
        for (const pipelineId of ffprobeResults.keys()) {
            if (!activePipelineIds.has(pipelineId)) clearFfprobeState(pipelineId);
        }
        for (const pipelineId of ffprobeTimers.keys()) {
            if (!activePipelineIds.has(pipelineId)) clearFfprobeState(pipelineId);
        }
        for (const pipelineId of ffprobeInFlight) {
            if (!activePipelineIds.has(pipelineId)) clearFfprobeState(pipelineId);
        }

        const outputRows = db.listOutputs();
        const outputsByPipeline = new Map<number, string[]>();
        const lastErrorById = new Map<string, string | null>();
        const hasErrorHistoryById = new Map<string, boolean>();
        for (const o of outputRows) {
            const ids = outputsByPipeline.get(o.pipelineId);
            if (ids) ids.push(o.id);
            else outputsByPipeline.set(o.pipelineId, [o.id]);
            lastErrorById.set(o.id, o.lastError);
            hasErrorHistoryById.set(o.id, o.hasErrorHistory);
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
                pushSrsEvent('srs', 'down', msg);
                console.warn(`[srs] ${msg}`);
            }
        }
        if (clientsResult.status === 'fulfilled') {
            clients = clientsResult.value;
        }
        if (srsReachable && prevSrsReachable === false) {
            pushSrsEvent('srs', 'up', 'Reachable again');
            console.log('[srs] reachable again');
        }
        prevSrsReachable = srsReachable;
        inputState.setSrsReachable(srsReachable);

        const relayStats = srtRelayService.getStats();
        const relayFailed = relayStats.status === 'failed';
        if (relayFailed && !prevRelayFailed) {
            const msg = `Unreachable: ${relayStats.lastError ?? 'unknown error'}`;
            pushSrsEvent('relay', 'down', msg);
            console.warn(`[relay] ${msg}`);
        } else if (!relayFailed && prevRelayFailed && relayStats.status === 'running') {
            pushSrsEvent('relay', 'up', 'Reachable again');
            console.log('[relay] reachable again');
        }
        prevRelayFailed = relayFailed;

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
        let ffprobeStagger = 0;
        let restartStagger = 0;
        for (const pipeline of pipelines) {
            const path = `live/${pipeline.streamKey}`;
            // When SRS is unreachable we can't distinguish a real stream drop from a
            // transient API failure. Preserve the last known live state so we don't
            // fire spurious offline/online transitions or mass-restart all outputs.
            const prevConnected = inputConnected.get(pipeline.id) ?? false;
            const prevLive = inputState.isLive(pipeline.id);
            const s = srsReachable ? liveByPath.get(path) : undefined;
            const nowConnected = srsReachable ? !!s : prevConnected;
            const nowSrtInput = !!s?.tcUrl?.startsWith('srt://');
            const prevPublisherCid = inputPublisherCid.get(pipeline.id) ?? null;
            const publisherCid = s?.publish?.cid ?? null;
            const publisherChanged =
                nowConnected &&
                publisherCid !== null &&
                prevPublisherCid !== null &&
                publisherCid !== prevPublisherCid;
            if (publisherChanged) clearFfprobeState(pipeline.id);
            const nowProtocol: InputProtocol | null = nowConnected
                ? nowSrtInput
                    ? 'srt'
                    : 'rtmp'
                : null;
            const nowLive = srsReachable ? nowConnected : prevLive;
            // UI should reflect whether the input is currently usable through SRS.
            // Keep nowLive sticky internally for restart/logging behavior during an
            // SRS outage, but don't present a stale green input while SRS is down.
            const displayLive = srsReachable ? nowLive : false;
            const displayConnected = srsReachable ? nowConnected : false;

            if (srsReachable) {
                inputConnected.set(pipeline.id, nowConnected);
                if (nowConnected && s) {
                    if (publisherCid) inputPublisherCid.set(pipeline.id, publisherCid);
                    inputState.setPipelineState(pipeline.id, nowLive, nowProtocol);
                    if (nowProtocol) {
                        scheduleFfprobeUntilHealthy(
                            pipeline.id,
                            pipeline.streamKey,
                            nowProtocol,
                            ffprobeStagger++,
                        );
                    }
                } else if (!nowConnected) {
                    inputState.clearPipeline(pipeline.id);
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
                            `Input media detected (${inputState.getProtocol(pipeline.id) ?? 'unknown'})`,
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
                    inputPublisherCid.delete(pipeline.id);
                    inputState.clearPipeline(pipeline.id);
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
                    hasErrorHistory: hasErrorHistoryById.get(outId) ?? false,
                };
            }

            const srtStream = displayLive && s?.tcUrl?.startsWith('srt://');
            const mediaProbe = ffprobeResults.get(pipeline.id) ?? null;
            const displayMediaOk = mediaProbe ? mediaProbe.ok : null;
            const displayMediaError = mediaProbe?.error ?? null;
            const probedMedia = mediaProbe?.ok ? mediaProbe.result : null;
            const displayVideo = probedMedia?.video ?? s?.video ?? null;
            inputState.setInputResolution(
                pipeline.id,
                displayConnected ? (displayVideo?.width ?? null) : null,
                displayConnected ? (displayVideo?.height ?? null) : null,
            );
            const bondingStreamId = `#!::r=live/${pipeline.streamKey},m=publish`;
            const rawBondingStatus = srtRelayService.getStreamStatus(bondingStreamId);
            const publisher = s?.publish?.cid ? publisherByCid.get(s.publish.cid) : undefined;
            const localSrtPublisherConflict = outputRows.some((output) => {
                if (output.pipelineId === pipeline.id) return false;
                if (output.desiredState !== 'running') return false;
                if (outputService.getStats(output.id).status !== 'running') return false;
                return output.sinks.some((sink) =>
                    localSrtOutputTargetsStream(sink.url, pipeline.streamKey),
                );
            });
            const relayAcceptedBySrs =
                !!srtStream &&
                srsClientLooksLikeRelayPublisher(publisher) &&
                !localSrtPublisherConflict;
            const relayPublishConflict = hasBondedRelayPublishConflict({
                inputConnected: displayConnected,
                relayInputActive: rawBondingStatus.inputActive,
                relayAcceptedBySrs,
            });
            const bondingStatus: PipelineHealth['srtBonding'] = {
                ...rawBondingStatus,
                acceptedBySrs: relayAcceptedBySrs,
                publishConflict: relayPublishConflict,
                srsPublisher: srsPublisherInfo(publisher),
                localSrtPublisherConflict,
            };

            pipelinesHealth[String(pipeline.id)] = {
                input: {
                    connected: displayConnected,
                    live: displayLive,
                    isSrt:
                        !!srtStream ||
                        (displayConnected && inputState.getProtocol(pipeline.id) === 'srt'),
                    mediaOk: displayConnected ? displayMediaOk : null,
                    mediaProbeStartedAt: displayConnected
                        ? ((ffprobeInFlight.has(pipeline.id)
                              ? ffprobeStartedAt.get(pipeline.id)
                              : mediaProbe?.startedAt) ?? null)
                        : null,
                    mediaCheckedAt: displayConnected ? (mediaProbe?.checkedAt ?? null) : null,
                    mediaError: displayConnected ? displayMediaError : null,
                    recvBitrateKbps: s?.kbps?.recv_30s ?? null,
                    sendBitrateKbps: s?.kbps?.send_30s ?? null,
                    readers: s ? Math.max(0, (s.clients ?? 0) - 1) : 0,
                    uptimeMs: displayLive
                        ? Date.now() - (inputLiveStartMs.get(pipeline.id) ?? Date.now())
                        : null,
                    publisherIp: displayConnected ? (publisher?.ip ?? null) : null,
                    publisherType: displayConnected ? (publisher?.type ?? null) : null,
                    video: displayVideo,
                    audio: probedMedia?.audio ?? s?.audio ?? null,
                    audioTracks: probedMedia?.audioTracks ?? [],
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

    function shutdown(): void {
        for (const timer of ffprobeTimers.values()) {
            clearTimeout(timer);
        }
        ffprobeTimers.clear();
        ffprobeInFlight.clear();
        ffprobeStartedAt.clear();
        for (const child of ffprobeChildren.values()) {
            if (child.exitCode == null && child.signalCode == null) {
                child.kill('SIGKILL');
            }
        }
        ffprobeChildren.clear();
    }

    return {
        start,
        registerRoutes,
        shutdown,
        getSrsEvents: (): SrsEvent[] => [...srsEvents],
    };
}
