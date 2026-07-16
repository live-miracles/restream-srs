import {
    setInnerText,
    setBadgeCount,
    escapeHtml,
    formatBitrate,
    formatBytesCompact,
    getUrlParam,
    maskStreamKey,
    maskSecret,
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
    LayoutOrderEntry,
    MetricSample,
    OutputView,
    PipelineView,
    SrtBondingLeg,
    VideoInfo,
} from '../types.js';
import { updateLayoutOrder } from '../core/api.js';
import {
    stopCurrentPreview,
    populatePreviewTrackSelect,
    getPreviewPipelineId,
    syncPreviewControls,
} from './preview.js';

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

function fmtFieldOrder(fo: string | null | undefined): string | null {
    if (!fo || fo === 'unknown') return null;
    if (fo === 'progressive') return 'P';
    if (fo === 'tt' || fo === 'tb') return 'i TFF';
    if (fo === 'bb' || fo === 'bt') return 'i BFF';
    return fo;
}

const pendingOutputs = new Map<string, 'start' | 'stop'>();
const RELAY_FLOW_STALE_MS = 15000;
const METRIC_WARN_PERCENT = 70;
const METRIC_ERROR_PERCENT = 90;

// ── Drag-and-drop reordering ───────────────────────────
//
// The pipeline list and outputs list are rebuilt (innerHTML) on every 5s
// poll tick regardless of whether anything changed, which would yank a
// dragged element out from under the user mid-gesture. While a drag is in
// progress, renderPipelineList/renderOutputsList skip rebuilding entirely —
// the module-level element refs below double as that "don't touch the DOM
// right now" flag, and are always cleared by the drag's `dragend`, which
// the browser guarantees fires whether the drop succeeded or was cancelled.
let draggingPipelineEl: HTMLElement | null = null;
let draggingOutputEl: HTMLElement | null = null;

// The order actually being displayed right now (post drag-and-drop, or as
// last loaded from the server) — the baseline `persist*Order` helpers below
// patch one dimension of before writing back, so an in-flight drag on one
// pipeline's outputs doesn't clobber another pipeline's already-saved order.
function currentLayoutOrder(): LayoutOrderEntry[] {
    return state.pipelines.map((p) => ({ id: Number(p.id), outs: p.outs.map((o) => o.id) }));
}

async function persistPipelineOrder(newPipelineOrder: string[]): Promise<void> {
    const byId = new Map(currentLayoutOrder().map((e) => [String(e.id), e]));
    const order = newPipelineOrder
        .map((id) => byId.get(id))
        .filter((e): e is LayoutOrderEntry => !!e);
    await updateLayoutOrder(order);
    const { refreshAfterMutation } = await import('./dashboard.js');
    await refreshAfterMutation();
}

async function persistOutputOrder(pipelineId: string, newOutputOrder: string[]): Promise<void> {
    const order = currentLayoutOrder().map((e) =>
        String(e.id) === pipelineId ? { ...e, outs: newOutputOrder } : e,
    );
    await updateLayoutOrder(order);
    const { refreshAfterMutation } = await import('./dashboard.js');
    await refreshAfterMutation();
}

function outputMemoryPercent(o: OutputView): number | null {
    if (o.memoryUsageBytes == null || !o.memoryLimitBytes) return null;
    return (o.memoryUsageBytes / o.memoryLimitBytes) * 100;
}

function formatOutputMemory(o: OutputView): string | null {
    if (o.memoryUsageBytes == null) return null;
    return formatBytesCompact(o.memoryUsageBytes);
}

function memorySeverityClass(percent: number | null): string {
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

function setMetricSeverity(id: string, percent: number | null): void {
    const el = document.getElementById(id);
    if (!el) return;

    const isError = percent !== null && percent >= METRIC_ERROR_PERCENT;
    const isWarning =
        percent !== null && percent >= METRIC_WARN_PERCENT && percent < METRIC_ERROR_PERCENT;

    el.classList.toggle('text-error', isError);
    el.classList.toggle('text-warning', isWarning);
    el.classList.toggle('font-semibold', isError || isWarning);
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
function hasCurrentOutputError(o: OutputView): boolean {
    if (o.lastError === null || o.lastErrorAt === null) return false;
    if (o.startedAtMs === null) return o.failures > 0;
    return o.lastErrorAt >= o.startedAtMs;
}

function outStatus(o: OutputView, input: InputHealth): OutStatus {
    if (o.desiredState === 'stopped') return 'off';
    if (o.status === 'failed') return 'error';
    if (o.status === 'running') {
        if (!input.live) return 'warn';
        if (o.warningReason !== null) return 'warn';
        if (o.bitrateKbps !== null && o.bitrateKbps >= LOW_BITRATE_KBPS) return 'good';
        if (o.bitrateKbps === null && hasCurrentOutputError(o)) return 'error';
        return 'warn';
    }
    // status === 'stopped' but desiredState === 'running': between retries
    return hasCurrentOutputError(o) ? 'error' : 'warn';
}

function inputStatus(input: InputHealth): InputStatus {
    if (input.connected && input.mediaOk === false) return 'error';
    if (input.live) {
        if (inputMissingAudio(input)) return 'warn';
        if (input.recvBitrateKbps !== null && input.recvBitrateKbps < LOW_BITRATE_KBPS)
            return 'warn';
        return 'good';
    }
    if (input.connected) return 'warn';
    return 'off';
}

function inputMissingAudio(input: InputHealth): boolean {
    return input.live && input.audioTracks.length === 0 && input.audio === null;
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
    const st = inputStatus(input);
    if (st === 'error') {
        return [
            {
                severity: 'error',
                message: inputStatusMessage(input),
            },
        ];
    }
    if (st === 'warn') {
        if (!input.live) {
            return [
                {
                    severity: 'warning',
                    message: inputStatusMessage(input),
                },
            ];
        }
        const issues: OverviewIssue[] = [];
        if (input.recvBitrateKbps !== null && input.recvBitrateKbps < LOW_BITRATE_KBPS) {
            issues.push({
                severity: 'warning',
                message: `Input bitrate is below ${LOW_BITRATE_KBPS} kb/s.`,
            });
        }
        if (inputMissingAudio(input)) {
            issues.push({ severity: 'warning', message: 'No audio track detected in input.' });
        }
        return issues;
    }
    return [];
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
    const st = outStatus(o, input);
    if (st !== 'warn' && st !== 'error') return [];
    const withFailures = (message: string): string =>
        o.failures > 0
            ? `${o.failures} error${o.failures === 1 ? '' : 's'} since last start. ${message}`
            : message;

    if (st === 'error') {
        if (o.status === 'failed') {
            return [
                {
                    severity: 'error',
                    message: withFailures(
                        summarizeOutputError(o.lastError, 'Output process failed.'),
                    ),
                },
            ];
        }
        if (o.bitrateKbps === null && hasCurrentOutputError(o)) {
            return [
                {
                    severity: 'error',
                    message: withFailures(
                        summarizeOutputError(o.lastError, 'Output has no bitrate after an error.'),
                    ),
                },
            ];
        }
        if (hasCurrentOutputError(o)) {
            return [
                {
                    severity: 'error',
                    message: withFailures(
                        summarizeOutputError(o.lastError, 'Output failed and is waiting to retry.'),
                    ),
                },
            ];
        }
        return [{ severity: 'error', message: 'Output is in an error state.' }];
    }

    if (o.warningReason) return [{ severity: 'warning', message: o.warningReason }];
    if (!input.live && o.status === 'running') {
        return [{ severity: 'warning', message: 'Output is running but input is not live.' }];
    }
    if (o.status === 'running' && o.bitrateKbps === null) {
        return [
            { severity: 'warning', message: 'Output is running but no bitrate is reported yet.' },
        ];
    }
    if (o.status === 'running') {
        return [
            { severity: 'warning', message: `Output bitrate is below ${LOW_BITRATE_KBPS} kb/s.` },
        ];
    }
    return [{ severity: 'warning', message: 'Output is waiting to start or retry.' }];
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

function legStateDotColor(state: SrtBondingLeg['state']): string {
    switch (state) {
        case 'running':
            return STATUS_COLOR_GOOD;
        case 'idle':
        case 'pending':
            return STATUS_COLOR_WARN;
        case 'broken':
            return STATUS_COLOR_ERROR;
        default:
            return STATUS_COLOR_OFF;
    }
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

function renderPipelineList(): void {
    const listEl = document.getElementById('pipelines');
    if (!listEl) return;
    if (draggingPipelineEl) return; // preserve the DOM while a drag is in progress

    const inputsOn = state.pipelines.filter((p) => inputStatus(p.input) === 'good').length;
    const inputsWarn = state.pipelines.filter((p) => inputStatus(p.input) === 'warn').length;
    const inputsFailed = state.pipelines.filter((p) => inputStatus(p.input) === 'error').length;
    const totalOutputs = state.pipelines.reduce((s, p) => s + p.outs.length, 0);
    const outputsOn = state.pipelines.reduce(
        (s, p) => s + p.outs.filter((o) => outStatus(o, p.input) === 'good').length,
        0,
    );
    const outputsWarn = state.pipelines.reduce(
        (s, p) => s + p.outs.filter((o) => outStatus(o, p.input) === 'warn').length,
        0,
    );
    const outputsFailed = state.pipelines.reduce(
        (s, p) => s + p.outs.filter((o) => outStatus(o, p.input) === 'error').length,
        0,
    );
    const outputsOff = state.pipelines.reduce(
        (s, p) => s + p.outs.filter((o) => o.desiredState === 'stopped').length,
        0,
    );

    setInnerText('pipe-cnt', state.pipelines.length);
    setBadgeCount('pipe-oks', inputsOn);
    setBadgeCount('pipe-warns', inputsWarn + inputsFailed);
    setBadgeCount(
        'pipe-offs',
        state.pipelines.filter((p) => inputStatus(p.input) === 'off').length,
    );
    setInnerText('out-cnt', totalOutputs);
    setBadgeCount('out-oks', outputsOn - outputsWarn);
    setBadgeCount('out-warns', outputsWarn);
    setBadgeCount('out-errors', outputsFailed);
    setBadgeCount('out-offs', outputsOff);

    const selectedId = getUrlParam('p');
    const relayProcessRunning = state.health.srtRelay?.status === 'running';

    // Pipelines sharing a stream key can't both actually publish — flag it the
    // same way duplicate output destination URLs are flagged.
    const keyRefs = new Map<number, DupRef[]>();
    for (const p of state.pipelines) {
        const list = keyRefs.get(p.streamKeyId) ?? [];
        list.push({ pipelineName: p.name });
        keyRefs.set(p.streamKeyId, list);
    }
    const dupKeys = new Map<number, DupRef[]>();
    for (const [id, refs] of keyRefs) {
        if (refs.length > 1) dupKeys.set(id, refs);
    }

    listEl.innerHTML = state.pipelines
        .map((p) => {
            const outGood = p.outs.filter((o) => outStatus(o, p.input) === 'good').length;
            const outWarn = p.outs.filter((o) => outStatus(o, p.input) === 'warn').length;
            const outFailed = p.outs.filter((o) => outStatus(o, p.input) === 'error').length;
            const outOff = p.outs.filter((o) => outStatus(o, p.input) === 'off').length;

            const inColor = relayInputSeverityColor(
                p,
                relayProcessRunning,
                inputStatusColor(p.input),
            );
            const outColor =
                outFailed > 0
                    ? STATUS_COLOR_ERROR
                    : outWarn > 0
                      ? STATUS_COLOR_WARN
                      : outGood > 0
                        ? STATUS_COLOR_GOOD
                        : STATUS_COLOR_OFF;
            const selected = p.id === selectedId ? 'bg-base-100' : '';
            const relayInputSt = relayInputStatus(p, relayProcessRunning);
            const relayOutputSt = relayOutputStatus(p, relayProcessRunning);
            const statusIssues: OverviewIssue[] = [
                ...inputIssues(p.input),
                ...p.outs.flatMap((o) =>
                    outputIssues(o, p.input).map((issue) => ({
                        severity: issue.severity,
                        message: `${o.name}: ${issue.message}`,
                    })),
                ),
                ...relayIssues(p, relayProcessRunning, relayInputSt, relayOutputSt),
            ];
            const statusTooltip = renderIssueTooltip(statusIssues);

            const badge = (n: number, cls: string) =>
                n > 0 ? `<div class="badge badge-sm ${cls} px-2">${n}</div>` : '';
            const uptimeSpan =
                p.input.live && p.input.uptimeMs !== null
                    ? `<span class="font-mono text-xs opacity-60 shrink-0">${formatUptime(p.input.uptimeMs)}</span>`
                    : '';
            const inputTypeBadge = p.input.connected
                ? `<span class="badge badge-sm badge-outline shrink-0">${p.srtBonding.acceptedBySrs ? 'Relay' : p.input.isSrt ? 'SRT' : 'RTMP'}</span>`
                : '';
            const dupKeyRefs = dupKeys.get(p.streamKeyId);
            const nameClass = dupKeyRefs ? 'truncate min-w-0 text-warning' : 'truncate min-w-0';
            const dupKeyWarn = dupKeyRefs
                ? `<span class="js-tooltip text-warning shrink-0 inline-flex" tabindex="0">${ICON_WARN}<div class="js-tooltip-content hidden">${dupTooltip('Duplicate stream key — also used by:', dupKeyRefs)}</div></span>`
                : '';

            return `<li data-pipeline-id="${p.id}">
            <div class="flex items-center gap-2 ${selected} cursor-pointer js-select-pipeline" data-id="${p.id}">
                <div class="js-tooltip shrink-0">
                    <div class="rounded-box h-5 w-5" style="background:linear-gradient(90deg,${inColor},${inColor} 45%,#242933 45%,#242933 55%,${outColor} 55%)"></div>
                    <div class="js-tooltip-content hidden">${statusTooltip}</div>
                </div>
                ${badge(outGood, 'badge-success')}
                ${badge(outWarn, 'badge-warning')}
                ${badge(outFailed, 'badge-error')}
                ${badge(outOff, 'badge-ghost')}
                <a class="js-pipeline-drag-handle cursor-grab ${nameClass}" draggable="true" title="Drag to reorder">${escapeHtml(p.name)}</a>
                ${dupKeyWarn}
                ${uptimeSpan}
                ${inputTypeBadge}
            </div>
        </li>`;
        })
        .join('');

    listEl.onclick = (e) => {
        const row = (e.target as Element).closest('.js-select-pipeline') as HTMLElement | null;
        if (row?.dataset.id) window.selectPipeline(row.dataset.id);
    };

    listEl.ondragstart = (e) => {
        const target = e.target as Element;
        const li = target.closest('li[data-pipeline-id]') as HTMLElement | null;
        if (!target.closest('.js-pipeline-drag-handle') || !li) {
            e.preventDefault();
            return;
        }
        draggingPipelineEl = li;
        li.classList.add('opacity-40');
        e.dataTransfer!.effectAllowed = 'move';
        e.dataTransfer!.setData('text/plain', li.dataset.pipelineId!);
        e.dataTransfer!.setDragImage(li, 12, 12);
    };

    listEl.ondragover = (e) => {
        if (!draggingPipelineEl) return;
        e.preventDefault();
        e.dataTransfer!.dropEffect = 'move';
        const overLi = (e.target as Element).closest('li[data-pipeline-id]') as HTMLElement | null;
        if (!overLi || overLi === draggingPipelineEl) return;
        const rect = overLi.getBoundingClientRect();
        const before = e.clientY < rect.top + rect.height / 2;
        overLi.parentElement?.insertBefore(
            draggingPipelineEl,
            before ? overLi : overLi.nextElementSibling,
        );
    };

    listEl.ondrop = (e) => e.preventDefault();

    listEl.ondragend = () => {
        if (!draggingPipelineEl) return;
        draggingPipelineEl.classList.remove('opacity-40');
        draggingPipelineEl = null;
        const order = Array.from(listEl.querySelectorAll('li[data-pipeline-id]')).map(
            (li) => (li as HTMLElement).dataset.pipelineId!,
        );
        void persistPipelineOrder(order);
    };
}

// ── Pipeline info (middle column) ─────────────────────

function formatUptime(ms: number | null): string {
    if (ms === null) return '—';
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

function formatMediaProbeStatus(input: InputHealth): string | null {
    if (input.mediaCheckedAt) {
        return `Last ffprobe ${new Date(input.mediaCheckedAt).toLocaleTimeString(undefined, { hour12: false })}`;
    }
    if (input.mediaProbeStartedAt) {
        return `ffprobe started ${new Date(input.mediaProbeStartedAt).toLocaleTimeString(undefined, { hour12: false })}`;
    }
    if (input.connected && !input.live) return 'ffprobe not run yet';
    return null;
}

function inputStatusMessage(input: InputHealth): string {
    return input.mediaError ?? 'Input connected, waiting for valid media.';
}

function renderMediaProbeNotice(input: InputHealth): string {
    const message =
        input.mediaError ?? 'Codec info is still being probed — this may take a moment.';
    const toneClass = input.mediaError ? 'text-error' : input.live ? 'opacity-50' : 'text-warning';
    const probeStatus = input.mediaError ? null : formatMediaProbeStatus(input);
    return `<p class="text-xs ${toneClass} mt-2">${escapeHtml(message)}${probeStatus ? ` <span class="opacity-60">${escapeHtml(probeStatus)}</span>` : ''}</p>`;
}

function renderInputStats(input: InputHealth): string {
    if (!input.connected) return '';
    if (!input.live) {
        return renderMediaProbeNotice(input);
    }

    const v = input.video;
    const a = input.audio;
    const compactStat = (label: string, val: string | number | null | undefined) =>
        `<span class="input-meta-item"><span class="input-meta-label">${label}</span><span class="input-meta-value">${val ?? '—'}</span></span>`;

    return `
        ${
            v
                ? `
        <div class="input-meta-row input-meta-row-sm my-0.5">
            ${compactStat('IP', input.publisherIp)}
            ${compactStat('In', formatBitrate(input.recvBitrateKbps))}
            ${compactStat('Codec', v.codec)}
            ${compactStat('Size', v.width && v.height ? `${v.width}×${v.height}` : null)}
            ${compactStat('FPS', v.fps != null ? v.fps : null)}
            ${compactStat('Scan', fmtFieldOrder(v.fieldOrder))}
            ${compactStat('Prof', v.profile || null)}
            ${compactStat('Lvl', v.level || null)}
        </div>`
                : renderMediaProbeNotice(input)
        }
        ${
            input.audioTracks.length > 0
                ? `
        <h3 class="mt-3 text-sm font-semibold opacity-60">Audio <span class="font-normal">(${input.audioTracks.length} track${input.audioTracks.length > 1 ? 's' : ''})</span></h3>
        <table class="table table-xs mt-1">
            <thead><tr><th>#</th>${input.audioTracks.some((t) => t.pid != null) ? '<th>PID</th>' : ''}<th>Codec</th><th>Profile</th><th>Ch</th><th>Freq</th>${input.audioTracks.some((t) => t.language || t.title) ? '<th>Label</th>' : ''}</tr></thead>
            <tbody>
                ${input.audioTracks
                    .map((t) => {
                        const label = escapeHtml([t.language, t.title].filter(Boolean).join(' — '));
                        return `<tr>
                        <td class="font-mono">${t.index + 1}</td>
                        ${input.audioTracks.some((x) => x.pid != null) ? `<td class="font-mono">${t.pid ?? '—'}</td>` : ''}
                        <td>${t.codec || '—'}</td>
                        <td>${t.profile || '—'}</td>
                        <td>${t.channels || '—'}</td>
                        <td>${t.sampleRate ? `${(t.sampleRate / 1000).toFixed(1)} kHz` : '—'}</td>
                        ${input.audioTracks.some((x) => x.language || x.title) ? `<td class="opacity-60">${label || ''}</td>` : ''}
                    </tr>`;
                    })
                    .join('')}
            </tbody>
        </table>`
                : a
                  ? `
        <h3 class="mt-3 text-sm font-semibold opacity-60">Audio</h3>
        <div class="mt-1">
            ${renderCompactMetaRow([
                { label: 'Codec', value: a.codec },
                { label: 'Profile', value: a.profile || null },
                {
                    label: 'Sample Rate',
                    value: a.sample_rate ? `${(a.sample_rate / 1000).toFixed(1)} kHz` : null,
                },
                { label: 'Channels', value: a.channel },
            ])}
        </div>`
                  : ''
        }
    `;
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

function renderOverview(): void {
    const overviewEl = document.getElementById('overview-col');
    if (!overviewEl) return;

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
            p.srtBonding.input.retransTotal > 0 ||
            p.srtBonding.input.recvLossTotal > 0 ||
            p.srtBonding.input.recvDropTotal > 0,
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
        const color = legStateDotColor(leg.state);
        return `
            <td><span class="inline-flex items-center gap-1"><span class="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style="background:${color}"></span>${escapeHtml(leg.state)}</span></td>
            <td class="font-mono text-xs">${escapeHtml(leg.ip)}</td>
            <td class="font-mono text-xs">${fmtMs(leg.latencyMs)}</td>
            <td class="font-mono text-xs">${fmtMs(leg.rttMs)}</td>
            <td class="font-mono text-xs">${fmtMbpsValue(leg.recvRateMbps)}</td>
            <td class="font-mono text-xs" title="Loss / Rexmit / Drop">${fmtLossRexmitDrop(leg.recvLossTotal, leg.retransTotal, leg.recvDropTotal)}</td>`;
    };

    let relayRows = '';
    if (activeRelayPipelines.length === 0) {
        relayRows = `<tr><td colspan="11" class="py-4 text-center opacity-50">No active SRT bonding relay sessions.</td></tr>`;
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
            const sharedCells = `
                <td class="font-semibold cursor-pointer hover:underline js-select-pipeline" data-id="${p.id}"${rowspan}>${escapeHtml(p.name)}</td>
                <td${rowspan}>${overviewStatusBadge(inputSt)}</td>
                <td${rowspan}>${overviewStatusBadge(outputSt)}</td>
                <td${rowspan}>${renderOverviewIssues(relayIssues(p, relayProcessRunning, inputSt, outputSt))}</td>`;
            const totalsCells = `
                <td class="font-mono text-xs" title="Loss / Rexmit / Drop"${rowspan}>${fmtLossRexmitDrop(p.srtBonding.input.recvLossTotal, p.srtBonding.input.retransTotal, p.srtBonding.input.recvDropTotal)}</td>`;

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
            relayRows = `<tr><td colspan="11" class="py-4 text-center opacity-50">No relay issues.</td></tr>`;
        } else if (activeOnly && relayRows === '') {
            relayRows = `<tr><td colspan="11" class="py-4 text-center opacity-50">No active relay sessions.</td></tr>`;
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
                <td class="font-mono text-xs">${inp.connected ? formatBitrate(inp.recvBitrateKbps) : '—'}</td>
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
        outputRows = `<tr><td colspan="8" class="py-4 text-center opacity-50">No outputs yet.</td></tr>`;
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
                    <td class="font-mono text-xs ${memorySeverityClass(outputMemoryPercent(o))}">${formatOutputMemory(o) ?? '—'}</td>
                    <td>${typeBadge(protocolLabel)}</td>
                    <td class="font-mono text-xs">${spec}</td>
                </tr>`;
            }
        }
        if (problemsOnly && outputRows === '') {
            outputRows = `<tr><td colspan="8" class="py-4 text-center opacity-50">No output issues.</td></tr>`;
        } else if (activeOnly && outputRows === '') {
            outputRows = `<tr><td colspan="8" class="py-4 text-center opacity-50">No active outputs.</td></tr>`;
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
    const fmtMbps = (bps: number) => `${((bps * 8) / 1_000_000).toFixed(1)} Mb/s`;

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
        ${chartCard('chart-rx', 'Downlink', last ? fmtMbps(last.rxBps) : '—')}
        ${chartCard('chart-tx', 'Uplink', last ? fmtMbps(last.txBps) : '—')}
    </div>`;

    const totalAll = activeRelayPipelines.length + state.pipelines.length + totalOuts;
    const totalActive = relayActiveCount + inputActiveCount + outputActiveCount;
    const totalProblems = relayProblemCount + inputProblemCount + outputProblemCount;
    const filterChips = `
    <div role="tablist" class="tabs tabs-lift mb-4">
        <a role="tab" id="ov-filter-all" aria-selected="${state.overviewFilter === 'all'}" class="tab gap-1 ${state.overviewFilter === 'all' ? 'tab-active' : ''}">
            All
            <span class="badge badge-xs badge-ghost">${totalAll}</span>
        </a>
        <a role="tab" id="ov-filter-active" aria-selected="${activeOnly}" class="tab gap-1 ${activeOnly ? 'tab-active' : ''}">
            Active
            <span class="badge badge-xs badge-ghost">${totalActive}</span>
        </a>
        <a role="tab" id="ov-filter-problems" aria-selected="${problemsOnly}" class="tab gap-1 ${problemsOnly ? 'tab-active' : ''}">
            Issues
            <span class="badge badge-xs badge-ghost">${totalProblems}</span>
        </a>
    </div>`;

    overviewEl.innerHTML = `
        ${chartsHtml}
        ${filterChips}
        <h2 class="mb-2 text-lg font-bold">SRT Bonding Relay <span class="badge badge-neutral badge-sm ml-1">${activeRelayPipelines.length}</span></h2>
        <div class="overflow-x-auto mb-6">
            <table class="table table-sm table-relay">
                ${thead(['Pipeline', 'Input', 'Output', 'Issues', '<span title="Loss / Rexmit / Drop">L / R / D</span>', 'State', 'Leg IP', 'Latency', 'RTT', 'Rate', '<span title="Loss / Rexmit / Drop">L / R / D</span>'])}
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
                ${thead(['Pipeline · Output', 'Status', 'Issues', 'Uptime', 'Bitrate', 'RAM', 'Type', 'Stream Specification'])}
                <tbody>${outputRows}</tbody>
            </table>
        </div>`;

    const fmtPct = (v: number) => `${Math.round(v)}%`;
    const fmtMb = (v: number) => `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}`;
    drawChart('chart-cpu', chartSamples, (s) => s.cpu, 100, '#3b82f6', fmtPct);
    drawChart(
        'chart-ram',
        chartSamples,
        (s) => (s.ramUsed / s.ramTotal) * 100,
        100,
        '#a855f7',
        fmtPct,
    );
    drawChart('chart-rx', chartSamples, (s) => (s.rxBps * 8) / 1_000_000, 0, '#22c55e', fmtMb);
    drawChart('chart-tx', chartSamples, (s) => (s.txBps * 8) / 1_000_000, 0, '#f97316', fmtMb);

    document.getElementById('chart-back')?.addEventListener('click', () => {
        state.chartOffsetMs = Math.min(state.chartOffsetMs + CHART_SCROLL_STEP_MS, maxOffset);
        renderOverview();
    });
    document.getElementById('chart-fwd')?.addEventListener('click', () => {
        state.chartOffsetMs = Math.max(0, state.chartOffsetMs - CHART_SCROLL_STEP_MS);
        renderOverview();
    });
    document.getElementById('ov-filter-all')?.addEventListener('click', () => {
        state.overviewFilter = 'all';
        renderOverview();
    });
    document.getElementById('ov-filter-active')?.addEventListener('click', () => {
        state.overviewFilter = 'active';
        renderOverview();
    });
    document.getElementById('ov-filter-problems')?.addEventListener('click', () => {
        state.overviewFilter = 'problems';
        renderOverview();
    });
    // Assignment (not addEventListener) since overviewEl itself persists across
    // renders while its contents are fully replaced above — addEventListener
    // would stack a new listener on every render.
    overviewEl.onclick = (e) => {
        const cell = (e.target as Element).closest('.js-select-pipeline') as HTMLElement | null;
        if (cell?.dataset.id) window.selectPipeline(cell.dataset.id);
    };
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

function renderHostConnectionsOverview(): void {
    const hostsCol = document.getElementById('hosts-col');
    if (!hostsCol) return;

    const configuredTargets = state.config.hostProbeTargets ?? [];
    const targets = state.hostProbes.targets ?? [];
    if (configuredTargets.length === 0) {
        hostsCol.innerHTML = `
            <div class="rounded-xl border border-dashed border-base-content/15 p-8 text-center">
                <h2 class="text-lg font-semibold">No Host Probes Configured</h2>
                <p class="mt-2 text-sm opacity-60">Open Settings and add up to 10 host targets to monitor connectivity.</p>
            </div>`;
        return;
    }

    const allHistory = targets.flatMap((entry) => entry.history);
    const oldest =
        allHistory.length > 0
            ? allHistory.reduce((min, sample) => Math.min(min, sample.ts), allHistory[0].ts)
            : null;
    const offset = state.hostChartOffsetMs;
    const windowEnd = Date.now() - offset;
    const windowStart = windowEnd - CHART_WINDOW_MS;
    const maxOffset = oldest != null ? Math.max(0, Date.now() - oldest - CHART_WINDOW_MS) : 0;
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

    const rendered = targets.map((entry) => {
        const latest = entry.latestSample;
        const windowSamples = entry.history.filter(
            (sample) => sample.ts >= windowStart && sample.ts <= windowEnd,
        );
        const highestLatency = windowSamples.reduce<number | null>((max, sample) => {
            if (sample.latencyMs == null) return max;
            return max == null ? sample.latencyMs : Math.max(max, sample.latencyMs);
        }, null);
        const latestStatus = !latest
            ? '<span class="badge badge-sm badge-neutral">No Data</span>'
            : latest.ok
              ? '<span class="badge badge-sm badge-success">Healthy</span>'
              : '<span class="badge badge-sm badge-error">Down</span>';
        const lastSeen = latest
            ? new Date(latest.ts).toLocaleTimeString(undefined, { hour12: false })
            : '—';
        const row = `<tr>
                <td class="font-semibold">${escapeHtml(entry.target.label)}</td>
                <td class="font-mono text-xs">${escapeHtml(entry.target.host)}:${entry.target.port}</td>
                <td>${latestStatus}</td>
                <td class="font-mono text-xs">${latest?.latencyMs != null ? `${Math.round(latest.latencyMs)} ms` : '—'}</td>
                <td class="font-mono text-xs">${highestLatency != null ? `${Math.round(highestLatency)} ms` : '—'}</td>
                <td class="font-mono text-xs">${entry.averageLatencyMs != null ? `${Math.round(entry.averageLatencyMs)} ms` : '—'}</td>
                <td class="font-mono text-xs">${entry.historyFailureCount}</td>
                <td class="font-mono text-xs">${lastSeen}</td>
                <td class="font-mono text-xs">${latest?.resolvedAddress ?? '—'}</td>
            </tr>`;

        // "no recent failures" must reflect the visible window, not just the
        // single latest sample — a probe can fail repeatedly and still recover
        // on the very next tick, which would otherwise mask the burst.
        const windowFailures = windowSamples.filter((sample) => !sample.ok);
        const lastWindowFailure = windowFailures[windowFailures.length - 1] ?? null;
        const errorText =
            latest && !latest.ok
                ? (latest.error ?? 'probe failed')
                : lastWindowFailure
                  ? `${windowFailures.length} failure${windowFailures.length === 1 ? '' : 's'} in this window, last at ${new Date(lastWindowFailure.ts).toLocaleTimeString(undefined, { hour12: false })}`
                  : 'no recent failures';
        const errorTone =
            latest && !latest.ok ? 'text-error' : lastWindowFailure ? 'text-warning' : 'opacity-60';
        const canvasId = `host-probe-chart-${entry.target.slot}`;
        const card = `<div class="bg-base-300 rounded-xl p-4">
                <div class="mb-3 flex items-start justify-between gap-3">
                    <div>
                        <h3 class="font-semibold">${escapeHtml(entry.target.label)}</h3>
                        <p class="font-mono text-xs opacity-60">${escapeHtml(entry.target.host)}:${entry.target.port}</p>
                    </div>
                    <div class="text-right">
                        <div class="font-mono text-sm">${latest?.latencyMs != null ? `${Math.round(latest.latencyMs)} ms` : '—'}</div>
                        <div class="text-xs ${errorTone}">${escapeHtml(errorText)}</div>
                    </div>
                </div>
                <canvas id="${canvasId}" style="width:100%;height:110px;display:block"></canvas>
            </div>`;

        return { row, card };
    });

    const rows =
        rendered.length > 0
            ? rendered.map((r) => r.row).join('')
            : `<tr><td colspan="9" class="py-4 text-center opacity-50">No probe history loaded yet — click refresh.</td></tr>`;
    const cards = rendered.map((r) => r.card).join('');

    hostsCol.innerHTML = `
        <div class="mb-4 flex items-center justify-between gap-3">
            <div class="min-w-0 text-sm">
                <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span class="badge badge-outline badge-sm font-mono">
                        Updated ${state.hostProbes.generatedAt ? new Date(state.hostProbes.generatedAt).toLocaleTimeString(undefined, { hour12: false }) : '—'}
                    </span>
                    <h2 class="text-base font-bold">Host Connections</h2>
                    <span class="opacity-60">TCP probe history for configured platform hosts. Probe interval ${state.hostProbes.intervalMs != null ? `${Math.round(state.hostProbes.intervalMs / 1000)}s` : 'unknown'}.</span>
                </div>
            </div>
            <div class="flex shrink-0 items-center gap-3">
                <button
                    id="host-connections-refresh"
                    type="button"
                    class="btn btn-sm btn-ghost btn-square inline-flex items-center justify-center leading-none"
                    onclick="refreshHostConnectionsBtn()"
                    title="Refresh host connections">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" class="block h-4 w-4 shrink-0 fill-current" aria-hidden="true">
                        <path d="M10 3a7 7 0 0 1 6.56 4.57.75.75 0 1 1-1.4.53A5.5 5.5 0 1 0 14.5 13H12a.75.75 0 0 1 0-1.5h4.25A.75.75 0 0 1 17 12.25v4.25a.75.75 0 0 1-1.5 0v-1.77A7 7 0 1 1 10 3Z" />
                    </svg>
                </button>
            </div>
        </div>
        <div class="bg-base-300 mb-4 rounded-xl p-4 text-sm leading-6 opacity-85">
            Use this view to correlate output failures with basic reachability to the configured ingest hosts. A healthy line means the server could open a TCP connection to that host and port at that time; red markers mean the connect probe failed or timed out. This is useful for ruling in or out broad network-path problems from the server to YouTube, Facebook, or other destinations.
            <br /><br />
            Limitations: these probes do not perform a full RTMP or RTMPS publish handshake, and they do not prove the destination will accept or keep a live stream session open. A host can look healthy here while the platform still rejects, resets, or drops an actual publish connection.
        </div>
        <div class="mb-2 flex items-center justify-center gap-2 px-1">
            <button id="host-chart-back" class="btn btn-xs btn-ghost" ${atStart || maxOffset === 0 ? 'disabled' : ''}>&#8592; 10 min</button>
            ${rangeLabel}
            <button id="host-chart-fwd" class="btn btn-xs btn-ghost" ${atLive ? 'disabled' : ''}>10 min &#8594;</button>
        </div>
        <div class="overflow-x-auto">
            <table class="table table-sm">
                <thead>
                    <tr>
                        <th>Label</th>
                        <th>Host</th>
                        <th>Status</th>
                        <th>Latest</th>
                        <th>15min Higherst</th>
                        <th>Avg</th>
                        <th>6h Fail</th>
                        <th>Last Sample</th>
                        <th>Resolved IP</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
        <div class="mt-6 grid grid-cols-1 gap-4">${cards}</div>`;

    for (const entry of targets) {
        const chartSamples = entry.history.filter(
            (sample) => sample.ts >= windowStart && sample.ts <= windowEnd,
        );
        drawProbeChart(
            `host-probe-chart-${entry.target.slot}`,
            chartSamples,
            windowStart,
            windowEnd,
            state.hostProbes.intervalMs ?? 5000,
        );
    }

    document.getElementById('host-chart-back')?.addEventListener('click', () => {
        state.hostChartOffsetMs = Math.min(
            state.hostChartOffsetMs + CHART_SCROLL_STEP_MS,
            maxOffset,
        );
        renderHostConnectionsOverview();
    });
    document.getElementById('host-chart-fwd')?.addEventListener('click', () => {
        state.hostChartOffsetMs = Math.max(0, state.hostChartOffsetMs - CHART_SCROLL_STEP_MS);
        renderHostConnectionsOverview();
    });
}

function renderPipelineInfo(selectedId: string | null): void {
    const pipeline = selectedId ? state.pipelines.find((p) => p.id === selectedId) : null;
    const col = document.getElementById('pipe-info-col');
    const outsCol = document.getElementById('outs-col');
    const overviewCol = document.getElementById('overview-col');
    const hostsCol = document.getElementById('hosts-col');
    const logsCol = document.getElementById('srs-logs-col');
    const settingsCol = document.getElementById('settings-col');
    const view = getUrlParam('view');
    const inHostView = view === 'hosts';
    const inLogsView = view === 'logs';
    const inSettingsView = view === 'settings';

    if (inHostView) {
        col?.classList.add('hidden');
        outsCol?.classList.add('hidden');
        overviewCol?.classList.add('hidden');
        logsCol?.classList.add('hidden');
        settingsCol?.classList.add('hidden');
        hostsCol?.classList.remove('hidden');
        renderHostConnectionsOverview();
        return;
    }

    // Logs/Settings content is populated once on navigation (see
    // dashboard-entry.ts), not on every poll — re-rendering here would wipe out
    // in-progress edits (e.g. a half-typed password) every 5 seconds.
    if (inLogsView) {
        col?.classList.add('hidden');
        outsCol?.classList.add('hidden');
        overviewCol?.classList.add('hidden');
        hostsCol?.classList.add('hidden');
        settingsCol?.classList.add('hidden');
        logsCol?.classList.remove('hidden');
        return;
    }

    if (inSettingsView) {
        col?.classList.add('hidden');
        outsCol?.classList.add('hidden');
        overviewCol?.classList.add('hidden');
        hostsCol?.classList.add('hidden');
        logsCol?.classList.add('hidden');
        settingsCol?.classList.remove('hidden');
        return;
    }

    if (!pipeline) {
        col?.classList.add('hidden');
        outsCol?.classList.add('hidden');
        overviewCol?.classList.remove('hidden');
        hostsCol?.classList.add('hidden');
        logsCol?.classList.add('hidden');
        settingsCol?.classList.add('hidden');
        renderOverview();
        return;
    }

    overviewCol?.classList.add('hidden');
    hostsCol?.classList.add('hidden');
    logsCol?.classList.add('hidden');
    settingsCol?.classList.add('hidden');

    col?.classList.remove('hidden');
    outsCol?.classList.remove('hidden');

    setInnerText('pipe-name', pipeline.name);
    const readersBadge = document.getElementById('pipe-readers-badge');
    if (readersBadge) {
        readersBadge.textContent = `${pipeline.input.readers} reader${pipeline.input.readers === 1 ? '' : 's'}`;
        readersBadge.classList.toggle('hidden', !pipeline.input.connected);
    }
    const hasActiveOutputs = pipeline.outs.some((o) => o.desiredState !== 'stopped');
    const deleteBtn = document.getElementById('pipe-delete-btn');
    deleteBtn?.classList.toggle('btn-disabled', hasActiveOutputs);
    deleteBtn?.classList.toggle('opacity-40', hasActiveOutputs);
    if (deleteBtn) deleteBtn.title = hasActiveOutputs ? 'Stop all outputs before deleting' : '';

    const statsContainer = document.getElementById('input-stats-container');
    const statsEl = document.getElementById('input-stats');
    const inputHtml = renderInputStats(pipeline.input);
    if (statsContainer) statsContainer.classList.toggle('hidden', !pipeline.input.connected);
    if (statsEl) statsEl.innerHTML = inputHtml;

    const masked = maskStreamKey(pipeline.streamKey);
    const rtmpEl = document.getElementById('rtmp-publish-url');
    const srtEl = document.getElementById('srt-publish-url');
    if (rtmpEl) {
        rtmpEl.dataset.copy = pipeline.rtmpPublishUrl;
        rtmpEl.textContent = pipeline.rtmpPublishUrl.replace(pipeline.streamKey, masked);
        const lastSlash = pipeline.rtmpPublishUrl.lastIndexOf('/');
        rtmpEl.dataset.serverUrl =
            lastSlash > -1
                ? pipeline.rtmpPublishUrl.substring(0, lastSlash)
                : pipeline.rtmpPublishUrl;
        rtmpEl.dataset.streamKey = pipeline.streamKey;
    }
    if (srtEl) {
        srtEl.dataset.copy = pipeline.srtPublishUrl;
        let srtDisplayUrl = pipeline.srtPublishUrl.replace(pipeline.streamKey, masked);
        if (state.config.srtPassphrase) {
            srtDisplayUrl = srtDisplayUrl.replace(
                encodeURIComponent(state.config.srtPassphrase),
                maskSecret(state.config.srtPassphrase),
            );
        }
        srtEl.textContent = srtDisplayUrl;
        const hostStart = 6;
        const colonAfterHost = pipeline.srtPublishUrl.indexOf(':', hostStart);
        srtEl.dataset.ip = pipeline.srtPublishUrl.slice(hostStart, colonAfterHost);
        const portEnd = pipeline.srtPublishUrl.indexOf('?', colonAfterHost);
        srtEl.dataset.port =
            portEnd > -1
                ? pipeline.srtPublishUrl.slice(colonAfterHost + 1, portEnd)
                : pipeline.srtPublishUrl.slice(colonAfterHost + 1);
        srtEl.dataset.streamId = `#!::r=live/${pipeline.streamKey},m=publish`;
        srtEl.dataset.passphrase = state.config.srtPassphrase || '';
    }

    const bondingCard = document.getElementById('srt-bonding-card');
    const bondingDot = document.getElementById('srt-bonding-status-dot');
    const bondingDotFill = document.getElementById('srt-bonding-status-fill');
    const bondingTooltipContent = document.getElementById('srt-bonding-status-tooltip-content');
    const bondingUrl = document.getElementById('srt-bonding-url');
    const bondingInfoBtn = document.getElementById('srt-bonding-info-btn');
    const bondingStats = document.getElementById('srt-bonding-stats');
    const bondingLegs = document.getElementById('srt-bonding-legs');
    const bondingErrWrap = document.getElementById('srt-bonding-last-error-wrap');
    const bondingErrTs = document.getElementById('srt-bonding-last-error-ts');
    const bondingErr = document.getElementById('srt-bonding-last-error');
    const bondingErrInfoBtn = document.getElementById('srt-bonding-last-error-info');
    const bondingInputActive = pipeline.srtBonding.inputActive;
    const bondingOutputConnected = pipeline.srtBonding.outputConnected;
    const relayProcessRunning = state.health.srtRelay?.status === 'running';
    const bondingHost = state.config.publicHost || 'localhost';
    const bondingPortValue = state.health.srtRelay?.port ?? 10081;
    const bondingStreamId = `#!::r=live/${pipeline.streamKey},m=publish`;
    const bondingUrlValue =
        `srt://${bondingHost}:${bondingPortValue}?mode=caller&grouptype=broadcast` +
        `&streamid=${bondingStreamId}` +
        (state.config.srtPassphrase
            ? `&passphrase=${encodeURIComponent(state.config.srtPassphrase)}&pbkeylen=16`
            : '');
    bondingCard?.classList.remove('opacity-60');
    if (bondingDot && bondingDotFill) {
        const indicator = getBondingIndicator(pipeline, relayProcessRunning);
        bondingDotFill.style.backgroundColor = 'transparent';
        bondingDotFill.style.backgroundImage =
            `linear-gradient(90deg, ` +
            `${indicator.leftColor} 0 45%, ` +
            `#242933 45% 55%, ` +
            `${indicator.rightColor} 55% 100%)`;
        if (bondingTooltipContent) {
            bondingTooltipContent.innerHTML = renderIssueTooltip(
                indicator.issues,
                indicator.offMessage,
            );
        }
    }
    if (bondingUrl) {
        let bondingDisplayUrl = bondingUrlValue.replace(pipeline.streamKey, masked);
        if (state.config.srtPassphrase) {
            bondingDisplayUrl = bondingDisplayUrl.replace(
                encodeURIComponent(state.config.srtPassphrase),
                maskSecret(state.config.srtPassphrase),
            );
        }
        bondingUrl.textContent = bondingDisplayUrl;
        bondingUrl.dataset.copy = bondingUrlValue;
        bondingUrl.dataset.port = String(bondingPortValue);
    }
    if (bondingInfoBtn) {
        (bondingInfoBtn as HTMLButtonElement).onclick = () => {
            void import('../features/editor.js').then((ed) =>
                ed.showSrtBondingDetails(pipeline.id),
            );
        };
    }
    if (bondingStats) {
        const b = pipeline.srtBonding;
        const rxPkts = b.input.recvUniquePacketsTotal || b.input.recvPacketsTotal || 0;
        const hasSessionStats =
            relayProcessRunning && (bondingInputActive || rxPkts > 0 || b.input.retransTotal > 0);
        const hasOutputStats =
            relayProcessRunning && (bondingOutputConnected || b.output.sentPacketsTotal > 0);
        const items = [
            ...(hasSessionStats
                ? [
                      {
                          label: 'Rx',
                          labelTitle:
                              'Unique data packets received from the upstream bonded SRT input, with a fallback to total received packets when needed.',
                          value: formatCompactCount(rxPkts),
                      },
                      {
                          label: 'Latency',
                          labelTitle:
                              'Negotiated SRT buffering latency for the input. For a bonded group this is the max latency negotiated across legs.',
                          value: fmtMs(b.input.latencyMs),
                      },
                      {
                          label: 'L / R / D',
                          labelTitle:
                              'Loss / Rexmit / Drop packets on the upstream bonded SRT input receiver.',
                          value: fmtLossRexmitDrop(
                              b.input.recvLossTotal,
                              b.input.retransTotal,
                              b.input.recvDropTotal,
                          ),
                      },
                  ]
                : []),
            ...(hasOutputStats
                ? [
                      {
                          label: 'Out L / R / D',
                          labelTitle: 'Loss / Rexmit / Drop on the downstream output connection.',
                          value: fmtLossRexmitDrop(
                              b.output.sendLossTotal,
                              b.output.retransTotal,
                              b.output.sendDropTotal,
                          ),
                      },
                  ]
                : []),
        ];
        bondingStats.innerHTML =
            items.length > 0 ? renderCompactMetaRow(items, 'input-meta-row-sm') : '';
    }
    if (bondingLegs) {
        const legs = pipeline.srtBonding.input.legs;
        bondingLegs.innerHTML =
            legs.length === 0
                ? ''
                : `<div class="text-xs font-semibold opacity-60 mb-1">Bonded legs (${legs.length})</div>
                   <div class="overflow-x-auto">
                   <table class="table table-xs">
                       <thead><tr>
                           <th>State</th><th>Leg IP</th><th>RTT</th>
                           <th>Rate</th><th>Buffer</th>
                           <th><span title="Loss / Rexmit / Drop">L / R / D</span></th>
                       </tr></thead>
                       <tbody>${legs
                           .map((leg) => {
                               const color = legStateDotColor(leg.state);
                               return `<tr>
                                   <td><span class="inline-flex items-center gap-1"><span class="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style="background:${color}"></span>${leg.state}</span></td>
                                   <td class="font-mono text-xs">${leg.ip}</td>
                                   <td class="font-mono text-xs">${fmtMs(leg.rttMs)}</td>
                                   <td class="font-mono text-xs">${fmtMbpsValue(leg.recvRateMbps)}</td>
                                   <td class="font-mono text-xs">${fmtMs(leg.rcvBufMs)}</td>
                                   <td class="font-mono text-xs" title="Loss / Rexmit / Drop">${fmtLossRexmitDrop(leg.recvLossTotal, leg.retransTotal, leg.recvDropTotal)}</td>
                               </tr>`;
                           })
                           .join('')}</tbody>
                   </table>
                   </div>`;
    }
    if (bondingErrWrap && bondingErr && bondingErrTs) {
        const msg = pipeline.srtBonding.lastError;
        const lastErrorLine = msg
            ? (msg
                  .split('\n')
                  .filter((l) => l.trim())
                  .slice(-1)[0] ?? '')
            : '';
        bondingErrWrap.classList.toggle('hidden', !msg);
        bondingErrTs.textContent = pipeline.srtBonding.lastErrorAt
            ? new Date(pipeline.srtBonding.lastErrorAt).toLocaleTimeString(undefined, {
                  hour12: false,
              })
            : '';
        bondingErr.textContent = lastErrorLine;
        if (bondingErrInfoBtn) {
            (bondingErrInfoBtn as HTMLButtonElement).onclick = () => {
                void import('../features/editor.js').then((ed) => ed.showRelayError(pipeline.id));
            };
        }
    }

    renderPreview(pipeline);
    renderOutputsList(pipeline);
}

// ── Outputs list (right column) ───────────────────────

const ICON_PENCIL = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>`;
const ICON_TRASH = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>`;
const ICON_HISTORY = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v6h6"/><path d="M12 7v5l3 2"/></svg>`;
const ICON_ITERATION_CW = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m12 2 3 3-3 3"/><path d="M15 5a9 9 0 1 1-3 16.9"/></svg>`;
const ICON_WARN = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`;
const ICON_ERROR = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>`;

type DupRef = { pipelineName: string; outputName?: string };

// Hover-tooltip content for a `.js-tooltip` trigger: a warning headline plus
// one line per place the duplicated value shows up (see initHoverTooltips).
function dupTooltip(headline: string, refs: DupRef[]): string {
    const lines = refs.map(
        (r) =>
            `<div class="text-xs leading-snug text-warning">${escapeHtml(r.outputName ? `${r.pipelineName} → ${r.outputName}` : r.pipelineName)}</div>`,
    );
    return `<div class="text-xs leading-snug font-semibold text-warning mb-0.5">${escapeHtml(headline)}</div>${lines.join('')}`;
}

function restreamSinkLabel(url: string): string | null {
    for (const p of state.config.pipelines ?? []) {
        if (url === p.rtmpPublishUrlLocal) return `rtmp:// ${p.name}`;
        if (url === p.srtPublishUrlLocal) return `srt:// ${p.name}`;
    }
    return null;
}

function renderOutputCard(
    o: OutputView,
    input: InputHealth,
    dupUrls: Map<string, DupRef[]>,
): string {
    const isStopped = o.desiredState === 'stopped';
    const isRunning = o.status === 'running';
    const st = outStatus(o, input);
    const statusHex =
        st === 'good'
            ? STATUS_COLOR_GOOD
            : st === 'warn'
              ? STATUS_COLOR_WARN
              : st === 'error'
                ? STATUS_COLOR_ERROR
                : STATUS_COLOR_OFF;
    const uptimeMs = o.startedAtMs !== null ? Date.now() - o.startedAtMs : null;
    const badges: string[] = [];
    if (o.videoEncoding !== 'copy') {
        badges.push(
            `<span class="badge badge-sm badge-accent badge-soft whitespace-nowrap">${o.videoEncoding}</span>`,
        );
    }
    if (o.audioEncoding !== 'copy') {
        badges.push(
            `<span class="badge badge-xs badge-accent badge-soft whitespace-nowrap">${o.audioEncoding
                .split(',')
                .map((t) => `T${parseInt(t) + 1}`)
                .join('+')}</span>`,
        );
    }
    if (uptimeMs !== null) {
        badges.push(
            `<span class="font-mono text-xs opacity-60 whitespace-nowrap">${formatUptime(uptimeMs)}</span>`,
        );
    }
    if (isRunning && o.bitrateKbps !== null) {
        badges.push(
            `<span class="badge badge-sm whitespace-nowrap">${formatBitrate(o.bitrateKbps)}</span>`,
        );
    }
    if (isRunning && o.memoryUsageBytes !== null) {
        const memPercent = outputMemoryPercent(o);
        const memCls =
            memPercent !== null && memPercent >= METRIC_ERROR_PERCENT
                ? 'badge-error'
                : memPercent !== null && memPercent >= METRIC_WARN_PERCENT
                  ? 'badge-warning'
                  : '';
        const memLabel = formatOutputMemory(o)?.replace(/([GMK])$/, ' $1b') ?? '—';
        badges.push(
            `<span class="badge badge-sm whitespace-nowrap ${memCls}" title="ffmpeg RSS">${memLabel}</span>`,
        );
    }
    let inlineSink = '';
    if (o.url) {
        const restreamLabel = restreamSinkLabel(o.url);
        const display =
            restreamLabel ??
            (o.url.length > 27 ? o.url.slice(0, 25) + '...' + o.url.slice(-2) : o.url);
        const dupRefs = dupUrls.get(o.url);
        const dupWarnBtn = dupRefs
            ? `<span class="js-tooltip text-warning shrink-0 inline-flex" tabindex="0">${ICON_WARN}<div class="js-tooltip-content hidden">${dupTooltip('Duplicate destination — also used by:', dupRefs)}</div></span>`
            : '';
        const codeClass = dupRefs
            ? 'text-xs font-normal text-warning whitespace-nowrap'
            : 'text-xs font-normal opacity-60 whitespace-nowrap';
        inlineSink = `<code class="${codeClass}" title="${escapeHtml(o.url)}">${display}</code>${dupWarnBtn}`;
    }

    // Persistent "last error" notice, distinct from outStatus/outputIssues'
    // hasCurrentOutputError (which is about live dot color and resets on any
    // restart, including silent auto-retries). This line should hide stale
    // errors from before the user's last explicit start click, but keep
    // showing errors recorded during/after that start — including ones from
    // auto-retries in between — until the user clicks Stop. manualStartAtMs
    // only moves on an explicit start()/start-all, not on auto-retry, so it's
    // the right anchor for that comparison (see OutputStats.manualStartAtMs;
    // health.ts's patchOutputManualStart keeps it from lagging a click by a
    // full poll cycle).
    const lastErrorIsCurrent =
        o.lastError !== null &&
        o.lastErrorAt !== null &&
        (o.manualStartAtMs === null || o.lastErrorAt >= o.manualStartAtMs);
    const lastErrorLine =
        o.lastError && lastErrorIsCurrent
            ? (o.lastError
                  .split('\n')
                  .filter((l) => l.trim())
                  .slice(-1)[0] ?? '')
            : '';
    const lastErrorTs = o.lastErrorAt
        ? new Date(o.lastErrorAt).toLocaleTimeString(undefined, { hour12: false })
        : '';
    const lastErrorColor = 'text-error';
    const retryBadge =
        o.failures > 0
            ? `<span class="badge badge-sm badge-error gap-1 shrink-0" title="${o.failures} retr${o.failures === 1 ? 'y' : 'ies'}">${ICON_ITERATION_CW}${o.failures}</span>`
            : '';
    const lastErrorHtml =
        lastErrorLine && !isStopped
            ? `<div class="flex items-center gap-2 pl-2 mt-0.5 min-w-0">
                ${retryBadge}
                <span class="text-xs ${lastErrorColor} shrink-0">${lastErrorTs}</span>
                <span class="text-xs ${lastErrorColor} truncate">${escapeHtml(lastErrorLine)}</span>
           </div>`
            : '';
    const historyBtn = o.hasErrorHistory
        ? `<button class="btn btn-xs btn-ghost ${lastErrorColor}" data-action="error-info" data-out-id="${o.id}" title="Error history">${ICON_HISTORY}</button>`
        : '';
    const warningHtml = o.warningReason
        ? `<div class="flex items-center gap-2 pl-2 mt-0.5 min-w-0">
                <span class="text-warning shrink-0">${ICON_WARN}</span>
                <span class="text-xs text-warning truncate">${escapeHtml(o.warningReason)}</span>
           </div>`
        : '';

    const isPending = pendingOutputs.has(o.id);
    return `
    <div class="bg-base-100 px-3 py-2 border border-base-content/10 rounded-xl w-full min-w-0 space-y-0.5" data-output-card="${o.id}">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <div class="flex items-center gap-2 shrink-0 font-semibold">
                <div aria-label="status" class="status status-lg mx-1" style="background-color: ${statusHex}"></div>
                <button class="btn btn-xs ${isStopped ? 'btn-accent' : 'btn-accent btn-outline'}"
                    data-action="${isStopped ? 'start' : 'stop'}" data-out-id="${o.id}"${isPending ? ' disabled' : ''}>
                    ${isStopped ? 'Start' : 'Stop'}
                </button>
                <span class="js-output-drag-handle cursor-grab" draggable="true" title="Drag to reorder">${escapeHtml(o.name)}</span>
            </div>
            ${badges.join('')}
            ${inlineSink}
            <div class="flex items-center gap-1 ml-auto shrink-0">
                ${historyBtn}
                <button class="btn btn-xs btn-ghost" data-action="edit" data-out-id="${o.id}">${ICON_PENCIL}</button>
                <button class="btn btn-xs btn-ghost text-error ${isStopped ? '' : 'btn-disabled opacity-40'}"
                    data-action="delete" data-out-id="${o.id}">${ICON_TRASH}</button>
            </div>
        </div>
        ${warningHtml}
        ${lastErrorHtml}
    </div>`;
}

function renderOutputsList(pipeline: PipelineView): void {
    const listEl = document.getElementById('outputs-list');
    if (!listEl) return;
    if (draggingOutputEl) return; // preserve the DOM while a drag is in progress

    const hasActive = pipeline.outs.some((o) => o.desiredState !== 'stopped');
    const noStopped =
        pipeline.outs.length === 0 || pipeline.outs.every((o) => o.desiredState !== 'stopped');
    const allStopped =
        pipeline.outs.length === 0 || pipeline.outs.every((o) => o.desiredState === 'stopped');

    const pasteBtn = document.getElementById('outputs-paste-btn') as HTMLButtonElement | null;
    pasteBtn?.classList.toggle('btn-disabled', hasActive);
    pasteBtn?.classList.toggle('opacity-40', hasActive);
    if (pasteBtn) {
        pasteBtn.disabled = hasActive;
        pasteBtn.title = hasActive
            ? 'Stop all outputs before pasting'
            : 'Paste outputs from clipboard';
    }

    const startAllBtn = document.getElementById(
        'outputs-start-all-btn',
    ) as HTMLButtonElement | null;
    startAllBtn?.classList.toggle('btn-disabled', noStopped);
    startAllBtn?.classList.toggle('opacity-40', noStopped);
    if (startAllBtn) startAllBtn.disabled = noStopped;

    const stopAllBtn = document.getElementById('outputs-stop-all-btn') as HTMLButtonElement | null;
    stopAllBtn?.classList.toggle('btn-disabled', allStopped);
    stopAllBtn?.classList.toggle('opacity-40', allStopped);
    if (stopAllBtn) stopAllBtn.disabled = allStopped;

    if (pipeline.outs.length === 0) {
        listEl.innerHTML = '<p class="text-sm opacity-50">No outputs yet.</p>';
        return;
    }

    // Clear pending state once the output's actual status has settled into the
    // desired state (or for outputs that no longer exist, e.g. deleted).
    const presentIds = new Set(pipeline.outs.map((o) => o.id));
    for (const id of pendingOutputs.keys()) {
        if (!presentIds.has(id)) pendingOutputs.delete(id);
    }
    for (const o of pipeline.outs) {
        const action = pendingOutputs.get(o.id);
        if (!action) continue;
        const settled =
            (action === 'start' && o.desiredState === 'running') ||
            (action === 'stop' && o.desiredState === 'stopped');
        if (settled) pendingOutputs.delete(o.id);
    }

    // Build a URL → [{pipelineName, outputName}] map across all pipelines to detect duplicates.
    const urlRefs = new Map<string, DupRef[]>();
    for (const p of state.pipelines) {
        for (const o of p.outs) {
            if (o.url) {
                const list = urlRefs.get(o.url) ?? [];
                list.push({ pipelineName: p.name, outputName: o.name });
                urlRefs.set(o.url, list);
            }
        }
    }
    const dupUrls = new Map<string, DupRef[]>();
    for (const [url, refs] of urlRefs) {
        if (refs.length > 1) dupUrls.set(url, refs);
    }

    listEl.innerHTML = pipeline.outs
        .map((o) => renderOutputCard(o, pipeline.input, dupUrls))
        .join('');

    listEl.onclick = (e) => {
        const btn = (e.target as Element).closest('[data-action]') as HTMLButtonElement | null;
        if (!btn || btn.disabled || btn.classList.contains('btn-disabled')) return;
        const action = btn.dataset.action!;
        const outId = btn.dataset.outId!;
        if (action === 'start' || action === 'stop') {
            pendingOutputs.set(outId, action);
            btn.disabled = true;
        }
        void import('../features/editor.js').then((ed) => {
            if (action === 'start') ed.startOutput(pipeline.id, outId);
            else if (action === 'stop') ed.stopOutput(pipeline.id, outId);
            else if (action === 'edit') ed.openEditOutput(pipeline.id, outId);
            else if (action === 'delete') ed.confirmDeleteOutput(pipeline.id, outId);
            else if (action === 'error-info') ed.showOutputError(pipeline.id, outId);
        });
    };

    listEl.ondragstart = (e) => {
        const target = e.target as Element;
        const card = target.closest('[data-output-card]') as HTMLElement | null;
        if (!target.closest('.js-output-drag-handle') || !card) {
            e.preventDefault();
            return;
        }
        draggingOutputEl = card;
        card.classList.add('opacity-40');
        e.dataTransfer!.effectAllowed = 'move';
        e.dataTransfer!.setData('text/plain', card.dataset.outputCard!);
        e.dataTransfer!.setDragImage(card, 12, 12);
    };

    listEl.ondragover = (e) => {
        if (!draggingOutputEl) return;
        e.preventDefault();
        e.dataTransfer!.dropEffect = 'move';
        const overCard = (e.target as Element).closest('[data-output-card]') as HTMLElement | null;
        if (!overCard || overCard === draggingOutputEl) return;
        const rect = overCard.getBoundingClientRect();
        const before = e.clientY < rect.top + rect.height / 2;
        overCard.parentElement?.insertBefore(
            draggingOutputEl,
            before ? overCard : overCard.nextElementSibling,
        );
    };

    listEl.ondrop = (e) => e.preventDefault();

    listEl.ondragend = () => {
        if (!draggingOutputEl) return;
        draggingOutputEl.classList.remove('opacity-40');
        draggingOutputEl = null;
        const order = Array.from(listEl.querySelectorAll('[data-output-card]')).map(
            (el) => (el as HTMLElement).dataset.outputCard!,
        );
        void persistOutputOrder(pipeline.id, order);
    };
}

// ── Preview ───────────────────────────────────────────

function renderPreview(pipeline: PipelineView): void {
    const section = document.getElementById('preview-section');
    if (!section) return;

    if (!pipeline.input.live) {
        section.classList.add('hidden');
        if (getPreviewPipelineId() === pipeline.id) stopCurrentPreview();
        return;
    }

    section.classList.remove('hidden');

    const activePid = getPreviewPipelineId();
    if (activePid && activePid !== pipeline.id) stopCurrentPreview();

    populatePreviewTrackSelect(pipeline);

    syncPreviewControls(getPreviewPipelineId() === pipeline.id);
}

// ── Metrics (navbar) ──────────────────────────────────

export function renderMetrics(): void {
    const m = state.metrics;
    const cpu = m.cpu ?? null;
    const ram = m.ram ?? null;
    const disk = m.disk ?? null;
    const net = m.net ?? null;
    const uptimeSecs = m.uptimeSeconds ?? null;
    const cpuPercent = cpu ? cpu.percent : null;
    const ramPercent = ram ? Math.round((ram.usedBytes / ram.totalBytes) * 100) : null;
    const diskPercent = disk ? Math.round((disk.usedBytes / disk.totalBytes) * 100) : null;

    setInnerText(
        'navbar-uptime',
        uptimeSecs !== null ? `Up ${formatUptime(uptimeSecs * 1000)}` : 'Up —',
    );
    setInnerText('navbar-cpu-value', cpu ? `${cpu.cores}c CPU: ${cpuPercent}%` : 'CPU —');
    setMetricSeverity('navbar-cpu-value', cpuPercent);
    setInnerText(
        'navbar-ram-value',
        ram ? `${formatBytesCompact(ram.totalBytes)} RAM: ${ramPercent}%` : 'RAM —',
    );
    setMetricSeverity('navbar-ram-value', ramPercent);
    setInnerText(
        'navbar-disk-value',
        disk ? `${formatBytesCompact(disk.totalBytes)} Disk: ${diskPercent}%` : 'Disk —',
    );
    setMetricSeverity('navbar-disk-value', diskPercent);
    setInnerText(
        'navbar-net-rx',
        net ? `↓ ${((net.rxBytesPerSec * 8) / 1_000_000).toFixed(1)} Mb/s` : '↓ —',
    );
    setInnerText(
        'navbar-net-tx',
        net ? `↑ ${((net.txBytesPerSec * 8) / 1_000_000).toFixed(1)} Mb/s` : '↑ —',
    );
}

// ── Entry point ───────────────────────────────────────

export function renderPipelines(): void {
    const selectedId = getUrlParam('p');
    const view = getUrlParam('view');
    const hostsBtn = document.getElementById('host-connections-nav-btn');
    hostsBtn?.classList.toggle('btn-active', view === 'hosts');
    const logsBtn = document.getElementById('srs-logs-nav-btn');
    logsBtn?.classList.toggle('btn-active', view === 'logs');
    const settingsBtn = document.getElementById('settings-nav-btn');
    settingsBtn?.classList.toggle('btn-active', view === 'settings');
    renderPipelineList();
    renderPipelineInfo(selectedId);
}

// ── Hover tooltips ────────────────────────────────────
//
// Status circles live inside columns with overflow-y-auto (for scrolling long
// pipeline/output lists), which clips any absolutely-positioned popup that
// tries to overflow the column's edge — the popup would show as scroll-clipped
// or blend into the column background instead of floating over neighboring
// columns. Rather than positioning content in place, we reparent the hovered
// element's `.js-tooltip-content` into a single fixed-position portal (see
// #hover-tooltip in index.html) that lives outside all scroll containers, and
// position that portal from the trigger's viewport rect. Trigger elements are
// re-rendered constantly (innerHTML swaps), so this is wired once via
// delegation on `document` rather than per-element listeners.
function initHoverTooltips(): void {
    const portal = document.getElementById('hover-tooltip');
    if (!portal) return;
    let activeTrigger: Element | null = null;

    const hide = (): void => {
        portal.classList.add('hidden');
        activeTrigger = null;
    };

    const show = (trigger: Element, content: Element): void => {
        if (!content.innerHTML.trim()) return;
        portal.innerHTML = content.innerHTML;
        portal.classList.remove('hidden');
        const rect = trigger.getBoundingClientRect();
        const pw = portal.offsetWidth;
        const ph = portal.offsetHeight;
        let left = rect.right + 8;
        if (left + pw > window.innerWidth - 8) left = rect.left - pw - 8;
        left = Math.max(8, left);
        const top = Math.max(
            8,
            Math.min(rect.top + rect.height / 2 - ph / 2, window.innerHeight - ph - 8),
        );
        portal.style.left = `${left}px`;
        portal.style.top = `${top}px`;
        activeTrigger = trigger;
    };

    document.addEventListener('mouseover', (e) => {
        const trigger = (e.target as Element | null)?.closest?.('.js-tooltip');
        if (!trigger || trigger === activeTrigger) return;
        const content = trigger.querySelector(':scope > .js-tooltip-content');
        if (!content) return;
        show(trigger, content);
    });

    document.addEventListener('mouseout', (e) => {
        const trigger = (e.target as Element | null)?.closest?.('.js-tooltip');
        if (!trigger || trigger !== activeTrigger) return;
        const related = (e as MouseEvent).relatedTarget as Node | null;
        if (related && trigger.contains(related)) return;
        hide();
    });

    // Pipeline/output lists re-render on every poll by swapping innerHTML,
    // which can detach the currently-hovered trigger without ever firing a
    // mouseout — leaving the portal stuck open with stale content. Catch that
    // by checking connectivity whenever the DOM churns.
    new MutationObserver(() => {
        if (activeTrigger && !activeTrigger.isConnected) hide();
    }).observe(document.body, { childList: true, subtree: true });
}

initHoverTooltips();
