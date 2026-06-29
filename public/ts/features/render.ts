import {
    setInnerText,
    statusColor,
    formatBitrate,
    formatBytesCompact,
    getUrlParam,
    maskStreamKey,
    LOW_BITRATE_KBPS,
    STATUS_COLOR_GOOD,
    STATUS_COLOR_WARN,
    STATUS_COLOR_ERROR,
    STATUS_COLOR_OFF,
} from '../core/utils.js';
import { state } from '../core/state.js';
import type { InputHealth, PipelineView, OutputView, MetricSample } from '../types.js';
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

function fmtFieldOrder(fo: string | null | undefined): string | null {
    if (!fo || fo === 'unknown') return null;
    if (fo === 'progressive') return 'P';
    if (fo === 'tt' || fo === 'tb') return 'i TFF';
    if (fo === 'bb' || fo === 'bt') return 'i BFF';
    return fo;
}

const pendingOutputs = new Map<string, 'start' | 'stop'>();
const SRT_RELAY_BASE_PORT = 11000;

function outStatus(o: OutputView, inputLive: boolean): OutStatus {
    if (o.desiredState === 'stopped') return 'off';
    if (o.status === 'failed') return 'error';
    if (o.status === 'running') {
        if (!inputLive) return 'error';
        if (o.bitrateKbps !== null && o.bitrateKbps >= LOW_BITRATE_KBPS) return 'good';
        if (o.bitrateKbps === null && o.lastError !== null) return 'error';
        return 'warn';
    }
    // status === 'stopped' but desiredState === 'running': between retries
    return o.lastError !== null ? 'error' : 'warn';
}

// ── Pipeline list (left column) ───────────────────────

function renderPipelineList(): void {
    const listEl = document.getElementById('pipelines');
    if (!listEl) return;

    const inputsOn = state.pipelines.filter((p) => p.input.live).length;
    const inputsWarn = state.pipelines.filter(
        (p) =>
            p.input.live &&
            p.input.recvBitrateKbps !== null &&
            p.input.recvBitrateKbps < LOW_BITRATE_KBPS,
    ).length;
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
    setInnerText('pipe-oks', inputsOn - inputsWarn);
    setInnerText('pipe-warns', inputsWarn);
    setInnerText('pipe-offs', state.pipelines.length - inputsOn);
    setInnerText('out-cnt', totalOutputs);
    setInnerText('out-oks', outputsOn - outputsWarn);
    setInnerText('out-warns', outputsWarn);
    setInnerText('out-errors', outputsFailed);
    setInnerText('out-offs', outputsOff);

    const selectedId = getUrlParam('p');

    listEl.innerHTML = state.pipelines
        .map((p) => {
            const outGood = p.outs.filter((o) => outStatus(o, p.input.live) === 'good').length;
            const outWarn = p.outs.filter((o) => outStatus(o, p.input.live) === 'warn').length;
            const outFailed = p.outs.filter((o) => outStatus(o, p.input.live) === 'error').length;
            const outOff = p.outs.filter((o) => outStatus(o, p.input.live) === 'off').length;

            const inColor = statusColor(p.input.live, p.input.recvBitrateKbps);
            const outColor =
                outFailed > 0
                    ? STATUS_COLOR_ERROR
                    : outWarn > 0
                      ? STATUS_COLOR_WARN
                      : outGood > 0
                        ? STATUS_COLOR_GOOD
                        : STATUS_COLOR_OFF;
            const selected = p.id === selectedId ? 'bg-base-100' : '';

            const badge = (n: number, cls: string) =>
                n > 0 ? `<div class="badge badge-sm ${cls} px-2">${n}</div>` : '';
            const uptimeSpan =
                p.input.live && p.input.uptimeMs !== null
                    ? `<span class="font-mono text-xs opacity-60 shrink-0">${formatUptime(p.input.uptimeMs)}</span>`
                    : '';
            const inputTypeBadge = p.input.live
                ? `<span class="badge badge-sm badge-outline shrink-0">${p.input.isSrt ? 'SRT' : 'RTMP'}</span>`
                : '';
            const relayBadge =
                p.srtRelay.status === 'running'
                    ? `<span class="badge badge-sm badge-info shrink-0">Relay</span>`
                    : '';

            return `<li>
            <div class="flex items-center gap-2 ${selected} cursor-pointer js-select-pipeline" data-id="${p.id}">
                <div class="rounded-box h-5 w-5 shrink-0" style="background:linear-gradient(90deg,${inColor},${inColor} 45%,#242933 45%,#242933 55%,${outColor} 55%)"></div>
                ${badge(outGood, 'badge-success')}
                ${badge(outWarn, 'badge-warning')}
                ${badge(outFailed, 'badge-error')}
                ${badge(outOff, 'badge-ghost')}
                <a class="truncate min-w-0">${p.name}</a>
                ${uptimeSpan}
                ${inputTypeBadge}
                ${relayBadge}
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

function renderInputStats(input: InputHealth): string {
    if (!input.live) return '';

    const v = input.video;
    const a = input.audio;

    const stat = (label: string, val: string | number | null | undefined) =>
        `<div class="stat p-3">
            <div class="stat-title text-xs">${label}</div>
            <div class="stat-value text-sm">${val ?? '—'}</div>
        </div>`;

    return `
        <div class="stats shadow flex-wrap">
            ${stat('In Bitrate', formatBitrate(input.recvBitrateKbps))}
            ${stat('Readers', input.readers)}
            ${stat('Uptime', formatUptime(input.uptimeMs))}
        </div>
        ${
            v
                ? `
        <h3 class="mt-3 text-sm font-semibold opacity-60">Video</h3>
        <div class="stats shadow mt-1 flex-wrap">
            ${stat('Codec', v.codec)}
            ${stat('Resolution', v.width && v.height ? `${v.width}×${v.height}` : null)}
            ${stat('FPS', v.fps != null ? v.fps : null)}
            ${stat('Scan', fmtFieldOrder(v.fieldOrder))}
            ${stat('Profile', v.profile || null)}
            ${stat('Level', v.level || null)}
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
                        const label = [t.language, t.title].filter(Boolean).join(' — ');
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
        <div class="stats shadow mt-1 flex-wrap">
            ${stat('Codec', a.codec)}
            ${stat('Sample Rate', a.sample_rate ? `${(a.sample_rate / 1000).toFixed(1)} kHz` : null)}
            ${stat('Channels', a.channel)}
            ${stat('Profile', a.profile || null)}
        </div>`
                  : ''
        }
    `;
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

    // ── Inputs ────────────────────────────────────────────
    let inputRows = '';
    if (state.pipelines.length === 0) {
        inputRows = `<tr><td colspan="11" class="py-4 text-center opacity-50">No pipelines yet.</td></tr>`;
    } else {
        for (const p of state.pipelines) {
            const inp = p.input;
            const isWarn =
                inp.live && inp.recvBitrateKbps !== null && inp.recvBitrateKbps < LOW_BITRATE_KBPS;
            const badge = !inp.live
                ? `<span class="badge badge-sm badge-neutral">Offline</span>`
                : isWarn
                  ? `<span class="badge badge-sm badge-warning">Low Bitrate</span>`
                  : `<span class="badge badge-sm badge-success">Live</span>`;
            const relayBadge =
                p.srtRelay.status === 'running'
                    ? ` <span class="badge badge-sm badge-info">Relay</span>`
                    : '';
            const audioTracks = inp.audioTracks.length > 0 ? inp.audioTracks : null;
            const rowspan =
                audioTracks && audioTracks.length > 1 ? ` rowspan="${audioTracks.length}"` : '';
            const rowAttr = `class="hover cursor-pointer js-overview-select" data-id="${p.id}" ${statusBg(false, isWarn)}`;
            const sharedCells = `
                <td class="font-semibold"${rowspan}>${p.name}</td>
                <td${rowspan}>${badge}${relayBadge}</td>
                <td class="font-mono text-xs"${rowspan}>${inp.live ? formatUptime(inp.uptimeMs) : '—'}</td>
                <td class="font-mono text-xs"${rowspan}>${inp.live ? formatBitrate(inp.recvBitrateKbps) : '—'}</td>
                <td class="font-mono text-xs"${rowspan}>${inp.live ? (inp.isSrt ? 'SRT' : 'RTMP') : '—'}</td>
                <td class="font-mono text-xs"${rowspan}>${inp.video?.codec ?? '—'}</td>
                <td class="font-mono text-xs"${rowspan}>${inp.video ? `${inp.video.width}×${inp.video.height}` : '—'}</td>
                <td class="font-mono text-xs"${rowspan}>${inp.video?.fps ?? '—'}</td>
                <td class="font-mono text-xs"${rowspan}>${fmtFieldOrder(inp.video?.fieldOrder) ?? '—'}</td>`;
            if (audioTracks && audioTracks.length > 1) {
                inputRows += audioTracks
                    .map((t, i) => {
                        const label =
                            t.title || t.language
                                ? ` <span class="opacity-40 text-xs">${[t.language, t.title].filter(Boolean).join(' ')}</span>`
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
    }

    // ── Outputs ───────────────────────────────────────────
    let outputRows = '';
    if (totalOuts === 0) {
        outputRows = `<tr><td colspan="11" class="py-4 text-center opacity-50">No outputs yet.</td></tr>`;
    } else {
        for (const p of state.pipelines) {
            for (const o of p.outs) {
                const isRunning = o.status === 'running';
                const st = outStatus(o, p.input.live);
                const retryPrefix =
                    st === 'error' && o.failures > 0 ? `${ICON_ITERATION_CW}${o.failures} ` : '';
                const badge =
                    st === 'off'
                        ? `<span class="badge badge-sm badge-neutral">Stopped</span>`
                        : st === 'good'
                          ? `<span class="badge badge-sm badge-success">Running</span>`
                          : st === 'warn'
                            ? o.bitrateKbps === null
                                ? `<span class="badge badge-sm badge-warning">No Output</span>`
                                : `<span class="badge badge-sm badge-warning">Low Bitrate</span>`
                            : isRunning
                              ? `<span class="badge badge-sm badge-error gap-1">${retryPrefix}No Input</span>`
                              : `<span class="badge badge-sm badge-error gap-1">${retryPrefix}Failed</span>`;

                const isOn = o.status === 'running';
                const src = isOn && o.videoEncoding === 'copy' ? p.input : null;
                const outUptimeMs =
                    st === 'good' && o.startedAtMs !== null ? Date.now() - o.startedAtMs : null;
                outputRows += `<tr class="hover cursor-pointer js-overview-select" data-id="${p.id}" ${statusBg(st === 'error', st === 'warn')}>
                    <td><span class="opacity-40 text-xs">${p.name} ·</span> ${o.name}</td>
                    <td>${badge}</td>
                    <td class="font-mono text-xs">${outUptimeMs !== null ? formatUptime(outUptimeMs) : '—'}</td>
                    ${td(formatBitrate(o.bitrateKbps))}
                    ${td(isOn ? o.videoEncoding : null)}
                    ${td(src?.video?.codec)}
                    ${td(src?.video ? `${src.video.width}×${src.video.height}` : null)}
                    ${td(src?.video?.fps)}
                    ${td(fmtFieldOrder(src?.video?.fieldOrder))}
                    ${td(src?.audio?.codec)}
                    ${td(src?.audio?.channel)}
                    ${td(isOn ? fmtHz(src?.audio?.sample_rate) : null)}
                </tr>`;
            }
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

    overviewEl.innerHTML = `
        ${chartsHtml}
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

    overviewEl.onclick = (e) => {
        const row = (e.target as Element).closest('.js-overview-select') as HTMLElement | null;
        if (row?.dataset.id) window.selectPipeline(row.dataset.id);
    };
}

function renderPipelineInfo(selectedId: string | null): void {
    const pipeline = selectedId ? state.pipelines.find((p) => p.id === selectedId) : null;
    const col = document.getElementById('pipe-info-col');
    const outsCol = document.getElementById('outs-col');
    const overviewCol = document.getElementById('overview-col');

    if (!pipeline) {
        col?.classList.add('hidden');
        outsCol?.classList.add('hidden');
        overviewCol?.classList.remove('hidden');
        renderOverview();
        return;
    }

    overviewCol?.classList.add('hidden');

    col?.classList.remove('hidden');
    outsCol?.classList.remove('hidden');

    setInnerText('pipe-name', pipeline.name);

    const hasActiveOutputs = pipeline.outs.some((o) => o.desiredState !== 'stopped');
    const deleteBtn = document.getElementById('pipe-delete-btn');
    deleteBtn?.classList.toggle('btn-disabled', hasActiveOutputs);
    deleteBtn?.classList.toggle('opacity-40', hasActiveOutputs);
    if (deleteBtn) deleteBtn.title = hasActiveOutputs ? 'Stop all outputs before deleting' : '';

    const statsContainer = document.getElementById('input-stats-container');
    const statsEl = document.getElementById('input-stats');
    const inputHtml = renderInputStats(pipeline.input);
    if (statsContainer) statsContainer.classList.toggle('hidden', !pipeline.input.live);
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
        srtEl.textContent = pipeline.srtPublishUrl.replace(pipeline.streamKey, masked);
        const hostStart = 6;
        const colonAfterHost = pipeline.srtPublishUrl.indexOf(':', hostStart);
        srtEl.dataset.ip = pipeline.srtPublishUrl.slice(hostStart, colonAfterHost);
        const portEnd = pipeline.srtPublishUrl.indexOf('?', colonAfterHost);
        srtEl.dataset.port =
            portEnd > -1
                ? pipeline.srtPublishUrl.slice(colonAfterHost + 1, portEnd)
                : pipeline.srtPublishUrl.slice(colonAfterHost + 1);
        srtEl.dataset.streamId = `#!::r=live/${pipeline.streamKey},m=publish`;
    }

    const bondingCard = document.getElementById('srt-bonding-card');
    const bondingDot = document.getElementById('srt-bonding-status-dot');
    const bondingBtn = document.getElementById(
        'srt-bonding-toggle-btn',
    ) as HTMLButtonElement | null;
    const bondingUrl = document.getElementById('srt-bonding-url');
    const relayRunning = pipeline.srtRelay.status === 'running';
    const relayFailed = pipeline.srtRelay.status === 'failed';
    const bondingHost = state.config.publicHost || 'localhost';
    const bondingPortValue = SRT_RELAY_BASE_PORT + Number(pipeline.id);
    const bondingUrlValue =
        `srt://${bondingHost}:${bondingPortValue}?mode=caller&grouptype=broadcast` +
        (state.config.srtPassphrase
            ? `&passphrase=${encodeURIComponent(state.config.srtPassphrase)}&pbkeylen=16`
            : '');
    bondingCard?.classList.remove('opacity-60');
    if (bondingDot) {
        bondingDot.style.backgroundColor = relayRunning
            ? STATUS_COLOR_GOOD
            : relayFailed
              ? STATUS_COLOR_ERROR
              : STATUS_COLOR_OFF;
        bondingDot.title = relayRunning
            ? 'Relay running'
            : relayFailed
              ? 'Relay failed'
              : 'Relay stopped';
    }
    if (bondingBtn) {
        bondingBtn.textContent = pipeline.bondingEnabled ? 'Stop' : 'Start';
        bondingBtn.classList.toggle('btn-outline', pipeline.bondingEnabled);
    }
    if (bondingUrl) {
        bondingUrl.textContent = bondingUrlValue.replace(pipeline.streamKey, masked);
        bondingUrl.dataset.copy = bondingUrlValue;
        bondingUrl.dataset.ip = bondingHost;
        bondingUrl.dataset.port = String(bondingPortValue);
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

function escHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

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
                `<li><span class="font-semibold">${escHtml(r.pipelineName)}</span> → ${escHtml(r.outputName)}</li>`,
        )
        .join('');
    modal.showModal();
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
    const uptimeMs = st === 'good' && o.startedAtMs !== null ? Date.now() - o.startedAtMs : null;
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
        const display = s.url.length > 27 ? s.url.slice(0, 25) + '...' + s.url.slice(-2) : s.url;
        const dupRefs = dupUrls.get(s.url);
        const dupWarnBtn = dupRefs
            ? `<button class="btn btn-xs btn-ghost text-warning p-0 leading-none shrink-0" data-action="dup-warn" data-dup-url="${escHtml(s.url)}" data-dup-info="${escHtml(JSON.stringify(dupRefs))}" title="Duplicate destination — click for details">${ICON_WARN}</button>`
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
        inlineSink = `<code class="${codeClass}" title="${escHtml(o.sinks[0].url)}">${display}</code>${dupWarnBtn}${trackBadge}`;
    } else if (o.sinks.length > 1) {
        belowSinks = `<div class="space-y-0.5 pl-2">${o.sinks
            .map((s) => {
                const { display, trackBadge, dupRefs, dupWarnBtn } = fmtSink(s);
                const codeClass = dupRefs
                    ? 'text-xs font-normal text-warning'
                    : 'text-xs font-normal opacity-60';
                return `<div class="flex items-center gap-1 min-w-0"><code class="${codeClass}" title="${escHtml(s.url)}">${display}</code>${dupWarnBtn}${trackBadge}</div>`;
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
                <span class="text-xs ${lastErrorColor} truncate">${escHtml(lastErrorLine)}</span>
                <button class="btn btn-xs btn-ghost p-0 leading-none shrink-0 ${lastErrorColor}" data-action="error-info" data-out-id="${o.id}" title="View full error">${ICON_INFO}</button>
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
                    <span>${o.name}</span>
                </div>
                ${badges.join('')}
                ${inlineSink}
            </div>
            ${belowSinks}
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

    setInnerText(
        'navbar-uptime',
        uptimeSecs !== null ? `Up ${formatUptime(uptimeSecs * 1000)}` : 'Up —',
    );
    setInnerText('navbar-cpu-value', cpu ? `${cpu.cores}c CPU: ${cpu.percent}%` : 'CPU —');
    setInnerText(
        'navbar-ram-value',
        ram
            ? `${formatBytesCompact(ram.totalBytes)} RAM: ${Math.round((ram.usedBytes / ram.totalBytes) * 100)}%`
            : 'RAM —',
    );
    setInnerText(
        'navbar-disk-value',
        disk
            ? `${formatBytesCompact(disk.totalBytes)} Disk: ${Math.round((disk.usedBytes / disk.totalBytes) * 100)}%`
            : 'Disk —',
    );
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
    renderPipelineList();
    renderPipelineInfo(selectedId);
}
