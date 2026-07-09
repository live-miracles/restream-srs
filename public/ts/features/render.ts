import {
    setInnerText,
    escapeHtml,
    formatBitrate,
    formatBytesCompact,
    getUrlParam,
    maskStreamKey,
    maskSecret,
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
    VideoInfo,
} from '../types.js';
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
type BondingIndicator = {
    leftColor: string;
    rightColor: string;
    title: string;
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

function formatCompactCount(n: number): string {
    if (!Number.isFinite(n)) return '0';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
    return String(Math.round(n));
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

function outStatus(o: OutputView, inputLive: boolean): OutStatus {
    if (o.desiredState === 'stopped') return 'off';
    if (o.status === 'failed') return 'error';
    if (o.status === 'running') {
        if (!inputLive) return 'error';
        if (o.warningReason !== null) return 'warn';
        if (o.bitrateKbps !== null && o.bitrateKbps >= LOW_BITRATE_KBPS) return 'good';
        if (o.bitrateKbps === null && o.lastError !== null) return 'error';
        return 'warn';
    }
    // status === 'stopped' but desiredState === 'running': between retries
    return o.lastError !== null ? 'error' : 'warn';
}

function inputStatus(input: InputHealth): InputStatus {
    if (input.live) {
        return input.recvBitrateKbps !== null && input.recvBitrateKbps < LOW_BITRATE_KBPS
            ? 'warn'
            : 'good';
    }
    if (input.connected && input.mediaOk === false) return 'error';
    if (input.connected) return 'warn';
    return 'off';
}

function inputStatusColor(input: InputHealth): string {
    const st = inputStatus(input);
    if (st === 'good') return STATUS_COLOR_GOOD;
    if (st === 'warn') return STATUS_COLOR_WARN;
    if (st === 'error') return STATUS_COLOR_ERROR;
    return STATUS_COLOR_OFF;
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
    video: Pick<VideoInfo, 'codec' | 'width' | 'height' | 'fps' | 'fieldOrder'> | null;
    audio: Pick<AudioInfo, 'codec' | 'channel' | 'sample_rate'> | null;
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
    const video = codec
        ? {
              codec,
              width: resolution?.width ?? 0,
              height: resolution?.height ?? 0,
              fps,
              fieldOrder,
          }
        : null;

    const firstSink = output.sinks[0] ?? null;
    if (!firstSink) return { video, audio: null };

    if (!firstSink.url.startsWith('srt://')) {
        return {
            video,
            audio: {
                codec: 'aac',
                channel: 2,
                sample_rate: 48000,
            },
        };
    }

    const track = selectedAudioTrack(input.audioTracks, firstSink.audioEncoding);
    if (track) {
        return {
            video,
            audio: {
                codec: track.codec,
                channel: track.channels,
                sample_rate: track.sampleRate,
            },
        };
    }

    return { video, audio: input.audio };
}

function brokenLegCount(pipeline: PipelineView): number {
    return pipeline.srtBonding.legs.filter((leg) => leg.state === 'broken').length;
}

function legsDegradedSuffix(pipeline: PipelineView): string {
    const broken = brokenLegCount(pipeline);
    const total = pipeline.srtBonding.legs.length;
    return broken > 0 ? ` (${broken}/${total} legs down)` : '';
}

function getBondingIndicator(
    pipeline: PipelineView,
    relayProcessRunning: boolean,
): BondingIndicator {
    const { srtBonding } = pipeline;
    const hasRecentInputFlow = relayHasRecentInputFlow(pipeline);
    const hasRecentOutputFlow = relayHasRecentOutputFlow(pipeline);
    const hasForwardedData = srtBonding.forwardedPackets > 0;
    const acceptedBySrs = isRelayAcceptedBySrs(pipeline);
    const publishConflict = hasRelayPublishConflict(pipeline);
    const legsDegraded = brokenLegCount(pipeline) > 0;

    if (!relayProcessRunning) {
        return {
            leftColor: STATUS_COLOR_OFF,
            rightColor: STATUS_COLOR_OFF,
            title: 'SRT bonding relay is not running; bonded input unavailable',
        };
    }

    if (
        srtBonding.inputActive &&
        srtBonding.outputConnected &&
        acceptedBySrs &&
        hasRecentInputFlow &&
        hasRecentOutputFlow
    ) {
        return {
            leftColor: legsDegraded ? STATUS_COLOR_WARN : STATUS_COLOR_GOOD,
            rightColor: STATUS_COLOR_GOOD,
            title:
                `Bonded SRT input active and forwarding to downstream output` +
                (legsDegraded ? legsDegradedSuffix(pipeline) + ' — redundancy reduced' : ''),
        };
    }

    if (publishConflict) {
        const conflictTitle = srtBonding.localSrtPublisherConflict
            ? 'Bonded SRT input active, but a local pipeline output is already publishing to this stream key in SRS'
            : 'Bonded SRT input active, but SRS is already using another publisher for this stream key';
        return {
            leftColor: hasRecentInputFlow ? STATUS_COLOR_GOOD : STATUS_COLOR_WARN,
            rightColor: STATUS_COLOR_ERROR,
            title: conflictTitle,
        };
    }

    if (srtBonding.inputActive && srtBonding.outputConnected) {
        return {
            leftColor: hasRecentInputFlow ? STATUS_COLOR_GOOD : STATUS_COLOR_WARN,
            rightColor: STATUS_COLOR_WARN,
            title: !acceptedBySrs
                ? 'Bonded SRT input connected, but SRS has not reported it as the active pipeline input'
                : hasForwardedData
                  ? 'Bonded SRT input connected, but media forwarding has stalled'
                  : 'Bonded SRT input connected, but no media has been received yet',
        };
    }

    if (srtBonding.inputActive) {
        const reason = srtBonding.lastError
            ? `: ${srtBonding.lastError}`
            : srtBonding.retryFailures > 0
              ? ` (${srtBonding.retryFailures} retries)`
              : '';
        return {
            leftColor: hasRecentInputFlow ? STATUS_COLOR_GOOD : STATUS_COLOR_WARN,
            rightColor: STATUS_COLOR_ERROR,
            title: `Bonded SRT input active, relay output reconnecting${reason}`,
        };
    }

    return {
        leftColor: STATUS_COLOR_OFF,
        rightColor: STATUS_COLOR_OFF,
        title: 'No bonded SRT input for this stream key',
    };
}

function relayHasRecentInputFlow(pipeline: PipelineView): boolean {
    return (
        pipeline.srtBonding.lastInputPacketAt != null &&
        Date.now() - pipeline.srtBonding.lastInputPacketAt <= RELAY_FLOW_STALE_MS
    );
}

function relayHasRecentOutputFlow(pipeline: PipelineView): boolean {
    return (
        pipeline.srtBonding.lastPacketAt != null &&
        Date.now() - pipeline.srtBonding.lastPacketAt <= RELAY_FLOW_STALE_MS
    );
}

function isRelayAcceptedBySrs(pipeline: PipelineView): boolean {
    if (pipeline.srtBonding.acceptedBySrs !== undefined) {
        return pipeline.srtBonding.acceptedBySrs;
    }

    if (
        !pipeline.srtBonding.inputActive ||
        !pipeline.srtBonding.outputConnected ||
        !pipeline.input.live ||
        !pipeline.input.isSrt
    ) {
        return false;
    }

    // The relay publishes into local SRS from loopback. If SRS client metadata is
    // unavailable, fall back to protocol-level inference rather than showing a
    // false error during a transient clients API failure.
    return pipeline.input.publisherIp == null || isLoopbackIp(pipeline.input.publisherIp);
}

function hasRelayPublishConflict(pipeline: PipelineView): boolean {
    if (pipeline.srtBonding.publishConflict !== undefined) {
        return pipeline.srtBonding.publishConflict;
    }

    if (!pipeline.srtBonding.inputActive || !pipeline.input.connected) return false;
    if (!pipeline.input.isSrt) return true;
    return pipeline.input.publisherIp != null && !isLoopbackIp(pipeline.input.publisherIp);
}

function isLoopbackIp(ip: string): boolean {
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function relayInputStatus(pipeline: PipelineView, relayProcessRunning: boolean): RelayFlowStatus {
    if (!relayProcessRunning) return 'off';
    if (!pipeline.srtBonding.inputActive) return 'off';
    if (!relayHasRecentInputFlow(pipeline)) return 'warn';
    return brokenLegCount(pipeline) > 0 ? 'warn' : 'good';
}

function relayOutputStatus(pipeline: PipelineView, relayProcessRunning: boolean): RelayFlowStatus {
    if (!relayProcessRunning) return 'off';
    if (!pipeline.srtBonding.inputActive) return 'off';
    if (hasRelayPublishConflict(pipeline)) return 'error';
    if (!pipeline.srtBonding.outputConnected) return 'error';
    if (!isRelayAcceptedBySrs(pipeline)) return 'warn';
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

function renderLegsCompact(legs: SrtBondingLeg[]): string {
    if (legs.length === 0) return '<span class="opacity-50">—</span>';
    return `<span class="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">${legs
        .map((leg) => {
            const color = legStateDotColor(leg.state);
            return (
                `<span class="inline-flex items-center gap-1" title="${leg.ip}:${leg.port} — ${leg.state}">` +
                `<span class="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style="background:${color}"></span>` +
                `<span class="font-mono text-xs">${leg.ip}</span>` +
                `</span>`
            );
        })
        .join('')}</span>`;
}

function relayStatusBadge(
    status: RelayFlowStatus,
    labels: Record<RelayFlowStatus, string>,
): string {
    if (status === 'good')
        return `<span class="badge badge-sm badge-success">${labels.good}</span>`;
    if (status === 'warn')
        return `<span class="badge badge-sm badge-warning">${labels.warn}</span>`;
    if (status === 'error')
        return `<span class="badge badge-sm badge-error">${labels.error}</span>`;
    return `<span class="badge badge-sm badge-neutral">${labels.off}</span>`;
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

    const inputsOn = state.pipelines.filter((p) => inputStatus(p.input) === 'good').length;
    const inputsWarn = state.pipelines.filter((p) => inputStatus(p.input) === 'warn').length;
    const inputsFailed = state.pipelines.filter((p) => inputStatus(p.input) === 'error').length;
    const totalOutputs = state.pipelines.reduce((s, p) => s + p.outs.length, 0);
    const outputsOn = state.pipelines.reduce(
        (s, p) => s + p.outs.filter((o) => outStatus(o, p.input.live) === 'good').length,
        0,
    );
    const outputsWarn = state.pipelines.reduce(
        (s, p) => s + p.outs.filter((o) => outStatus(o, p.input.live) === 'warn').length,
        0,
    );
    const outputsFailed = state.pipelines.reduce(
        (s, p) => s + p.outs.filter((o) => outStatus(o, p.input.live) === 'error').length,
        0,
    );
    const outputsOff = state.pipelines.reduce(
        (s, p) => s + p.outs.filter((o) => o.desiredState === 'stopped').length,
        0,
    );

    setInnerText('pipe-cnt', state.pipelines.length);
    setInnerText('pipe-oks', inputsOn);
    setInnerText('pipe-warns', inputsWarn + inputsFailed);
    setInnerText('pipe-offs', state.pipelines.filter((p) => inputStatus(p.input) === 'off').length);
    setInnerText('out-cnt', totalOutputs);
    setInnerText('out-oks', outputsOn - outputsWarn);
    setInnerText('out-warns', outputsWarn);
    setInnerText('out-errors', outputsFailed);
    setInnerText('out-offs', outputsOff);

    const selectedId = getUrlParam('p');
    const relayProcessRunning = state.health.srtRelay?.status === 'running';

    listEl.innerHTML = state.pipelines
        .map((p) => {
            const outGood = p.outs.filter((o) => outStatus(o, p.input.live) === 'good').length;
            const outWarn = p.outs.filter((o) => outStatus(o, p.input.live) === 'warn').length;
            const outFailed = p.outs.filter((o) => outStatus(o, p.input.live) === 'error').length;
            const outOff = p.outs.filter((o) => outStatus(o, p.input.live) === 'off').length;

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
            const inputStateForTitle = inputStatus(p.input);
            const inputTitle = p.input.live
                ? inputStateForTitle === 'warn'
                    ? 'Input bitrate is below warning threshold.'
                    : ''
                : inputStateForTitle === 'warn' || inputStateForTitle === 'error'
                  ? [inputStatusMessage(p.input), formatMediaProbeStatus(p.input)]
                        .filter(Boolean)
                        .join(' ')
                  : '';

            const badge = (n: number, cls: string) =>
                n > 0 ? `<div class="badge badge-sm ${cls} px-2">${n}</div>` : '';
            const uptimeSpan =
                p.input.live && p.input.uptimeMs !== null
                    ? `<span class="font-mono text-xs opacity-60 shrink-0">${formatUptime(p.input.uptimeMs)}</span>`
                    : '';
            const inputTypeBadge = p.input.connected
                ? `<span class="badge badge-sm badge-outline shrink-0">${isRelayAcceptedBySrs(p) ? 'Relay' : p.input.isSrt ? 'SRT' : 'RTMP'}</span>`
                : '';

            return `<li>
            <div class="flex items-center gap-2 ${selected} cursor-pointer js-select-pipeline" data-id="${p.id}" title="${escapeHtml(inputTitle)}">
                <div class="rounded-box h-5 w-5 shrink-0" style="background:linear-gradient(90deg,${inColor},${inColor} 45%,#242933 45%,#242933 55%,${outColor} 55%)"></div>
                ${badge(outGood, 'badge-success')}
                ${badge(outWarn, 'badge-warning')}
                ${badge(outFailed, 'badge-error')}
                ${badge(outOff, 'badge-ghost')}
                <a class="truncate min-w-0">${escapeHtml(p.name)}</a>
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

function renderInputStats(input: InputHealth): string {
    if (!input.connected) return '';
    if (!input.live) {
        const probeStatus = formatMediaProbeStatus(input);
        const message = inputStatusMessage(input);
        const toneClass = input.mediaError ? 'text-error' : 'text-warning';
        return `<p class="text-xs ${toneClass} mt-2">${escapeHtml(message)}${probeStatus ? ` <span class="opacity-60">${escapeHtml(probeStatus)}</span>` : ''}</p>`;
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
            ${compactStat('In', formatBitrate(input.recvBitrateKbps))}
            ${compactStat('Codec', v.codec)}
            ${compactStat('Size', v.width && v.height ? `${v.width}×${v.height}` : null)}
            ${compactStat('FPS', v.fps != null ? v.fps : null)}
            ${compactStat('Scan', fmtFieldOrder(v.fieldOrder))}
            ${compactStat('Prof', v.profile || null)}
            ${compactStat('Lvl', v.level || null)}
        </div>`
                : input.isSrt
                  ? `<p class="text-xs opacity-50 mt-2">Codec info is still being probed — this may take a moment.</p>`
                  : ''
        }
        ${
            input.audioTracks.length > 0
                ? `
        <h3 class="mt-3 text-sm font-semibold opacity-60">Audio <span class="font-normal">(${input.audioTracks.length} track${input.audioTracks.length > 1 ? 's' : ''})</span></h3>
        <table class="table table-xs mt-1">
            <thead><tr><th>#</th><th>Codec</th><th>Ch</th><th>Sample Rate</th><th>Profile</th>${input.audioTracks.some((t) => t.language || t.title) ? '<th>Label</th>' : ''}</tr></thead>
            <tbody>
                ${input.audioTracks
                    .map((t) => {
                        const label = escapeHtml([t.language, t.title].filter(Boolean).join(' — '));
                        return `<tr>
                        <td class="font-mono">${t.index + 1}</td>
                        <td>${t.codec || '—'}</td>
                        <td>${t.channels || '—'}</td>
                        <td>${t.sampleRate ? `${(t.sampleRate / 1000).toFixed(1)} kHz` : '—'}</td>
                        <td>${t.profile || '—'}</td>
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
                {
                    label: 'Sample Rate',
                    value: a.sample_rate ? `${(a.sample_rate / 1000).toFixed(1)} kHz` : null,
                },
                { label: 'Channels', value: a.channel },
                { label: 'Profile', value: a.profile || null },
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
        const d = new Date(ts);
        ctx.fillStyle = labelColor;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(
            `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`,
            x,
            H - mB + 5,
        );
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
        return `${Number.isInteger(k) ? k : k.toFixed(1)} kHz`;
    };

    const td = (val: string | number | null | undefined): string =>
        `<td class="font-mono text-xs">${val ?? '—'}</td>`;

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
            p.srtBonding.recvPacketsTotal > 0 ||
            p.srtBonding.recvUniquePacketsTotal > 0 ||
            p.srtBonding.retransTotal > 0 ||
            p.srtBonding.recvLossTotal > 0 ||
            p.srtBonding.recvDropTotal > 0,
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
            const rxPackets = p.srtBonding.recvUniquePacketsTotal || p.srtBonding.recvPacketsTotal;
            const fmtRtt = (ms: number | null): string =>
                ms != null ? `${ms.toFixed(ms >= 10 ? 0 : 1)} ms` : '—';

            relayRows += `<tr class="hover cursor-pointer js-overview-select" data-id="${p.id}" ${statusBg(rowError, rowWarn)}>
                <td class="overview-name-col font-semibold">${escapeHtml(p.name)}</td>
                <td>${relayStatusBadge(inputSt, { good: 'Active', warn: 'Stalled', error: 'Error', off: 'Idle' })}</td>
                <td>${relayStatusBadge(outputSt, { good: 'Forwarding', warn: 'Pending', error: 'Not accepted', off: 'Idle' })}</td>
                <td>${renderLegsCompact(p.srtBonding.legs)}</td>
                <td class="font-mono text-xs">${formatCompactCount(rxPackets)}</td>
                <td class="font-mono text-xs">${formatCompactCount(p.srtBonding.forwardedPackets)}</td>
                <td class="font-mono text-xs">${formatCompactCount(p.srtBonding.retransTotal)}</td>
                <td class="font-mono text-xs">${formatCompactCount(p.srtBonding.recvLossTotal)}</td>
                <td class="font-mono text-xs">${formatCompactCount(p.srtBonding.recvDropTotal)}</td>
                <td class="font-mono text-xs">${formatBytesCompact(p.srtBonding.forwardedBytes)}</td>
                <td class="font-mono text-xs">${fmtRtt(p.srtBonding.inputRttMs)} / ${fmtRtt(p.srtBonding.outputRttMs)}</td>
            </tr>`;
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
        inputRows = `<tr><td colspan="12" class="py-4 text-center opacity-50">No pipelines yet.</td></tr>`;
    } else {
        for (const p of state.pipelines) {
            const inp = p.input;
            const st = inputStatus(inp);
            const isWarn = st === 'warn';
            const isError = st === 'error';
            if (problemsOnly && !isWarn && !isError) continue;
            if (activeOnly && isOffline(st)) continue;
            const badge =
                st === 'off'
                    ? `<span class="badge badge-sm badge-neutral">Offline</span>`
                    : st === 'error'
                      ? `<span class="badge badge-sm badge-error" title="${escapeHtml([inputStatusMessage(inp), formatMediaProbeStatus(inp)].filter(Boolean).join(' '))}">Media Error</span>`
                      : st === 'warn'
                        ? `<span class="badge badge-sm badge-warning" title="${escapeHtml(inp.live ? 'Input bitrate is below warning threshold.' : [inputStatusMessage(inp), formatMediaProbeStatus(inp)].filter(Boolean).join(' '))}">${inp.live ? 'Low Bitrate' : 'Probing'}</span>`
                        : `<span class="badge badge-sm badge-success">Live</span>`;
            const protocolLabel = isRelayAcceptedBySrs(p) ? 'Relay' : inp.isSrt ? 'SRT' : 'RTMP';
            const audioTracks = inp.audioTracks.length > 0 ? inp.audioTracks : null;
            const rowspan =
                audioTracks && audioTracks.length > 1 ? ` rowspan="${audioTracks.length}"` : '';
            const rowAttr = `class="hover cursor-pointer js-overview-select" data-id="${p.id}" ${statusBg(isError, isWarn)}`;
            const sharedCells = `
                <td class="overview-name-col font-semibold"${rowspan}>${escapeHtml(p.name)}</td>
                <td${rowspan}>${badge}</td>
                <td class="font-mono text-xs"${rowspan}>${inp.live ? formatUptime(inp.uptimeMs) : '—'}</td>
                <td class="font-mono text-xs"${rowspan}>${inp.connected ? formatBitrate(inp.recvBitrateKbps) : '—'}</td>
                <td class="font-mono text-xs"${rowspan}>${inp.connected ? protocolLabel : '—'}</td>
                <td class="font-mono text-xs"${rowspan}>${inp.video?.codec ?? '—'}</td>
                <td class="font-mono text-xs"${rowspan}>${inp.video ? `${inp.video.width}×${inp.video.height}` : '—'}</td>
                <td class="font-mono text-xs"${rowspan}>${inp.video?.fps ?? '—'}</td>
                <td class="font-mono text-xs"${rowspan}>${fmtFieldOrder(inp.video?.fieldOrder) ?? '—'}</td>`;
            if (audioTracks && audioTracks.length > 1) {
                inputRows += audioTracks
                    .map((t, i) => {
                        const label =
                            t.title || t.language
                                ? ` <span class="opacity-40 text-xs">${escapeHtml([t.language, t.title].filter(Boolean).join(' '))}</span>`
                                : '';
                        return `<tr ${rowAttr}>${i === 0 ? sharedCells : ''}
                        <td class="font-mono text-xs">${t.codec || '—'}${label}</td>
                        <td class="font-mono text-xs">${t.channels || '—'}</td>
                        <td class="font-mono text-xs">${t.sampleRate ? fmtHz(t.sampleRate) : '—'}</td>
                    </tr>`;
                    })
                    .join('');
            } else {
                const t = audioTracks?.[0] ?? null;
                inputRows += `<tr ${rowAttr}>${sharedCells}
                    ${td(t ? t.codec : inp.audio?.codec)}
                    ${td(t ? t.channels : inp.audio?.channel)}
                    ${td(t ? fmtHz(t.sampleRate) : fmtHz(inp.audio?.sample_rate))}
                </tr>`;
            }
        }
        if (problemsOnly && inputRows === '') {
            inputRows = `<tr><td colspan="12" class="py-4 text-center opacity-50">No input issues.</td></tr>`;
        } else if (activeOnly && inputRows === '') {
            inputRows = `<tr><td colspan="12" class="py-4 text-center opacity-50">No active inputs.</td></tr>`;
        }
    }

    // ── Outputs ───────────────────────────────────────────
    const outputProblemCount = state.pipelines.reduce(
        (s, p) => s + p.outs.filter((o) => isProblem(outStatus(o, p.input.live))).length,
        0,
    );
    const outputActiveCount = state.pipelines.reduce(
        (s, p) => s + p.outs.filter((o) => !isOffline(outStatus(o, p.input.live))).length,
        0,
    );
    let outputRows = '';
    if (totalOuts === 0) {
        outputRows = `<tr><td colspan="12" class="py-4 text-center opacity-50">No outputs yet.</td></tr>`;
    } else {
        for (const p of state.pipelines) {
            for (const o of p.outs) {
                const isRunning = o.status === 'running';
                const st = outStatus(o, p.input.live);
                if (problemsOnly && !isProblem(st)) continue;
                if (activeOnly && isOffline(st)) continue;
                const retryPrefix =
                    st === 'error' && o.failures > 0 ? `${ICON_ITERATION_CW}${o.failures} ` : '';
                const badge =
                    st === 'off'
                        ? `<span class="badge badge-sm badge-neutral">Stopped</span>`
                        : st === 'good'
                          ? `<span class="badge badge-sm badge-success">Running</span>`
                          : st === 'warn'
                            ? o.warningReason
                                ? `<span class="badge badge-sm badge-warning" title="${escapeHtml(o.warningReason)}">Warning</span>`
                                : o.bitrateKbps === null
                                  ? `<span class="badge badge-sm badge-warning">No Output</span>`
                                  : `<span class="badge badge-sm badge-warning">Low Bitrate</span>`
                            : isRunning
                              ? `<span class="badge badge-sm badge-error gap-1">${retryPrefix}No Input</span>`
                              : `<span class="badge badge-sm badge-error gap-1">${retryPrefix}Failed</span>`;

                const isOn = o.status === 'running';
                const media = isOn ? deriveOutputMedia(p.input, o) : null;
                const outUptimeMs = o.startedAtMs !== null ? Date.now() - o.startedAtMs : null;
                outputRows += `<tr class="hover cursor-pointer js-overview-select" data-id="${p.id}" ${statusBg(st === 'error', st === 'warn')}>
                    <td class="overview-name-col"><span class="opacity-40 text-xs">${escapeHtml(p.name)} ·</span> ${escapeHtml(o.name)}</td>
                    <td>${badge}</td>
                    <td class="font-mono text-xs">${outUptimeMs !== null ? formatUptime(outUptimeMs) : '—'}</td>
                    ${td(formatBitrate(o.bitrateKbps))}
                    ${td(isOn ? o.videoEncoding : null)}
                    ${td(media?.video?.codec)}
                    ${td(media?.video?.width && media.video.height ? `${media.video.width}×${media.video.height}` : null)}
                    ${td(media?.video?.fps)}
                    ${td(fmtFieldOrder(media?.video?.fieldOrder))}
                    ${td(media?.audio?.codec)}
                    ${td(media?.audio?.channel)}
                    ${td(fmtHz(media?.audio?.sample_rate))}
                </tr>`;
            }
        }
        if (problemsOnly && outputRows === '') {
            outputRows = `<tr><td colspan="12" class="py-4 text-center opacity-50">No output issues.</td></tr>`;
        } else if (activeOnly && outputRows === '') {
            outputRows = `<tr><td colspan="12" class="py-4 text-center opacity-50">No active outputs.</td></tr>`;
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
            <table class="table table-sm">
                ${thead(['Pipeline', 'Input', 'Output', 'Legs', 'Rx', 'Fwd', 'Rexmit', 'Loss', 'Drop', 'Bytes', 'In/Out RTT'])}
                <tbody>${relayRows}</tbody>
            </table>
        </div>
        <h2 class="mb-2 text-lg font-bold">Inputs <span class="badge badge-neutral badge-sm ml-1">${state.pipelines.length}</span></h2>
        <div class="overflow-x-auto mb-6">
            <table class="table table-sm">
                ${thead(['Pipeline', 'Status', 'Uptime', 'Bitrate', 'Proto', 'V.Codec', 'Resolution', 'FPS', 'Scan', 'A.Codec', 'Ch', 'Sample Rate'])}
                <tbody>${inputRows}</tbody>
            </table>
        </div>
        <h2 class="mb-2 text-lg font-bold">Outputs <span class="badge badge-neutral badge-sm ml-1">${totalOuts}</span></h2>
        <div class="overflow-x-auto">
            <table class="table table-sm">
                ${thead(['Pipeline · Output', 'Status', 'Uptime', 'Bitrate', 'Encoding', 'V.Codec', 'Resolution', 'FPS', 'Scan', 'A.Codec', 'Ch', 'Sample Rate'])}
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

    overviewEl.onclick = (e) => {
        const row = (e.target as Element).closest('.js-overview-select') as HTMLElement | null;
        if (row?.dataset.id) window.selectPipeline(row.dataset.id);
    };
}

function drawProbeChart(
    id: string,
    samples: Array<{ ts: number; ok: boolean; latencyMs: number | null }>,
    windowStart: number,
    windowEnd: number,
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
    const toRgba = (c: string, a: number) =>
        c.startsWith('rgb(')
            ? c.replace('rgb(', 'rgba(').replace(')', `, ${a})`)
            : `rgba(128,128,128,${a})`;
    const gridColor = toRgba(base, 0.18);
    const labelColor = toRgba(base, 0.65);
    const okColor = '#22c55e';
    const failColor = '#ef4444';

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

    for (const sample of samples) {
        if (sample.ok) continue;
        const x = xFor(sample.ts);
        ctx.beginPath();
        ctx.moveTo(x, m.top);
        ctx.lineTo(x, displayH - m.bottom);
        ctx.strokeStyle = toRgba(failColor, 0.85);
        ctx.lineWidth = 1;
        ctx.stroke();
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

    if (targets.length === 0) {
        hostsCol.innerHTML = `
            <div class="rounded-xl border border-dashed border-base-content/15 p-8 text-center">
                <h2 class="text-lg font-semibold">Probe History Not Loaded</h2>
                <p class="mt-2 text-sm opacity-60">Host targets are configured, but probe history is fetched only when you click refresh.</p>
                <button
                    type="button"
                    class="btn btn-sm btn-outline mt-4 gap-2"
                    onclick="refreshHostConnectionsBtn()"
                    title="Refresh host connections">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" class="block h-4 w-4 shrink-0 fill-current" aria-hidden="true">
                        <path d="M10 3a7 7 0 0 1 6.56 4.57.75.75 0 1 1-1.4.53A5.5 5.5 0 1 0 14.5 13H12a.75.75 0 0 1 0-1.5h4.25A.75.75 0 0 1 17 12.25v4.25a.75.75 0 0 1-1.5 0v-1.77A7 7 0 1 1 10 3Z" />
                    </svg>
                    Load Probe History
                </button>
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

    const rows = targets
        .map((entry) => {
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
            const failureRate =
                entry.last24hSampleCount > 0
                    ? Math.round((entry.last24hFailureCount / entry.last24hSampleCount) * 100)
                    : 0;
            const lastSeen = latest
                ? new Date(latest.ts).toLocaleTimeString(undefined, { hour12: false })
                : '—';
            return `<tr>
                <td class="font-semibold">${escapeHtml(entry.target.label)}</td>
                <td class="font-mono text-xs">${escapeHtml(entry.target.host)}:${entry.target.port}</td>
                <td>${latestStatus}</td>
                <td class="font-mono text-xs">${latest?.latencyMs != null ? `${Math.round(latest.latencyMs)} ms` : '—'}</td>
                <td class="font-mono text-xs">${highestLatency != null ? `${Math.round(highestLatency)} ms` : '—'}</td>
                <td class="font-mono text-xs">${entry.averageLatencyMs != null ? `${Math.round(entry.averageLatencyMs)} ms` : '—'}</td>
                <td class="font-mono text-xs">${failureRate}%</td>
                <td class="font-mono text-xs">${lastSeen}</td>
                <td class="font-mono text-xs">${latest?.resolvedAddress ?? '—'}</td>
            </tr>`;
        })
        .join('');

    const cards = targets
        .map((entry) => {
            const latest = entry.latestSample;
            const errorText =
                latest && !latest.ok ? (latest.error ?? 'probe failed') : 'no recent failures';
            const canvasId = `host-probe-chart-${entry.target.slot}`;
            return `<div class="bg-base-300 rounded-xl p-4">
                <div class="mb-3 flex items-start justify-between gap-3">
                    <div>
                        <h3 class="font-semibold">${escapeHtml(entry.target.label)}</h3>
                        <p class="font-mono text-xs opacity-60">${escapeHtml(entry.target.host)}:${entry.target.port}</p>
                    </div>
                    <div class="text-right">
                        <div class="font-mono text-sm">${latest?.latencyMs != null ? `${Math.round(latest.latencyMs)} ms` : '—'}</div>
                        <div class="text-xs ${latest?.ok === false ? 'text-error' : 'opacity-60'}">${escapeHtml(errorText)}</div>
                    </div>
                </div>
                <canvas id="${canvasId}" style="width:100%;height:110px;display:block"></canvas>
            </div>`;
        })
        .join('');

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
    const inHostView = getUrlParam('view') === 'hosts';

    if (inHostView) {
        col?.classList.add('hidden');
        outsCol?.classList.add('hidden');
        overviewCol?.classList.add('hidden');
        hostsCol?.classList.remove('hidden');
        renderHostConnectionsOverview();
        return;
    }

    if (!pipeline) {
        col?.classList.add('hidden');
        outsCol?.classList.add('hidden');
        overviewCol?.classList.remove('hidden');
        hostsCol?.classList.add('hidden');
        renderOverview();
        return;
    }

    overviewCol?.classList.add('hidden');
    hostsCol?.classList.add('hidden');

    col?.classList.remove('hidden');
    outsCol?.classList.remove('hidden');

    setInnerText('pipe-name', pipeline.name);
    const readersBadge = document.getElementById('pipe-readers-badge');
    if (readersBadge) {
        readersBadge.textContent = `${pipeline.input.readers} reader${pipeline.input.readers === 1 ? '' : 's'}`;
        readersBadge.classList.toggle('hidden', !pipeline.input.connected);
    }
    const publisherIpBadge = document.getElementById('pipe-publisher-ip-badge');
    if (publisherIpBadge) {
        const ip = pipeline.input.publisherIp;
        const showIp = pipeline.input.connected && ip != null;
        publisherIpBadge.textContent = showIp ? ip : '';
        publisherIpBadge.classList.toggle('hidden', !showIp);
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
    const bondingUrl = document.getElementById('srt-bonding-url');
    const bondingStats = document.getElementById('srt-bonding-stats');
    const bondingOutputStats = document.getElementById('srt-bonding-output-stats');
    const bondingLegs = document.getElementById('srt-bonding-legs');
    const bondingErrWrap = document.getElementById('srt-bonding-last-error-wrap');
    const bondingErrTs = document.getElementById('srt-bonding-last-error-ts');
    const bondingErr = document.getElementById('srt-bonding-last-error');
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
        bondingDot.title = indicator.title;
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
        bondingUrl.dataset.ip = bondingHost;
        bondingUrl.dataset.port = String(bondingPortValue);
        bondingUrl.dataset.streamId = bondingStreamId;
        bondingUrl.dataset.passphrase = state.config.srtPassphrase || '';
    }
    if (bondingStats) {
        const rxPkts =
            pipeline.srtBonding.recvUniquePacketsTotal || pipeline.srtBonding.recvPacketsTotal;
        const hasSessionStats =
            relayProcessRunning &&
            (bondingInputActive || rxPkts > 0 || pipeline.srtBonding.retransTotal > 0);
        bondingStats.innerHTML = hasSessionStats
            ? renderCompactMetaRow(
                  [
                      {
                          label: 'SRS Pub',
                          labelTitle:
                              'The publisher SRS reports as active for this stream key. "local output" means another pipeline output is occupying the stream locally.',
                          value: pipeline.srtBonding.localSrtPublisherConflict
                              ? 'local output'
                              : pipeline.srtBonding.srsPublisher
                                ? `${pipeline.srtBonding.srsPublisher.ip ?? 'unknown'} ${pipeline.srtBonding.srsPublisher.type ?? ''}`.trim()
                                : '—',
                      },
                      {
                          label: 'Rx',
                          labelTitle:
                              'Unique data packets received from the upstream bonded SRT input, with a fallback to total received packets when needed.',
                          value: `${formatCompactCount(rxPkts)} pkts`,
                      },
                      {
                          label: 'Loss',
                          labelTitle:
                              'Packets detected as missing on the upstream bonded SRT input receiver.',
                          value: formatCompactCount(pipeline.srtBonding.recvLossTotal),
                      },
                      {
                          label: 'Rexmit',
                          labelTitle:
                              'Receive-side retransmission metric from the upstream bonded SRT input. Depending on the SRT library build, this may behave like a local/windowed stat rather than a lifetime total.',
                          value: formatCompactCount(pipeline.srtBonding.retransTotal),
                      },
                      {
                          label: 'Drop',
                          value: formatCompactCount(pipeline.srtBonding.recvDropTotal),
                      },
                      ...(pipeline.srtBonding.inputRttMs != null
                          ? [
                                {
                                    label: 'In RTT',
                                    labelTitle:
                                        'Estimated round-trip time between the upstream bonded SRT sender and this relay (combined group).',
                                    value: `${pipeline.srtBonding.inputRttMs.toFixed(
                                        pipeline.srtBonding.inputRttMs >= 10 ? 0 : 1,
                                    )}ms`,
                                },
                            ]
                          : []),
                  ],
                  'input-meta-row-sm',
              )
            : '';
    }
    if (bondingOutputStats) {
        const b = pipeline.srtBonding;
        const hasOutputStats =
            relayProcessRunning && (bondingOutputConnected || b.outputSentPacketsTotal > 0);
        bondingOutputStats.innerHTML = hasOutputStats
            ? renderCompactMetaRow(
                  [
                      {
                          label: 'Out RTT',
                          labelTitle:
                              'Round-trip time on the single downstream SRT connection from the relay to SRS (output is never bonded).',
                          value:
                              b.outputRttMs != null
                                  ? `${b.outputRttMs.toFixed(b.outputRttMs >= 10 ? 0 : 1)}ms`
                                  : '—',
                      },
                      {
                          label: 'Out Sent',
                          labelTitle: 'Packets sent on the downstream output connection.',
                          value: `${formatCompactCount(b.outputSentPacketsTotal)} pkts`,
                      },
                      {
                          label: 'Out Loss',
                          labelTitle:
                              'Send-side loss reported by SRT on the downstream output connection.',
                          value: formatCompactCount(b.outputSendLossTotal),
                      },
                      {
                          label: 'Out Drop',
                          labelTitle:
                              'Send-side drops reported by SRT on the downstream output connection.',
                          value: formatCompactCount(b.outputSendDropTotal),
                      },
                      {
                          label: 'Out Rexmit',
                          labelTitle: 'Retransmissions on the downstream output connection.',
                          value: formatCompactCount(b.outputRetransTotal),
                      },
                  ],
                  'input-meta-row-sm',
              )
            : '';
    }
    if (bondingLegs) {
        const legs = pipeline.srtBonding.legs;
        bondingLegs.innerHTML =
            legs.length === 0
                ? ''
                : `<div class="text-xs font-semibold opacity-60 mb-1">Bonded legs (${legs.length})</div>
                   <div class="overflow-x-auto">
                   <table class="table table-xs">
                       <thead><tr>
                           <th>IP</th><th>Port</th><th>State</th><th>RTT</th>
                           <th>Rx</th><th>Loss</th><th>Drop</th><th>Rexmit</th>
                       </tr></thead>
                       <tbody>${legs
                           .map((leg) => {
                               const color = legStateDotColor(leg.state);
                               const rx = leg.recvUniquePacketsTotal ?? leg.recvPacketsTotal;
                               return `<tr>
                                   <td class="font-mono text-xs">${leg.ip}</td>
                                   <td class="font-mono text-xs">${leg.port}</td>
                                   <td><span class="inline-flex items-center gap-1"><span class="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style="background:${color}"></span>${leg.state}</span></td>
                                   <td class="font-mono text-xs">${leg.rttMs != null ? `${leg.rttMs.toFixed(leg.rttMs >= 10 ? 0 : 1)}ms` : '—'}</td>
                                   <td class="font-mono text-xs">${rx != null ? formatCompactCount(rx) : '—'}</td>
                                   <td class="font-mono text-xs">${leg.recvLossTotal != null ? formatCompactCount(leg.recvLossTotal) : '—'}</td>
                                   <td class="font-mono text-xs">${leg.recvDropTotal != null ? formatCompactCount(leg.recvDropTotal) : '—'}</td>
                                   <td class="font-mono text-xs">${leg.retransTotal != null ? formatCompactCount(leg.retransTotal) : '—'}</td>
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
    }

    renderPreview(pipeline);
    renderOutputsList(pipeline);
}

// ── Outputs list (right column) ───────────────────────

const ICON_PENCIL = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>`;
const ICON_TRASH = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>`;
const ICON_INFO = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`;
const ICON_ITERATION_CW = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m12 2 3 3-3 3"/><path d="M15 5a9 9 0 1 1-3 16.9"/></svg>`;
const ICON_WARN = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`;

type DupRef = { pipelineName: string; outputName: string };

function showDupWarning(url: string, refs: DupRef[]): void {
    const modal = document.getElementById('dup-warn-modal') as HTMLDialogElement | null;
    const urlEl = document.getElementById('dup-warn-url');
    const listEl = document.getElementById('dup-warn-list');
    if (!modal || !urlEl || !listEl) return;
    urlEl.textContent = url;
    listEl.innerHTML = refs
        .map(
            (r) =>
                `<li><span class="font-semibold">${escapeHtml(r.pipelineName)}</span> → ${escapeHtml(r.outputName)}</li>`,
        )
        .join('');
    modal.showModal();
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
    inputLive: boolean,
    dupUrls: Map<string, DupRef[]>,
): string {
    const isStopped = o.desiredState === 'stopped';
    const isRunning = o.status === 'running';
    const st = outStatus(o, inputLive);
    const statusHex =
        st === 'good'
            ? STATUS_COLOR_GOOD
            : st === 'warn'
              ? STATUS_COLOR_WARN
              : st === 'error'
                ? STATUS_COLOR_ERROR
                : STATUS_COLOR_OFF;
    const uptimeMs = o.startedAtMs !== null ? Date.now() - o.startedAtMs : null;
    const badges = [`<span class="badge badge-sm whitespace-nowrap">${o.videoEncoding}</span>`];
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
    const fmtSink = (s: (typeof o.sinks)[0]) => {
        const trackBadge =
            s.audioEncoding !== 'copy'
                ? ` <span class="badge badge-xs badge-info whitespace-nowrap">${s.audioEncoding
                      .split(',')
                      .map((t) => `A${parseInt(t) + 1}`)
                      .join('+')}</span>`
                : '';
        const restreamLabel = restreamSinkLabel(s.url);
        const display =
            restreamLabel ??
            (s.url.length > 27 ? s.url.slice(0, 25) + '...' + s.url.slice(-2) : s.url);
        const dupRefs = dupUrls.get(s.url);
        const dupWarnBtn = dupRefs
            ? `<button class="btn btn-xs btn-ghost text-warning p-0 leading-none shrink-0" data-action="dup-warn" data-dup-url="${escapeHtml(s.url)}" data-dup-info="${escapeHtml(JSON.stringify(dupRefs))}" title="Duplicate destination — click for details">${ICON_WARN}</button>`
            : '';
        return { display, trackBadge, dupRefs, dupWarnBtn };
    };

    let inlineSink = '';
    let belowSinks = '';
    if (o.sinks.length === 1) {
        const { display, trackBadge, dupRefs, dupWarnBtn } = fmtSink(o.sinks[0]);
        const codeClass = dupRefs
            ? 'text-xs font-normal text-warning whitespace-nowrap'
            : 'text-xs font-normal opacity-60 whitespace-nowrap';
        inlineSink = `<code class="${codeClass}" title="${escapeHtml(o.sinks[0].url)}">${display}</code>${dupWarnBtn}${trackBadge}`;
    } else if (o.sinks.length > 1) {
        belowSinks = `<div class="space-y-0.5 pl-2">${o.sinks
            .map((s) => {
                const { display, trackBadge, dupRefs, dupWarnBtn } = fmtSink(s);
                const codeClass = dupRefs
                    ? 'text-xs font-normal text-warning'
                    : 'text-xs font-normal opacity-60';
                return `<div class="flex items-center gap-1 min-w-0"><code class="${codeClass}" title="${escapeHtml(s.url)}">${display}</code>${dupWarnBtn}${trackBadge}</div>`;
            })
            .join('')}</div>`;
    }

    const lastErrorLine = o.lastError
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
    const lastErrorHtml = lastErrorLine
        ? `<div class="flex items-center gap-2 pl-2 mt-0.5 min-w-0">
                ${retryBadge}
                <span class="text-xs ${lastErrorColor} shrink-0">${lastErrorTs}</span>
                <span class="text-xs ${lastErrorColor} truncate">${escapeHtml(lastErrorLine)}</span>
                <button class="btn btn-xs btn-ghost p-0 leading-none shrink-0 ${lastErrorColor}" data-action="error-info" data-out-id="${o.id}" title="View full error">${ICON_INFO}</button>
           </div>`
        : '';
    const warningHtml = o.warningReason
        ? `<div class="flex items-center gap-2 pl-2 mt-0.5 min-w-0">
                <span class="text-warning shrink-0">${ICON_WARN}</span>
                <span class="text-xs text-warning truncate">${escapeHtml(o.warningReason)}</span>
           </div>`
        : '';

    const isPending = pendingOutputs.has(o.id);
    return `
    <div class="bg-base-100 px-3 py-2 border border-base-content/10 rounded-xl w-full flex gap-2 items-start">
        <div class="min-w-0 flex-1 space-y-0.5">
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                <div class="flex items-center gap-2 shrink-0 font-semibold">
                    <div aria-label="status" class="status status-lg mx-1" style="background-color: ${statusHex}"></div>
                    <button class="btn btn-xs ${isStopped ? 'btn-accent' : 'btn-accent btn-outline'}"
                        data-action="${isStopped ? 'start' : 'stop'}" data-out-id="${o.id}"${isPending ? ' disabled' : ''}>
                        ${isStopped ? 'Start' : 'Stop'}
                    </button>
                    <span>${escapeHtml(o.name)}</span>
                </div>
                ${badges.join('')}
                ${inlineSink}
            </div>
            ${belowSinks}
            ${warningHtml}
            ${lastErrorHtml}
        </div>
        <div class="flex items-center gap-1 shrink-0">
            <button class="btn btn-xs btn-ghost" data-action="edit" data-out-id="${o.id}">${ICON_PENCIL}</button>
            <button class="btn btn-xs btn-ghost text-error ${isStopped ? '' : 'btn-disabled opacity-40'}"
                data-action="delete" data-out-id="${o.id}">${ICON_TRASH}</button>
        </div>
    </div>`;
}

function renderOutputsList(pipeline: PipelineView): void {
    const listEl = document.getElementById('outputs-list');
    if (!listEl) return;

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
            for (const s of o.sinks) {
                if (!s.url) continue;
                const list = urlRefs.get(s.url) ?? [];
                list.push({ pipelineName: p.name, outputName: o.name });
                urlRefs.set(s.url, list);
            }
        }
    }
    const dupUrls = new Map<string, DupRef[]>();
    for (const [url, refs] of urlRefs) {
        if (refs.length > 1) dupUrls.set(url, refs);
    }

    listEl.innerHTML = pipeline.outs
        .map((o) => renderOutputCard(o, pipeline.input.live, dupUrls))
        .join('');

    listEl.onclick = (e) => {
        const btn = (e.target as Element).closest('[data-action]') as HTMLButtonElement | null;
        if (!btn || btn.disabled || btn.classList.contains('btn-disabled')) return;
        const action = btn.dataset.action!;
        if (action === 'dup-warn') {
            const refs = JSON.parse(btn.dataset.dupInfo ?? '[]') as DupRef[];
            showDupWarning(btn.dataset.dupUrl ?? '', refs);
            return;
        }
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
    const inHostView = getUrlParam('view') === 'hosts';
    const hostsBtn = document.getElementById('host-connections-nav-btn');
    hostsBtn?.classList.toggle('btn-active', inHostView);
    renderPipelineList();
    renderPipelineInfo(selectedId);
}
