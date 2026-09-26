import {
    escapeHtml,
    formatBitrate,
    formatBytesCompact,
    fmtMs,
    fmtMbpsValue,
    LOW_BITRATE_KBPS,
    STATUS_COLOR_GOOD,
    STATUS_COLOR_WARN,
    STATUS_COLOR_ERROR,
    STATUS_COLOR_OFF,
} from '../core/utils.js';
import { state } from '../core/state.js';
import type {
    AudioInfo,
    AudioTrackInfo,
    HostProbeOverviewTarget,
    InputHealth,
    MetricSample,
    OutputView,
    PipelineView,
    SrtBondingLeg,
    SrtBondingInputStatus,
    VideoInfo,
} from '../types.js';

const ICON_ERROR = '<span aria-hidden="true">!</span>';

declare global {
    interface Window {
        selectPipeline: (id: string | null) => void;
    }
}

type OutStatus = 'good' | 'warn' | 'error' | 'off';
type InputStatus = 'good' | 'warn' | 'error' | 'off';
type OverviewIssue = {
    severity: 'warning' | 'error';
    message: string;
};
type BondingIndicator = {
    leftColor: string;
    rightColor: string;
    issues: OverviewIssue[];
    offMessage: string | null;
};
type RelayFlowStatus = 'good' | 'warn' | 'error' | 'off';

type OutputVideoResolution = { width: number; height: number };
type OutputVideoContext = { input: InputHealth; output: OutputView };
type OutputVideoValue<T> = T | 'copy' | ((ctx: OutputVideoContext) => T | null);
type OutputVideoDisplayPreset = {
    codec: OutputVideoValue<string>;
    resolution?: OutputVideoValue<OutputVideoResolution>;
    fps?: OutputVideoValue<number | null>;
    fieldOrder?: OutputVideoValue<string | null>;
};

const OUTPUT_VIDEO_PRESETS: Record<string, OutputVideoDisplayPreset> = {
    copy: { codec: 'copy', resolution: 'copy', fps: 'copy', fieldOrder: 'copy' },
    '720p': { codec: 'h264', resolution: { width: 1280, height: 720 }, fps: 'copy' },
    '1080p': { codec: 'h264', resolution: { width: 1920, height: 1080 }, fps: 'copy' },
    vertical_rotate: {
        codec: 'h264',
        resolution: ({ input }) => rotatedScaleResolution(input.video, 720),
        fps: 'copy',
        fieldOrder: 'copy',
    },
};

export function fmtFieldOrder(fo: string | null | undefined): string | null {
    if (!fo || fo === 'unknown') return null;
    if (fo === 'progressive') return 'P';
    if (fo === 'tt' || fo === 'tb') return 'i TFF';
    if (fo === 'bb' || fo === 'bt') return 'i BFF';
    return fo;
}

const RELAY_FLOW_STALE_MS = 15000;
const METRIC_WARN_PERCENT = 70;
const METRIC_ERROR_PERCENT = 90;

export function outputMemoryPercent(o: OutputView): number | null {
    if (o.memoryUsageBytes == null || !o.memoryLimitBytes) return null;
    return (o.memoryUsageBytes / o.memoryLimitBytes) * 100;
}

export function formatOutputMemory(o: OutputView): string | null {
    if (o.memoryUsageBytes == null) return null;
    return formatBytesCompact(o.memoryUsageBytes);
}

export function memorySeverityClass(percent: number | null): string {
    if (percent !== null && percent >= METRIC_ERROR_PERCENT) return 'text-error font-semibold';
    if (percent !== null && percent >= METRIC_WARN_PERCENT) return 'text-warning font-semibold';
    return '';
}

function formatCompactCount(n: number): string {
    if (!Number.isFinite(n)) return '0';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
    return String(Math.round(n));
}

function fmtLossRexmitDrop(
    loss: number | null | undefined,
    rexmit: number | null | undefined,
    drop: number | null | undefined,
): string {
    return `${loss != null ? formatCompactCount(loss) : '—'} / ${rexmit != null ? formatCompactCount(rexmit) : '—'} / ${drop != null ? formatCompactCount(drop) : '—'}`;
}

function fmtCompactNullableCount(n: number | null | undefined): string {
    return n != null ? formatCompactCount(n) : '—';
}

function inputAggregateStatsAreDropOnly(input: SrtBondingInputStatus): boolean {
    return input.recvLossTotal === null && input.retransTotal === null;
}

// True if the most recent error is still relevant to what's on screen right
// now. A watchdog/exit path always records the error before the process dies,
// so once a fresh restart happens (o.startedAtMs moves past lastErrorAt) the
// error belongs to a prior, already-resolved incarnation. When there's no
// current process at all (startedAtMs null), that's either an actual
// between-retries gap after a real ffmpeg failure (failures > 0 — keep
// showing it) or a manual start that hasn't spawned yet / is waiting on the
// input to come ready (start() resets failures to 0 before attempting to
// spawn) — in that case any old error is a stale prior incarnation, not the
// reason ffmpeg isn't running yet, so don't resurrect it.
export function hasCurrentOutputError(o: OutputView): boolean {
    if (o.lastError === null || o.lastErrorAt === null) return false;
    if (o.startedAtMs === null) return o.failures > 0;
    return o.lastErrorAt >= o.startedAtMs;
}

// SRS reports a zero receive bitrate until its rolling bitrate statistics are
// populated. Do not turn that startup placeholder into a low-bitrate warning.
const INPUT_BITRATE_STATS_WARMUP_MS = 30_000;

function inputBitrateStatsReady(input: InputHealth): boolean {
    return input.uptimeMs !== null && input.uptimeMs >= INPUT_BITRATE_STATS_WARMUP_MS;
}

export function displayInputBitrateKbps(input: InputHealth): number | null {
    if (input.live && input.recvBitrateKbps === 0 && !inputBitrateStatsReady(input)) {
        return null;
    }
    return input.recvBitrateKbps;
}

export interface OutputHealth {
    status: OutStatus;
    issues: OverviewIssue[];
}

interface DerivedInputHealth {
    status: InputStatus;
    issues: OverviewIssue[];
}

export function outputHealth(o: OutputView, input: InputHealth): OutputHealth {
    if (o.desiredState === 'stopped') return { status: 'off', issues: [] };

    const withFailures = (message: string): string =>
        o.failures > 0
            ? `${o.failures} error${o.failures === 1 ? '' : 's'} since last start. ${message}`
            : message;

    if (o.status === 'failed') {
        return {
            status: 'error',
            issues: [
                {
                    severity: 'error',
                    message: withFailures(
                        summarizeOutputError(o.lastError, 'Output process failed.'),
                    ),
                },
            ],
        };
    }

    if (o.status === 'running') {
        if (!input.live) {
            return {
                status: 'warn',
                issues: [
                    { severity: 'warning', message: 'Output is running but input is not live.' },
                ],
            };
        }
        if (o.warningReason !== null) {
            return { status: 'warn', issues: [{ severity: 'warning', message: o.warningReason }] };
        }
        if (o.bitrateKbps !== null && o.bitrateKbps >= LOW_BITRATE_KBPS) {
            return { status: 'good', issues: [] };
        }
        if (o.bitrateKbps === null && hasCurrentOutputError(o)) {
            return {
                status: 'error',
                issues: [
                    {
                        severity: 'error',
                        message: withFailures(
                            summarizeOutputError(
                                o.lastError,
                                'Output has no bitrate after an error.',
                            ),
                        ),
                    },
                ],
            };
        }
        if (o.bitrateKbps === null) {
            return {
                status: 'warn',
                issues: [
                    {
                        severity: 'warning',
                        message: 'Output is running but no bitrate is reported yet.',
                    },
                ],
            };
        }
        return {
            status: 'warn',
            issues: [
                {
                    severity: 'warning',
                    message: `Output bitrate is below ${LOW_BITRATE_KBPS} kb/s.`,
                },
            ],
        };
    }

    // status === 'stopped' but desiredState === 'running': between retries
    if (hasCurrentOutputError(o)) {
        return {
            status: 'error',
            issues: [
                {
                    severity: 'error',
                    message: withFailures(
                        summarizeOutputError(o.lastError, 'Output failed and is waiting to retry.'),
                    ),
                },
            ],
        };
    }
    return {
        status: 'warn',
        issues: [{ severity: 'warning', message: 'Output is waiting to start or retry.' }],
    };
}

export function outStatus(o: OutputView, input: InputHealth): OutStatus {
    return outputHealth(o, input).status;
}

function inputHealth(input: InputHealth): DerivedInputHealth {
    if (!input.connected) return { status: 'off', issues: [] };
    // A failed probe takes precedence over the transient pending state. This
    // also keeps an error visible if a later retry has not begun or completed.
    if (input.mediaOk === false || input.mediaError) {
        return {
            status: 'error',
            issues: [{ severity: 'error', message: inputStatusMessage(input) }],
        };
    }
    // A connected publisher is not fully ready until ffprobe has returned the
    // media details used to validate and display its encoding.
    if (input.mediaOk === null) {
        return {
            status: 'warn',
            issues: [{ severity: 'warning', message: inputStatusMessage(input) }],
        };
    }
    if (!input.live) {
        return {
            status: 'warn',
            issues: [{ severity: 'warning', message: inputStatusMessage(input) }],
        };
    }

    const issues: OverviewIssue[] = [];
    if (
        inputBitrateStatsReady(input) &&
        input.recvBitrateKbps !== null &&
        input.recvBitrateKbps < LOW_BITRATE_KBPS
    ) {
        issues.push({
            severity: 'warning',
            message: `Input bitrate is below ${LOW_BITRATE_KBPS} kb/s.`,
        });
    }
    // Only report missing audio after ffprobe has confirmed usable media;
    // otherwise every new input briefly appears unhealthy during startup.
    if (input.audioTracks.length === 0 && input.audio === null) {
        issues.push({ severity: 'warning', message: 'No audio track detected in input.' });
    }
    return { status: issues.length > 0 ? 'warn' : 'good', issues };
}

function inputStatus(input: InputHealth): InputStatus {
    return inputHealth(input).status;
}

function inputStatusColor(input: InputHealth): string {
    const st = inputStatus(input);
    if (st === 'good') return STATUS_COLOR_GOOD;
    if (st === 'warn') return STATUS_COLOR_WARN;
    if (st === 'error') return STATUS_COLOR_ERROR;
    return STATUS_COLOR_OFF;
}

function overviewStatusBadge(st: InputStatus | OutStatus): string {
    if (st === 'error') return '<span class="badge badge-sm badge-error">ERROR</span>';
    if (st === 'warn') return '<span class="badge badge-sm badge-warning">WARNING</span>';
    if (st === 'off') return '<span class="font-mono text-xs opacity-40">—</span>';
    return '<span class="badge badge-sm badge-success">OK</span>';
}

function issueLinesHtml(issues: OverviewIssue[]): string {
    return issues
        .map((issue) => {
            const cls = issue.severity === 'error' ? 'text-error' : 'text-warning';
            return `<div class="${cls} text-xs leading-snug">${escapeHtml(issue.message)}</div>`;
        })
        .join('');
}

function renderOverviewIssues(issues: OverviewIssue[]): string {
    if (issues.length === 0) return '<span class="opacity-40">—</span>';
    return issueLinesHtml(issues);
}

// Content for a `.js-tooltip-content` popup: one colored line per issue (error/warning),
// or a single muted line when there's nothing wrong but a status is still worth explaining.
function renderIssueTooltip(issues: OverviewIssue[], offMessage?: string | null): string {
    if (issues.length > 0) return issueLinesHtml(issues);
    if (offMessage) {
        return `<div class="text-xs leading-snug opacity-70">${escapeHtml(offMessage)}</div>`;
    }
    return '';
}

function inputIssues(input: InputHealth): OverviewIssue[] {
    return inputHealth(input).issues;
}

function summarizeOutputError(error: string | null | undefined, fallback: string): string {
    if (!error) return fallback;

    const lastLine =
        error
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .pop() ?? '';
    if (!lastLine) return fallback;

    const singleLine = lastLine.replace(/\s+/g, ' ');
    return singleLine.length > 160 ? `${singleLine.slice(0, 157)}...` : singleLine;
}

function relayIssues(
    pipeline: PipelineView,
    relayProcessRunning: boolean,
    inputSt: RelayFlowStatus,
    outputSt: RelayFlowStatus,
): OverviewIssue[] {
    const issues: OverviewIssue[] = [];
    for (const alert of pipeline.alerts) {
        // The leg-specific version below includes the address and the precise
        // reason, so avoid showing per-leg alerts twice in the combined list.
        if (alert.code === 'bonded-leg-no-flow' || alert.code === 'bonded-leg-quality') {
            continue;
        }
        issues.push({ severity: alert.severity, message: alert.message });
    }
    const inputSeverity = inputSt === 'error' ? 'error' : 'warning';
    const outputSeverity = outputSt === 'error' ? 'error' : 'warning';

    if (inputSt === 'warn' || inputSt === 'error') {
        for (const reason of relayInputReasons(pipeline, relayProcessRunning)) {
            issues.push({ severity: inputSeverity, message: `Input: ${reason}` });
        }
    }
    if (outputSt === 'warn' || outputSt === 'error') {
        for (const reason of relayOutputReasons(pipeline, relayProcessRunning)) {
            issues.push({
                severity: outputSeverity,
                message: `Output: ${summarizeOutputError(reason, reason)}`,
            });
        }
    }

    return issues;
}

function outputIssues(o: OutputView, input: InputHealth): OverviewIssue[] {
    return outputHealth(o, input).issues;
}

function selectedAudioTrack(
    tracks: AudioTrackInfo[],
    audioEncoding: string | null | undefined,
): AudioTrackInfo | null {
    if (tracks.length === 0) return null;
    if (!audioEncoding || audioEncoding === 'copy') return tracks[0];

    const firstTrack = audioEncoding
        .split(',')
        .map((part) => Number(part.trim()))
        .find((idx) => Number.isInteger(idx) && idx >= 0);
    return firstTrack == null ? tracks[0] : (tracks[firstTrack] ?? null);
}

function rotatedScaleResolution(
    video: VideoInfo | null,
    scaleWidth: number,
): { width: number; height: number } | null {
    if (!video?.width || !video.height) return null;
    const scaledHeight = Math.max(2, Math.round((video.height * scaleWidth) / video.width / 2) * 2);
    return { width: scaledHeight, height: scaleWidth };
}

function inputResolution(video: VideoInfo | null): OutputVideoResolution | null {
    return video ? { width: video.width, height: video.height } : null;
}

function resolveOutputVideoValue<T>(
    value: OutputVideoValue<T> | undefined,
    copyValue: T | null,
    ctx: OutputVideoContext,
): T | null {
    if (value === undefined) return null;
    if (value === 'copy') return copyValue;
    if (typeof value === 'function') return (value as (ctx: OutputVideoContext) => T | null)(ctx);
    return value;
}

function deriveOutputMedia(
    input: InputHealth,
    output: OutputView,
): {
    video: Pick<
        VideoInfo,
        'codec' | 'width' | 'height' | 'fps' | 'fieldOrder' | 'profile' | 'level'
    > | null;
    audio: Pick<AudioInfo, 'codec' | 'profile' | 'channel' | 'sample_rate'> | null;
} {
    const preset = OUTPUT_VIDEO_PRESETS[output.videoEncoding] ?? OUTPUT_VIDEO_PRESETS.copy;
    const ctx = { input, output };
    const codec = resolveOutputVideoValue(preset.codec, input.video?.codec ?? null, ctx);
    const resolution = resolveOutputVideoValue(
        preset.resolution ?? 'copy',
        inputResolution(input.video),
        ctx,
    );
    const fps = resolveOutputVideoValue(preset.fps ?? 'copy', input.video?.fps ?? null, ctx);
    const fieldOrder = resolveOutputVideoValue(
        preset.fieldOrder ?? 'copy',
        input.video?.fieldOrder ?? null,
        ctx,
    );
    const copiesInputVideo = output.videoEncoding === 'copy';
    const video = codec
        ? {
              codec,
              width: resolution?.width ?? 0,
              height: resolution?.height ?? 0,
              fps,
              fieldOrder,
              profile: copiesInputVideo ? (input.video?.profile ?? '') : '',
              level: copiesInputVideo ? (input.video?.level ?? '') : '',
          }
        : null;

    if (!output.url) return { video, audio: null };

    if (!output.url.startsWith('srt://')) {
        return {
            video,
            audio: {
                codec: 'aac',
                profile: 'LC',
                channel: 2,
                sample_rate: 48000,
            },
        };
    }

    const track = selectedAudioTrack(input.audioTracks, output.audioEncoding);
    if (track) {
        return {
            video,
            audio: {
                codec: track.codec,
                profile: track.profile,
                channel: track.channels,
                sample_rate: track.sampleRate,
            },
        };
    }

    return { video, audio: input.audio };
}

function brokenLegCount(pipeline: PipelineView): number {
    return pipeline.srtBonding.input.legs.filter((leg) => leg.state === 'broken').length;
}

// True only when every configured leg is down — a total input failure, not
// just reduced redundancy. Callers treat this as the 'error' floor for the
// input side; anything less (some legs down, or only one leg configured to
// begin with) is a 'warn', not an 'error'.
function allLegsBroken(pipeline: PipelineView): boolean {
    const legs = pipeline.srtBonding.input.legs;
    return legs.length > 0 && brokenLegCount(pipeline) === legs.length;
}

function flowStatusColor(status: RelayFlowStatus): string {
    if (status === 'good') return STATUS_COLOR_GOOD;
    if (status === 'warn') return STATUS_COLOR_WARN;
    if (status === 'error') return STATUS_COLOR_ERROR;
    return STATUS_COLOR_OFF;
}

// Every independent problem on the input (upstream encoder → relay) side,
// collected rather than short-circuited on the first match — a leg outage and
// a stalled feed are unrelated causes and both deserve to show up in the
// tooltip instead of one hiding the other.
function relayInputReasons(pipeline: PipelineView, relayProcessRunning: boolean): string[] {
    if (!relayProcessRunning || !pipeline.srtBonding.inputActive) return [];
    const legs = pipeline.srtBonding.input.legs;
    const broken = brokenLegCount(pipeline);
    const reasons: string[] = [];

    for (const leg of legs) {
        if (leg.health && leg.health !== 'ok' && leg.healthReason) {
            reasons.push(`Leg ${leg.ip}: ${leg.healthReason}`);
        }
    }

    if (legs.length > 0 && broken === legs.length) {
        reasons.push(`All ${legs.length} bonded leg${legs.length === 1 ? '' : 's'} are down`);
    } else if (broken > 0) {
        reasons.push(`${broken}/${legs.length} legs down`);
    } else if (legs.length === 0) {
        reasons.push('No bonded legs reporting');
    } else if (legs.length === 1) {
        reasons.push('Only 1 leg connected — no redundancy');
    }

    if (!relayHasRecentInputFlow(pipeline)) {
        reasons.push('No input packets received recently');
    }

    return reasons;
}

// Same collect-don't-shortcircuit approach for the output (relay → SRS) side.
function relayOutputReasons(pipeline: PipelineView, relayProcessRunning: boolean): string[] {
    if (!relayProcessRunning || !pipeline.srtBonding.inputActive) return [];
    const { srtBonding } = pipeline;
    const reasons: string[] = [];

    if (srtBonding.publishConflict) {
        reasons.push(
            srtBonding.localSrtPublisherConflict
                ? 'A local pipeline output is already publishing to this stream key in SRS'
                : 'SRS is already using another publisher for this stream key',
        );
    }

    if (!srtBonding.outputConnected) {
        reasons.push(
            srtBonding.lastError
                ? `Relay output reconnecting: ${srtBonding.lastError}`
                : srtBonding.retryFailures > 0
                  ? `Relay output reconnecting (${srtBonding.retryFailures} retries)`
                  : 'Relay output reconnecting',
        );
    } else {
        if (!srtBonding.acceptedBySrs) {
            reasons.push('SRS has not reported this as the active pipeline input');
        }
        if (!relayHasRecentOutputFlow(pipeline)) {
            reasons.push(
                srtBonding.forwardedPackets > 0
                    ? 'Media forwarding to SRS has stalled'
                    : 'No media has been forwarded to SRS yet',
            );
        }
    }

    return reasons;
}

function getBondingIndicator(
    pipeline: PipelineView,
    relayProcessRunning: boolean,
): BondingIndicator {
    if (!relayProcessRunning) {
        return {
            leftColor: STATUS_COLOR_OFF,
            rightColor: STATUS_COLOR_OFF,
            issues: [],
            offMessage: 'SRT bonding relay is not running; bonded input unavailable',
        };
    }

    if (!pipeline.srtBonding.inputActive) {
        return {
            leftColor: STATUS_COLOR_OFF,
            rightColor: STATUS_COLOR_OFF,
            issues: [],
            offMessage: 'No bonded SRT input for this stream key',
        };
    }

    const inputSt = relayInputStatus(pipeline, relayProcessRunning);
    const outputSt = relayOutputStatus(pipeline, relayProcessRunning);
    const issues = relayIssues(pipeline, relayProcessRunning, inputSt, outputSt);

    return {
        leftColor: flowStatusColor(inputSt),
        rightColor: flowStatusColor(outputSt),
        issues,
        offMessage:
            issues.length > 0
                ? null
                : 'Bonded SRT input active and forwarding to downstream output',
    };
}

// Anchored to the health snapshot's own generatedAt (server clock) rather than
// the browser's Date.now(). Comparing a server-issued timestamp against the
// client's wall clock makes staleness detection sensitive to client/server
// clock skew — a client clock running fast enough looks permanently "stalled"
// even when the relay is flowing normally.
function healthNowMs(): number {
    const generatedAt = state.health.generatedAt;
    const parsed = generatedAt ? new Date(generatedAt).getTime() : NaN;
    return Number.isFinite(parsed) ? parsed : Date.now();
}

function relayHasRecentInputFlow(pipeline: PipelineView): boolean {
    return (
        pipeline.srtBonding.lastInputPacketAt != null &&
        healthNowMs() - pipeline.srtBonding.lastInputPacketAt <= RELAY_FLOW_STALE_MS
    );
}

function relayHasRecentOutputFlow(pipeline: PipelineView): boolean {
    return (
        pipeline.srtBonding.lastPacketAt != null &&
        healthNowMs() - pipeline.srtBonding.lastPacketAt <= RELAY_FLOW_STALE_MS
    );
}

function relayInputStatus(pipeline: PipelineView, relayProcessRunning: boolean): RelayFlowStatus {
    if (!relayProcessRunning) return 'off';
    if (!pipeline.srtBonding.inputActive) return 'off';
    if (pipeline.srtBonding.input.legs.some((leg) => leg.health === 'error')) return 'error';
    if (pipeline.srtBonding.input.legs.some((leg) => leg.health === 'warn')) return 'warn';
    // A single connected leg has no failover if it drops — that's a warning
    // floor even when everything else about it looks healthy. A total outage
    // (every configured leg broken) is worse than reduced redundancy, so it
    // escalates past that floor to 'error'.
    if (allLegsBroken(pipeline)) return 'error';
    if (!relayHasRecentInputFlow(pipeline)) return 'warn';
    if (brokenLegCount(pipeline) > 0) return 'warn';
    if (pipeline.srtBonding.input.legs.length <= 1) return 'warn';
    return 'good';
}

function relayOutputStatus(pipeline: PipelineView, relayProcessRunning: boolean): RelayFlowStatus {
    if (!relayProcessRunning) return 'off';
    if (!pipeline.srtBonding.inputActive) return 'off';
    if (pipeline.srtBonding.publishConflict) return 'error';
    if (!pipeline.srtBonding.outputConnected) return 'error';
    if (!pipeline.srtBonding.acceptedBySrs) return 'warn';
    return relayHasRecentOutputFlow(pipeline) ? 'good' : 'warn';
}

function legHealthColor(leg: SrtBondingLeg): string {
    if (leg.health === 'error') return STATUS_COLOR_ERROR;
    if (leg.health === 'warn') return STATUS_COLOR_WARN;
    return STATUS_COLOR_GOOD;
}

function legHealthLabel(leg: SrtBondingLeg): string {
    return (leg.health ?? (leg.state === 'running' ? 'ok' : 'warn')).toUpperCase();
}

function relayInputSeverityColor(
    pipeline: PipelineView,
    relayProcessRunning: boolean,
    inputColor: string,
): string {
    if (inputStatus(pipeline.input) !== 'good') return inputColor;

    const relayInput = relayInputStatus(pipeline, relayProcessRunning);
    const relayOutput = relayOutputStatus(pipeline, relayProcessRunning);
    if (relayInput === 'error' || relayOutput === 'error') return STATUS_COLOR_ERROR;
    if (relayInput === 'warn' || relayOutput === 'warn') return STATUS_COLOR_WARN;
    return inputColor;
}

// ── Pipeline list (left column) ───────────────────────

export function formatUptime(ms: number | null): string {
    if (ms === null) return '—';
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

function inputStatusMessage(input: InputHealth): string {
    if (input.mediaError) return input.mediaError;
    if (input.mediaOk === null)
        return 'Waiting for ffprobe to finish and return the input encoding.';
    return 'Input connected, waiting for valid media.';
}

function renderCompactMetaRow(
    items: Array<{
        label: string;
        labelTitle?: string;
        value: string | number | null | undefined;
    }>,
    className = '',
): string {
    return `<div class="input-meta-row ${className}">${items
        .map(
            (item) =>
                `<span class="input-meta-item"><span class="input-meta-label"${
                    item.labelTitle ? ` title="${item.labelTitle.replace(/"/g, '&quot;')}"` : ''
                }>${item.label}</span><span class="input-meta-value">${item.value ?? '—'}</span></span>`,
        )
        .join('')}</div>`;
}

const CHART_WINDOW_MS = 15 * 60 * 1000;
const CHART_SCROLL_STEP_MS = 10 * 60 * 1000;

function roundUpNice(v: number): number {
    if (v <= 0) return 1;
    const exp = Math.pow(10, Math.floor(Math.log10(v)));
    const f = v / exp;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * exp;
}

function formatChartTimeTick(ts: number): string {
    const d = new Date(ts);
    const minutes = d.getMinutes();
    const mm = minutes.toString().padStart(2, '0');
    if (minutes % 10 !== 0) return mm;
    return `${d.getHours().toString().padStart(2, '0')}:${mm}`;
}

function drawChart(
    id: string,
    samples: MetricSample[],
    extract: (s: MetricSample) => number,
    maxHint: number,
    color: string,
    fmtY: (v: number) => string,
): void {
    const canvas = document.getElementById(id) as HTMLCanvasElement | null;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const displayW = canvas.clientWidth || 500;
    const displayH = canvas.clientHeight || 160;
    canvas.width = displayW * dpr;
    canvas.height = displayH * dpr;
    ctx.scale(dpr, dpr);

    const W = displayW;
    const H = displayH;
    const mL = 50;
    const mR = 8;
    const mT = 6;
    const mB = 22;
    const cW = W - mL - mR;
    const cH = H - mT - mB;

    ctx.clearRect(0, 0, W, H);

    // Theme-aware colours derived from the canvas's computed text colour
    const base = getComputedStyle(canvas).color;
    const toRgba = (c: string, a: number) =>
        c.startsWith('rgb(')
            ? c.replace('rgb(', 'rgba(').replace(')', `, ${a})`)
            : `rgba(128,128,128,${a})`;
    const gridColor = toRgba(base, 0.35);
    const labelColor = toRgba(base, 0.9);

    ctx.font = '10px ui-monospace, monospace';

    const values = samples.length >= 2 ? samples.map(extract) : [];
    const rawMax = values.length ? Math.max(maxHint, ...values, 0.001) : maxHint || 1;
    const peak = roundUpNice(rawMax);

    const cx = (i: number) => mL + (i / Math.max(samples.length - 1, 1)) * cW;
    const cy = (v: number) => mT + cH - (v / peak) * cH;

    // Y axis — 4 equal ticks
    for (let i = 0; i <= 4; i++) {
        const v = (peak / 4) * i;
        const y = cy(v);
        ctx.beginPath();
        ctx.setLineDash([3, 4]);
        ctx.moveTo(mL, y);
        ctx.lineTo(W - mR, y);
        ctx.strokeStyle = gridColor;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = labelColor;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(fmtY(v), mL - 5, y);
    }

    if (values.length < 2) return;

    // X axis — labels at round-minute boundaries
    const firstTs = samples[0].ts;
    const lastTs = samples[samples.length - 1].ts;
    const spanMs = lastTs - firstTs;
    const spanMin = spanMs / 60_000;
    const stepMin = spanMin <= 30 ? 1 : 5;
    const stepMs = stepMin * 60_000;
    const firstLabel = Math.ceil(firstTs / stepMs) * stepMs;

    for (let ts = firstLabel; ts <= lastTs + 1; ts += stepMs) {
        const frac = (ts - firstTs) / spanMs;
        if (frac < 0 || frac > 1) continue;
        const x = mL + frac * cW;
        ctx.beginPath();
        ctx.setLineDash([3, 4]);
        ctx.moveTo(x, mT);
        ctx.lineTo(x, H - mB);
        ctx.strokeStyle = gridColor;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = labelColor;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(formatChartTimeTick(ts), x, H - mB + 5);
    }

    // Fill under curve
    ctx.beginPath();
    ctx.moveTo(cx(0), cy(values[0]));
    for (let i = 1; i < values.length; i++) ctx.lineTo(cx(i), cy(values[i]));
    ctx.lineTo(cx(values.length - 1), H - mB);
    ctx.lineTo(cx(0), H - mB);
    ctx.closePath();
    ctx.fillStyle = color + '28';
    ctx.fill();

    // Line
    ctx.beginPath();
    ctx.moveTo(cx(0), cy(values[0]));
    for (let i = 1; i < values.length; i++) ctx.lineTo(cx(i), cy(values[i]));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();
}

function chartCard(id: string, label: string, currentVal: string): string {
    return `<div class="bg-base-300 rounded-xl p-3">
        <div class="mb-2 flex items-center justify-between">
            <span class="text-xs font-semibold opacity-60">${label}</span>
            <span class="font-mono text-xs">${currentVal}</span>
        </div>
        <canvas id="${id}" style="width:100%;height:160px;display:block"></canvas>
    </div>`;
}

export function renderOverviewMarkup(): string {
    const fmtHz = (hz: number | null | undefined): string => {
        if (!hz) return '—';
        const k = hz / 1000;
        return `${Number.isInteger(k) ? k : k.toFixed(1)}kHz`;
    };

    const td = (val: string | number | null | undefined): string =>
        `<td class="font-mono text-xs">${val ?? '—'}</td>`;

    // Compact scan+fps shorthand, e.g. "p30", "i60tff" (top-field-first), "i25bff" (bottom-field-first).
    const fmtScanFps = (
        fieldOrder: string | null | undefined,
        fps: number | null | undefined,
    ): string => {
        const fpsNum = fps != null ? Math.round(fps) : null;
        if (fieldOrder === 'progressive') return fpsNum != null ? `p${fpsNum}` : 'p';
        if (
            fieldOrder === 'tt' ||
            fieldOrder === 'tb' ||
            fieldOrder === 'bb' ||
            fieldOrder === 'bt'
        ) {
            const field = fieldOrder === 'tt' || fieldOrder === 'tb' ? 'tff' : 'bff';
            return fpsNum != null ? `i${fpsNum}${field}` : `i${field}`;
        }
        return fpsNum != null ? `${fpsNum}fps` : '';
    };

    const videoSpec = (
        video: Pick<
            VideoInfo,
            'codec' | 'width' | 'height' | 'fps' | 'fieldOrder' | 'profile' | 'level'
        > | null,
    ): string | null => {
        if (!video?.width || !video.height) return null;
        const scanFps = fmtScanFps(video.fieldOrder, video.fps);
        const res = scanFps
            ? /^\d/.test(scanFps)
                ? `${video.width}x${video.height} ${scanFps}`
                : `${video.width}x${video.height}${scanFps}`
            : `${video.width}x${video.height}`;
        return [video.codec || '—', res, video.profile || null, video.level || null]
            .filter(Boolean)
            .join(' ');
    };

    const audioSpec = (
        codec: string | null | undefined,
        profile: string | null | undefined,
        channels: number | null | undefined,
        sampleRate: number | null | undefined,
        label?: string,
    ): string => {
        const codecLabel = [codec || '—', codec ? profile || null : null].filter(Boolean).join(' ');
        const sr = sampleRate ? fmtHz(sampleRate) : null;
        return `${codecLabel} ${channels ? `${channels}ch` : '—'}${sr ? ` ${sr}` : ''}${label ? ` <span class="opacity-40">${label}</span>` : ''}`;
    };

    // One "Stream specification" cell replaces the separate V.Codec/Resolution/FPS/Scan/
    // A.Codec/Ch/Sample Rate columns (protocol has its own Type column). Multiple audio
    // tracks stack as extra lines within the same cell instead of extra table rows.
    const streamSpec = (
        video: Pick<
            VideoInfo,
            'codec' | 'width' | 'height' | 'fps' | 'fieldOrder' | 'profile' | 'level'
        > | null,
        audioTracks: AudioTrackInfo[] | null,
        fallbackAudio: Pick<AudioInfo, 'codec' | 'channel' | 'sample_rate' | 'profile'> | null,
    ): string => {
        const vSpec = videoSpec(video);
        const audioLines =
            audioTracks && audioTracks.length > 0
                ? audioTracks.map((t, i) => {
                      const label = escapeHtml([t.language, t.title].filter(Boolean).join(' '));
                      const prefix = `Track ${i + 1}: `;
                      return `${prefix}${audioSpec(t.codec, t.profile, t.channels, t.sampleRate, label || undefined)}`;
                  })
                : fallbackAudio
                  ? [
                        `Track 1: ${audioSpec(
                            fallbackAudio.codec,
                            fallbackAudio.profile,
                            fallbackAudio.channel,
                            fallbackAudio.sample_rate,
                        )}`,
                    ]
                  : [];
        if (!vSpec && audioLines.length === 0) return '—';
        if (audioLines.length === 0) return vSpec || '—';
        return [vSpec, ...audioLines].filter(Boolean).join('<br>');
    };

    const typeBadge = (protocol: string | null): string =>
        protocol ? `<span class="badge badge-sm badge-outline">${protocol}</span>` : '—';

    const statusBg = (error: boolean, warn: boolean): string =>
        error
            ? 'style="background:color-mix(in oklch, var(--color-error) 15%, transparent)"'
            : warn
              ? 'style="background:color-mix(in oklch, var(--color-warning) 15%, transparent)"'
              : '';

    const totalOuts = state.pipelines.reduce((s, p) => s + p.outs.length, 0);
    const relayProcessRunning = state.health.srtRelay?.status === 'running';
    const activeOnly = state.overviewFilter === 'active';
    const problemsOnly = state.overviewFilter === 'problems';
    const isProblem = (st: string): boolean => st === 'warn' || st === 'error';
    const isOffline = (st: string): boolean => st === 'off';

    // ── SRT Bonding Relay ───────────────────────────────
    const activeRelayPipelines = state.pipelines.filter(
        (p) =>
            p.srtBonding.inputActive ||
            p.srtBonding.outputConnected ||
            p.srtBonding.forwardedPackets > 0 ||
            (p.srtBonding.input.recvPacketsTotal ?? 0) > 0 ||
            p.srtBonding.input.recvUniquePacketsTotal > 0 ||
            (p.srtBonding.input.retransTotal ?? 0) > 0 ||
            (p.srtBonding.input.recvLossTotal ?? 0) > 0 ||
            (p.srtBonding.input.recvDropTotal ?? 0) > 0,
    );
    const relayProblemCount = activeRelayPipelines.filter(
        (p) =>
            isProblem(relayInputStatus(p, relayProcessRunning)) ||
            isProblem(relayOutputStatus(p, relayProcessRunning)),
    ).length;
    const relayActiveCount = activeRelayPipelines.filter(
        (p) =>
            !isOffline(relayInputStatus(p, relayProcessRunning)) ||
            !isOffline(relayOutputStatus(p, relayProcessRunning)),
    ).length;
    const legCells = (leg: SrtBondingLeg | null): string => {
        if (!leg) return `${td(null)}${td(null)}${td(null)}${td(null)}${td(null)}${td(null)}`;
        const color = legHealthColor(leg);
        const health = legHealthLabel(leg);
        const title = leg.healthReason ?? `Transport state: ${leg.state}`;
        return `
            <td title="${escapeHtml(title)}"><span class="inline-flex items-center gap-1"><span class="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style="background:${color}"></span>${health}<span class="opacity-60">(${escapeHtml(leg.state)})</span></span></td>
            <td class="font-mono text-xs">${escapeHtml(leg.ip)}</td>
            <td class="font-mono text-xs">${fmtMs(leg.latencyMs)}</td>
            <td class="font-mono text-xs">${fmtMs(leg.rttMs)}</td>
            <td class="font-mono text-xs">${fmtMbpsValue(leg.recvRateMbps)}</td>
            <td class="font-mono text-xs" title="Loss / Rexmit / Drop">${fmtLossRexmitDrop(leg.recvLossTotal, leg.retransTotal, leg.recvDropTotal)}</td>`;
    };

    let relayRows = '';
    if (activeRelayPipelines.length === 0) {
        relayRows = `<tr><td colspan="12" class="py-4 text-center opacity-50">No active SRT bonding relay sessions.</td></tr>`;
    } else {
        for (const p of activeRelayPipelines) {
            const inputSt = relayInputStatus(p, relayProcessRunning);
            const outputSt = relayOutputStatus(p, relayProcessRunning);
            const rowWarn = inputSt === 'warn' || outputSt === 'warn';
            const rowError = inputSt === 'error' || outputSt === 'error';
            if (problemsOnly && !rowWarn && !rowError) continue;
            if (activeOnly && isOffline(inputSt) && isOffline(outputSt)) continue;

            const legs = p.srtBonding.input.legs;
            const rowspan = legs.length > 1 ? ` rowspan="${legs.length}"` : '';
            const rowAttr = `class="hover" ${statusBg(rowError, rowWarn)}`;
            const aggregateStatsAreDropOnly = inputAggregateStatsAreDropOnly(p.srtBonding.input);
            const sharedCells = `
                <td class="font-semibold cursor-pointer hover:underline js-select-pipeline" data-id="${p.id}"${rowspan}>${escapeHtml(p.name)}</td>
                <td${rowspan}>${overviewStatusBadge(inputSt)}</td>
                <td${rowspan}>${overviewStatusBadge(outputSt)}</td>
                <td${rowspan}>${renderOverviewIssues(relayIssues(p, relayProcessRunning, inputSt, outputSt))}</td>
                <td class="font-mono text-xs"${rowspan}>${p.input.live ? formatUptime(p.input.uptimeMs) : '—'}</td>`;
            const totalsCells = `
                <td class="font-mono text-xs" title="${aggregateStatsAreDropOnly ? 'Deduplicated drop packets on the bonded group input.' : 'Loss / Rexmit / Drop on the input connection.'}"${rowspan}>${aggregateStatsAreDropOnly ? fmtCompactNullableCount(p.srtBonding.input.recvDropTotal) : fmtLossRexmitDrop(p.srtBonding.input.recvLossTotal, p.srtBonding.input.retransTotal, p.srtBonding.input.recvDropTotal)}</td>`;

            if (legs.length > 1) {
                relayRows += legs
                    .map(
                        (leg, i) =>
                            `<tr ${rowAttr}>${i === 0 ? sharedCells : ''}${i === 0 ? totalsCells : ''}${legCells(leg)}</tr>`,
                    )
                    .join('');
            } else {
                relayRows += `<tr ${rowAttr}>${sharedCells}${totalsCells}${legCells(legs[0] ?? null)}</tr>`;
            }
        }
        if (problemsOnly && relayRows === '') {
            relayRows = `<tr><td colspan="12" class="py-4 text-center opacity-50">No relay issues.</td></tr>`;
        } else if (activeOnly && relayRows === '') {
            relayRows = `<tr><td colspan="12" class="py-4 text-center opacity-50">No active relay sessions.</td></tr>`;
        }
    }

    // ── Inputs ────────────────────────────────────────────
    const inputProblemCount = state.pipelines.filter((p) => isProblem(inputStatus(p.input))).length;
    const inputActiveCount = state.pipelines.filter((p) => !isOffline(inputStatus(p.input))).length;
    let inputRows = '';
    if (state.pipelines.length === 0) {
        inputRows = `<tr><td colspan="7" class="py-4 text-center opacity-50">No pipelines yet.</td></tr>`;
    } else {
        for (const p of state.pipelines) {
            const inp = p.input;
            const st = inputStatus(inp);
            const isWarn = st === 'warn';
            const isError = st === 'error';
            if (problemsOnly && !isWarn && !isError) continue;
            if (activeOnly && isOffline(st)) continue;
            const protocolLabel = inp.connected
                ? p.srtBonding.acceptedBySrs
                    ? 'Relay'
                    : inp.isSrt
                      ? 'SRT'
                      : 'RTMP'
                : null;
            const audioTracks = inp.audioTracks.length > 0 ? inp.audioTracks : null;
            const spec = streamSpec(inp.video, audioTracks, inp.audio);
            inputRows += `<tr class="hover" ${statusBg(isError, isWarn)}>
                <td class="overview-name-col font-semibold cursor-pointer hover:underline js-select-pipeline" data-id="${p.id}">${escapeHtml(p.name)}</td>
                <td>${overviewStatusBadge(st)}</td>
                <td>${renderOverviewIssues(inputIssues(inp))}</td>
                <td class="font-mono text-xs">${inp.live ? formatUptime(inp.uptimeMs) : '—'}</td>
                <td class="font-mono text-xs">${inp.connected ? formatBitrate(displayInputBitrateKbps(inp)) : '—'}</td>
                <td>${typeBadge(protocolLabel)}</td>
                <td class="font-mono text-xs">${spec}</td>
            </tr>`;
        }
        if (problemsOnly && inputRows === '') {
            inputRows = `<tr><td colspan="7" class="py-4 text-center opacity-50">No input issues.</td></tr>`;
        } else if (activeOnly && inputRows === '') {
            inputRows = `<tr><td colspan="7" class="py-4 text-center opacity-50">No active inputs.</td></tr>`;
        }
    }

    // ── Outputs ───────────────────────────────────────────
    const outputProblemCount = state.pipelines.reduce(
        (s, p) => s + p.outs.filter((o) => isProblem(outStatus(o, p.input))).length,
        0,
    );
    const outputActiveCount = state.pipelines.reduce(
        (s, p) => s + p.outs.filter((o) => !isOffline(outStatus(o, p.input))).length,
        0,
    );
    let outputRows = '';
    if (totalOuts === 0) {
        outputRows = `<tr><td colspan="9" class="py-4 text-center opacity-50">No outputs yet.</td></tr>`;
    } else {
        for (const p of state.pipelines) {
            for (const o of p.outs) {
                const st = outStatus(o, p.input);
                if (problemsOnly && !isProblem(st)) continue;
                if (activeOnly && isOffline(st)) continue;
                const badge = overviewStatusBadge(st);

                const isOn = o.status === 'running';
                const media = isOn ? deriveOutputMedia(p.input, o) : null;
                const outUptimeMs = o.startedAtMs !== null ? Date.now() - o.startedAtMs : null;
                const errorBadge =
                    o.failures > 0
                        ? `<span class="text-error inline-flex items-center align-middle" title="${o.failures} error${o.failures === 1 ? '' : 's'} since this output was last started">${ICON_ERROR}</span>`
                        : '';
                const protocolLabel = o.url ? (o.url.startsWith('srt://') ? 'SRT' : 'RTMP') : null;
                const spec = streamSpec(media?.video ?? null, null, media?.audio ?? null);
                outputRows += `<tr class="hover" ${statusBg(st === 'error', st === 'warn')}>
                    <td class="overview-name-col cursor-pointer hover:underline js-select-pipeline" data-id="${p.id}"><span class="opacity-40 text-xs">${escapeHtml(p.name)} ·</span> ${escapeHtml(o.name)} ${errorBadge}</td>
                    <td>${badge}</td>
                    <td>${renderOverviewIssues(outputIssues(o, p.input))}</td>
                    <td class="font-mono text-xs">${outUptimeMs !== null ? formatUptime(outUptimeMs) : '—'}</td>
                    ${td(formatBitrate(o.bitrateKbps))}
                    <td class="font-mono text-xs">${o.cpuPercent != null ? `${o.cpuPercent}%` : '—'}</td>
                    <td class="font-mono text-xs ${memorySeverityClass(outputMemoryPercent(o))}">${formatOutputMemory(o) ?? '—'}</td>
                    <td>${typeBadge(protocolLabel)}</td>
                    <td class="font-mono text-xs">${spec}</td>
                </tr>`;
            }
        }
        if (problemsOnly && outputRows === '') {
            outputRows = `<tr><td colspan="9" class="py-4 text-center opacity-50">No output issues.</td></tr>`;
        } else if (activeOnly && outputRows === '') {
            outputRows = `<tr><td colspan="9" class="py-4 text-center opacity-50">No active outputs.</td></tr>`;
        }
    }

    const thead = (cols: string[]) =>
        `<thead><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr></thead>`;

    const offset = state.chartOffsetMs;
    const windowEnd = Date.now() - offset;
    const windowStart = windowEnd - CHART_WINDOW_MS;
    const chartSamples = state.metricsHistory.filter(
        (s) => s.ts >= windowStart && s.ts <= windowEnd,
    );
    const last = chartSamples[chartSamples.length - 1];
    const fmtBps = (bps: number) => formatBitrate((bps * 8) / 1000);

    const oldest = state.metricsHistory[0];
    const maxOffset = oldest ? Math.max(0, Date.now() - oldest.ts - CHART_WINDOW_MS) : 0;
    const atLive = offset === 0;
    const atStart = offset >= maxOffset && maxOffset > 0;

    const fmtTs = (ts: number) => {
        const d = new Date(ts);
        return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
    };
    const rangeLabel = `<span class="inline-flex justify-center w-28">${
        atLive
            ? `<span class="badge badge-success badge-xs gap-1">LIVE</span>`
            : `<span class="font-mono text-xs opacity-60">${fmtTs(windowStart)} – ${fmtTs(windowEnd)}</span>`
    }</span>`;

    const chartsHtml = `
    <div class="mb-2 flex items-center justify-center gap-2 px-1">
        <button id="chart-back" class="btn btn-xs btn-ghost" ${atStart || maxOffset === 0 ? 'disabled' : ''}>&#8592; 10 min</button>
        ${rangeLabel}
        <button id="chart-fwd" class="btn btn-xs btn-ghost" ${atLive ? 'disabled' : ''}>10 min &#8594;</button>
    </div>
    <div class="mb-6 grid grid-cols-2 gap-4">
        ${chartCard('chart-cpu', 'CPU', last ? `${last.cpu}%` : '—')}
        ${chartCard('chart-ram', 'RAM', last ? `${Math.round((last.ramUsed / last.ramTotal) * 100)}%` : '—')}
        ${chartCard('chart-rx', 'Downlink', last ? fmtBps(last.rxBps) : '—')}
        ${chartCard('chart-tx', 'Uplink', last ? fmtBps(last.txBps) : '—')}
    </div>`;

    const m = state.metrics;
    const fmtProcCpu = (percent: number | null | undefined): string => {
        if (percent == null) return '—';
        const r = Math.round(percent);
        // Above 99% (i.e. more than one core's worth), add a space before
        // the last two digits so wide numbers don't crowd the % sign.
        if (r > 99) {
            const s = String(r);
            return `${s.slice(0, -2)} ${s.slice(-2)}%`;
        }
        return `${r}%`;
    };
    const fmtProcRam = (bytes: number | null | undefined): string =>
        bytes != null ? formatBytesCompact(bytes) : '—';
    const isLoopbackHost = (host: string | null | undefined): boolean =>
        host === 'localhost' || host === '127.0.0.1';
    const outputHost = (url: string): string | null => {
        try {
            return new URL(url).hostname;
        } catch {
            return null;
        }
    };

    // Sum of every tracked process's own %CPU (single-core-relative — see
    // ProcCpuTracker) and RSS: node + SRS + relay + every running ffmpeg
    // output. Independent of the Issues/Active row filter below — this is
    // whole-system resource usage, not a count of displayed rows.
    let totalCpuPercent = 0;
    let totalCpuKnown = false;
    let totalRamBytes = 0;
    let totalRamKnown = false;
    let outsCpuPercent = 0;
    let outsCpuKnown = false;
    let outsRamBytes = 0;
    let outsRamKnown = false;
    const addCpu = (v: number | null | undefined): void => {
        if (v != null) {
            totalCpuPercent += v;
            totalCpuKnown = true;
        }
    };
    const addRam = (v: number | null | undefined): void => {
        if (v != null) {
            totalRamBytes += v;
            totalRamKnown = true;
        }
    };
    addCpu(m.node?.cpuPercent);
    addRam(m.node?.ramBytes);
    addCpu(m.srs?.cpuPercent);
    addRam(m.srs?.ramBytes);
    addCpu(m.relay?.cpuPercent);
    addRam(m.relay?.ramBytes);
    // Downlink is what SRS receives directly from publishers (excluding
    // loopback — those are locally fed by the relay or a chained pipeline
    // output) plus what the SRT bonding relay pulls in across its bonded
    // legs. Uplink is what the ffmpeg outputs push out (excluding loopback
    // chaining into another pipeline).
    let srsDownlinkKbps = 0;
    let srsDownlinkKnown = false;
    let relayDownlinkKbps = 0;
    let relayDownlinkKnown = false;
    let outsUplinkKbps = 0;
    let outsUplinkKnown = false;
    for (const p of state.pipelines) {
        if (p.input.recvBitrateKbps != null && !isLoopbackHost(p.input.publisherIp)) {
            srsDownlinkKbps += p.input.recvBitrateKbps;
            srsDownlinkKnown = true;
        }
        for (const o of p.outs) {
            addCpu(o.cpuPercent);
            addRam(o.memoryUsageBytes);
            if (o.cpuPercent != null) {
                outsCpuPercent += o.cpuPercent;
                outsCpuKnown = true;
            }
            if (o.memoryUsageBytes != null) {
                outsRamBytes += o.memoryUsageBytes;
                outsRamKnown = true;
            }
            if (o.bitrateKbps != null && o.url && !isLoopbackHost(outputHost(o.url))) {
                outsUplinkKbps += o.bitrateKbps;
                outsUplinkKnown = true;
            }
        }
    }
    for (const p of activeRelayPipelines) {
        for (const leg of p.srtBonding.input.legs) {
            if (leg.recvRateMbps != null) {
                relayDownlinkKbps += leg.recvRateMbps * 1000;
                relayDownlinkKnown = true;
            }
        }
    }
    const totalDownlinkKbps = srsDownlinkKbps + relayDownlinkKbps;
    const totalDownlinkKnown = srsDownlinkKnown || relayDownlinkKnown;
    const totalUplinkKbps = outsUplinkKbps;
    const totalUplinkKnown = outsUplinkKnown;

    // m.cpu.percent is already normalized across all cores (0–100 = whole
    // machine). Scale it up to the same single-core-relative basis as the
    // per-process percentages above (100% = one core) so App and Total are
    // comparable.
    const sysCpuPercent = m.cpu ? m.cpu.percent * m.cpu.cores : null;
    const sysRamUsedBytes = m.ram?.usedBytes ?? null;
    const sysDownlinkKbps = m.net ? (m.net.rxBytesPerSec * 8) / 1000 : null;
    const sysUplinkKbps = m.net ? (m.net.txBytesPerSec * 8) / 1000 : null;
    const appTotalTitle =
        'App = node + SRS + relay + every running ffmpeg output.\nSystem = whole-system usage.';
    const downlinkTotalTitle =
        'App = SRS direct inputs + SRT bonding relay legs.\nSystem = whole-system downlink.';
    const uplinkTotalTitle = 'App = every running ffmpeg output.\nSystem = whole-system uplink.';
    const flowTotalTitle = `${downlinkTotalTitle}\n\n${uplinkTotalTitle}`;

    const systemUsageHtml = `
    <div class="overflow-x-auto mb-6">
        <table class="table table-sm">
            <thead>
                <tr>
                    <th></th>
                    <th>Node</th>
                    <th>SRS</th>
                    <th>Relay</th>
                    <th>Outs</th>
                    <th>App / System</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td class="text-xs opacity-60">CPU</td>
                    <td class="font-mono text-xs">${fmtProcCpu(m.node?.cpuPercent)}</td>
                    <td class="font-mono text-xs">${fmtProcCpu(m.srs?.cpuPercent)}</td>
                    <td class="font-mono text-xs">${fmtProcCpu(m.relay?.cpuPercent)}</td>
                    <td class="font-mono text-xs">${outsCpuKnown ? fmtProcCpu(outsCpuPercent) : '—'}</td>
                    <td class="font-mono text-xs" title="${appTotalTitle}">${totalCpuKnown ? fmtProcCpu(totalCpuPercent) : '—'} / ${fmtProcCpu(sysCpuPercent)}</td>
                </tr>
                <tr>
                    <td class="text-xs opacity-60">RAM</td>
                    <td class="font-mono text-xs">${fmtProcRam(m.node?.ramBytes)}</td>
                    <td class="font-mono text-xs">${fmtProcRam(m.srs?.ramBytes)}</td>
                    <td class="font-mono text-xs">${fmtProcRam(m.relay?.ramBytes)}</td>
                    <td class="font-mono text-xs">${outsRamKnown ? fmtProcRam(outsRamBytes) : '—'}</td>
                    <td class="font-mono text-xs" title="${appTotalTitle}">${totalRamKnown ? formatBytesCompact(totalRamBytes) : '—'} / ${fmtProcRam(sysRamUsedBytes)}</td>
                </tr>
                <tr>
                    <td class="text-xs opacity-60">Downlink &amp; Uplink</td>
                    <td class="font-mono text-xs">-</td>
                    <td class="font-mono text-xs">↓ ${srsDownlinkKnown ? formatBitrate(srsDownlinkKbps) : '—'}</td>
                    <td class="font-mono text-xs">↓ ${relayDownlinkKnown ? formatBitrate(relayDownlinkKbps) : '—'}</td>
                    <td class="font-mono text-xs">↑ ${outsUplinkKnown ? formatBitrate(outsUplinkKbps) : '—'}</td>
                    <td class="font-mono text-xs" title="${flowTotalTitle}">↓ ${totalDownlinkKnown ? formatBitrate(totalDownlinkKbps) : '—'} / ${formatBitrate(sysDownlinkKbps)} &amp; ↑ ${totalUplinkKnown ? formatBitrate(totalUplinkKbps) : '—'} / ${formatBitrate(sysUplinkKbps)}</td>
                </tr>
            </tbody>
        </table>
    </div>`;

    const totalAll = activeRelayPipelines.length + state.pipelines.length + totalOuts;
    const totalActive = relayActiveCount + inputActiveCount + outputActiveCount;
    const totalProblems = relayProblemCount + inputProblemCount + outputProblemCount;
    const filterChips = `
    <div role="tablist" class="tabs tabs-lift mb-4">
        <a role="tab" id="ov-filter-all" data-overview-filter="all" aria-selected="${state.overviewFilter === 'all'}" class="tab gap-1 ${state.overviewFilter === 'all' ? 'tab-active' : ''}">
            All
            <span class="badge badge-xs badge-ghost">${totalAll}</span>
        </a>
        <a role="tab" id="ov-filter-active" data-overview-filter="active" aria-selected="${activeOnly}" class="tab gap-1 ${activeOnly ? 'tab-active' : ''}">
            Active
            <span class="badge badge-xs badge-ghost">${totalActive}</span>
        </a>
        <a role="tab" id="ov-filter-problems" data-overview-filter="problems" aria-selected="${problemsOnly}" class="tab gap-1 ${problemsOnly ? 'tab-active' : ''}">
            Issues
            <span class="badge badge-xs badge-ghost">${totalProblems}</span>
        </a>
    </div>`;

    return `
        ${chartsHtml}
        ${systemUsageHtml}
        ${filterChips}
        <h2 class="mb-2 text-lg font-bold">SRT Bonding Relay <span class="badge badge-neutral badge-sm ml-1">${activeRelayPipelines.length}</span></h2>
        <div class="overflow-x-auto mb-6">
            <table class="table table-sm table-relay">
                ${thead(['Pipeline', 'Input', 'Output', 'Issues', 'Uptime', '<span title="Bonded group inputs show deduplicated Drop; non-bonded inputs show Loss / Rexmit / Drop">Input stats</span>', 'State', 'Leg IP', 'Latency', 'RTT', 'Rate', '<span title="Loss / Rexmit / Drop">L / R / D</span>'])}
                <tbody>${relayRows}</tbody>
            </table>
        </div>
        <h2 class="mb-2 text-lg font-bold">Inputs <span class="badge badge-neutral badge-sm ml-1">${state.pipelines.length}</span></h2>
        <div class="overflow-x-auto mb-6">
            <table class="table table-sm">
                ${thead(['Pipeline', 'Status', 'Issues', 'Uptime', 'Bitrate', 'Type', 'Stream Specification'])}
                <tbody>${inputRows}</tbody>
            </table>
        </div>
        <h2 class="mb-2 text-lg font-bold">Outputs <span class="badge badge-neutral badge-sm ml-1">${totalOuts}</span></h2>
        <div class="overflow-x-auto">
            <table class="table table-sm">
                ${thead(['Pipeline · Output', 'Status', 'Issues', 'Uptime', 'Bitrate', 'CPU', 'RAM', 'Type', 'Stream Specification'])}
                <tbody>${outputRows}</tbody>
            </table>
        </div>`;
}

export function drawOverviewCharts(): void {
    const offset = state.chartOffsetMs;
    const windowEnd = Date.now() - offset;
    const windowStart = windowEnd - CHART_WINDOW_MS;
    const samples = state.metricsHistory.filter(
        (sample) => sample.ts >= windowStart && sample.ts <= windowEnd,
    );
    const fmtPct = (value: number): string => `${Math.round(value)}%`;
    const fmtMb = (value: number): string => `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}`;
    drawChart('chart-cpu', samples, (sample) => sample.cpu, 100, '#3b82f6', fmtPct);
    drawChart(
        'chart-ram',
        samples,
        (sample) => (sample.ramUsed / sample.ramTotal) * 100,
        100,
        '#a855f7',
        fmtPct,
    );
    drawChart('chart-rx', samples, (sample) => (sample.rxBps * 8) / 1_000_000, 0, '#22c55e', fmtMb);
    drawChart('chart-tx', samples, (sample) => (sample.txBps * 8) / 1_000_000, 0, '#f97316', fmtMb);
}

function drawProbeChart(
    id: string,
    samples: Array<{ ts: number; ok: boolean; latencyMs: number | null }>,
    windowStart: number,
    windowEnd: number,
    intervalMs: number,
): void {
    const canvas = document.getElementById(id) as HTMLCanvasElement | null;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const displayW = canvas.clientWidth || 480;
    const displayH = canvas.clientHeight || 110;
    canvas.width = displayW * dpr;
    canvas.height = displayH * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, displayW, displayH);
    const base = getComputedStyle(canvas).color;
    const toRgba = (c: string, a: number): string => {
        if (c.startsWith('rgb(')) return c.replace('rgb(', 'rgba(').replace(')', `, ${a})`);
        if (c.startsWith('#')) {
            const hex =
                c.length === 4 ? c.replace(/[0-9a-f]/gi, (ch) => ch + ch).slice(1) : c.slice(1);
            const num = parseInt(hex, 16);
            return `rgba(${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}, ${a})`;
        }
        return `rgba(128,128,128,${a})`;
    };
    const gridColor = toRgba(base, 0.18);
    const labelColor = toRgba(base, 0.65);
    const okColor = '#22c55e';
    const failColor = '#dc2626';

    ctx.font = '10px ui-monospace, monospace';

    const latencies = samples
        .map((sample) => sample.latencyMs)
        .filter((latency): latency is number => latency != null);
    const peak = roundUpNice(Math.max(50, ...latencies, 0));
    const yTickValues = [0, peak / 2, peak];
    const maxYLabelWidth = Math.max(
        ...yTickValues.map((value) => ctx.measureText(`${Math.round(value)} ms`).width),
    );
    const m = {
        left: Math.max(28, Math.ceil(maxYLabelWidth) + 8),
        right: 8,
        top: 8,
        bottom: 18,
    };
    const cW = displayW - m.left - m.right;
    const cH = displayH - m.top - m.bottom;
    const span = Math.max(1, windowEnd - windowStart);
    const xFor = (ts: number) => m.left + ((ts - windowStart) / span) * cW;
    const yFor = (latencyMs: number) => m.top + cH - (latencyMs / peak) * cH;

    ctx.fillStyle = labelColor;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (const value of yTickValues) {
        const y = yFor(value);
        ctx.beginPath();
        ctx.moveTo(m.left, y);
        ctx.lineTo(displayW - m.right, y);
        ctx.strokeStyle = gridColor;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillText(`${Math.round(value)} ms`, m.left - 4, y);
    }

    const stepMs = 60 * 1000;
    const firstLabel = Math.ceil(windowStart / stepMs) * stepMs;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let ts = firstLabel; ts <= windowEnd + 1; ts += stepMs) {
        const x = xFor(ts);
        ctx.beginPath();
        ctx.moveTo(x, m.top);
        ctx.lineTo(x, displayH - m.bottom);
        ctx.strokeStyle = toRgba(base, 0.1);
        ctx.lineWidth = 1;
        ctx.stroke();
        const d = new Date(ts);
        ctx.fillText(
            `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`,
            x,
            displayH - 14,
        );
    }

    const okSamples = samples.filter((sample) => sample.ok && sample.latencyMs != null) as Array<{
        ts: number;
        ok: true;
        latencyMs: number;
    }>;
    if (okSamples.length > 0) {
        ctx.beginPath();
        ctx.moveTo(xFor(okSamples[0].ts), yFor(okSamples[0].latencyMs));
        for (let i = 1; i < okSamples.length; i++) {
            ctx.lineTo(xFor(okSamples[i].ts), yFor(okSamples[i].latencyMs));
        }
        ctx.strokeStyle = okColor;
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }

    const halfInterval = Math.max(1, intervalMs) / 2;
    ctx.fillStyle = toRgba(failColor, 0.35);
    for (const sample of samples) {
        if (sample.ok) continue;
        const xStart = xFor(sample.ts - halfInterval);
        const xEnd = xFor(sample.ts + halfInterval);
        ctx.fillRect(xStart, m.top, Math.max(1, xEnd - xStart), cH);
    }
}

export function drawHostProbeCharts(): void {
    const targets = state.hostProbes.targets ?? [];
    const windowEnd = Date.now() - state.hostChartOffsetMs;
    const windowStart = windowEnd - CHART_WINDOW_MS;
    for (const entry of targets) {
        const samples = entry.history.filter(
            (sample) => sample.ts >= windowStart && sample.ts <= windowEnd,
        );
        drawProbeChart(
            `host-probe-chart-${entry.target.slot}`,
            samples,
            windowStart,
            windowEnd,
            state.hostProbes.intervalMs ?? 5000,
        );
    }
}

export function restreamSinkLabel(url: string): string | null {
    for (const p of state.config.pipelines ?? []) {
        if (url === p.rtmpPublishUrlLocal) return `rtmp:// ${p.name}`;
        if (url === p.srtPublishUrlLocal) return `srt:// ${p.name}`;
    }
    return null;
}

// Config-shape lint, independent of live health: flags audio-encoding choices
// that are technically accepted but wrong for the input's protocol — see
// encodeAudioArgs/buildSinkMapArgs in ffmpeg.ts for why each of these matters.
// Gated on input.connected because an unconnected input's isSrt defaults to
// false (protocol not yet observed), which would otherwise misreport every
// not-yet-live SRT pipeline as RTMP.
export function outputEncodingWarnings(o: OutputView, input: InputHealth): string[] {
    if (!o.url || !input.connected) return [];
    const warnings: string[] = [];
    const outIsSrt = o.url.startsWith('srt://');

    // RTMP inputs only ever expose a single default track (index 0, "Track 1"
    // in the picker), so any other track index has nothing to select from.
    if (!input.isSrt && o.audioEncoding !== 'copy' && o.audioEncoding !== '0') {
        warnings.push(
            'RTMP input only has one audio track — use copy or Track 1, not a different track selection.',
        );
    }

    // SRT→RTMP with 'copy' skips the aresample filter that corrects SRT-origin
    // timestamp jitter (see encodeAudioArgs) — the RTMP side will drift/stutter.
    if (input.isSrt && !outIsSrt && o.audioEncoding === 'copy') {
        warnings.push(
            'SRT-to-RTMP output should not use copy audio — it can cause audio jitter; select a track instead.',
        );
    }

    // A numeric selection past the input's actual track count maps to a
    // stream that doesn't exist — ffmpeg fails fast on that (see
    // buildSinkMapArgs/buildAudioMapArgs), so this is a real misconfiguration,
    // not just a style nit. Only checked once the input has actually been
    // probed (audioTracks populated) — before that the real count is unknown,
    // so a track pick can't yet be judged out of range.
    if (input.isSrt && input.audioTracks.length > 0) {
        const outOfRange = o.audioEncoding
            .split(',')
            .map((s) => s.trim())
            .filter((s) => /^\d+$/.test(s))
            .map(Number)
            .filter((idx) => idx >= input.audioTracks.length);
        if (outOfRange.length > 0) {
            const trackLabel = outOfRange.map((idx) => idx + 1).join(', ');
            const count = input.audioTracks.length;
            warnings.push(
                `Output selects track ${trackLabel}, but the input only has ${count} audio track${count === 1 ? '' : 's'}.`,
            );
        }
    }

    return warnings;
}
