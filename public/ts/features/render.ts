import {
    setInnerText,
    statusColor,
    formatBitrate,
    formatBytes,
    formatBytesCompact,
    getUrlParam,
    maskStreamKey,
    LOW_BITRATE_KBPS,
} from '../core/utils.js';
import { state } from '../core/state.js';
import type { InputHealth, PipelineView, OutputView } from '../types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const Hls: any;

declare global {
    interface Window {
        selectPipeline: (id: string | null) => void;
    }
}

type OutStatus = 'good' | 'warn' | 'error' | 'off';

const pendingOutputs = new Set<string>();

function outStatus(o: OutputView, inputLive: boolean): OutStatus {
    if (o.desiredState === 'stopped') return 'off';
    if (o.status === 'failed') return 'error';
    if (o.status === 'running') {
        if (!inputLive) return 'error';
        if (o.bitrateKbps !== null && o.bitrateKbps >= LOW_BITRATE_KBPS) return 'good';
        return 'warn';
    }
    return 'off';
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
                    ? '#ef4444'
                    : outWarn > 0
                      ? '#eab308'
                      : outGood > 0
                        ? '#22c55e'
                        : '#6b7280';
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
            ${stat('Profile', v.profile || null)}
            ${stat('Level', v.level || null)}
        </div>`
                : input.isSrt
                  ? `<p class="text-xs opacity-50 mt-2">Codec info is still being probed through SRS's RTMP bridge.<br>
                   RTT, packet drops and retransmissions are not exposed by SRS.</p>`
                  : ''
        }
        ${
            a
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
            inputRows += `<tr class="hover cursor-pointer js-overview-select" data-id="${p.id}" ${statusBg(false, isWarn)}>
                <td class="font-semibold">${p.name}</td>
                <td>${badge}</td>
                ${td(inp.live ? formatUptime(inp.uptimeMs) : null)}
                ${td(inp.live ? formatBitrate(inp.recvBitrateKbps) : null)}
                ${td(inp.live ? (inp.isSrt ? 'SRT' : 'RTMP') : null)}
                ${td(inp.video?.codec)}
                ${td(inp.video ? `${inp.video.width}×${inp.video.height}` : null)}
                ${td(inp.video?.fps)}
                ${td(inp.audio?.codec)}
                ${td(inp.audio?.channel)}
                ${td(fmtHz(inp.audio?.sample_rate))}
            </tr>`;
        }
    }

    // ── Outputs ───────────────────────────────────────────
    let outputRows = '';
    if (totalOuts === 0) {
        outputRows = `<tr><td colspan="10" class="py-4 text-center opacity-50">No outputs yet.</td></tr>`;
    } else {
        for (const p of state.pipelines) {
            for (const o of p.outs) {
                const isRunning = o.status === 'running';
                const st = outStatus(o, p.input.live);
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
                              ? `<span class="badge badge-sm badge-error">No Input</span>`
                              : `<span class="badge badge-sm badge-error">Failed</span>`;

                const isOn = o.status === 'running';
                const src = isOn && o.encoding === 'source' ? p.input : null;
                outputRows += `<tr class="hover cursor-pointer js-overview-select" data-id="${p.id}" ${statusBg(st === 'error', st === 'warn')}>
                    <td><span class="opacity-40 text-xs">${p.name} ·</span> ${o.name}</td>
                    <td>${badge}${o.retries > 0 ? ` <span class="font-mono text-xs opacity-60">↺${o.retries}</span>` : ''}</td>
                    ${td(formatBitrate(o.bitrateKbps))}
                    ${td(isOn ? o.encoding : null)}
                    ${td(src?.video?.codec)}
                    ${td(src?.video ? `${src.video.width}×${src.video.height}` : null)}
                    ${td(src?.video?.fps)}
                    ${td(src?.audio?.codec)}
                    ${td(src?.audio?.channel)}
                    ${td(isOn ? fmtHz(src?.audio?.sample_rate) : null)}
                </tr>`;
            }
        }
    }

    const thead = (cols: string[]) =>
        `<thead><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr></thead>`;

    overviewEl.innerHTML = `
        <h2 class="mb-2 text-lg font-bold">Inputs <span class="badge badge-neutral badge-sm ml-1">${state.pipelines.length}</span></h2>
        <div class="overflow-x-auto mb-6">
            <table class="table table-sm">
                ${thead(['Pipeline', 'Status', 'Uptime', 'Bitrate', 'Proto', 'V.Codec', 'Resolution', 'FPS', 'A.Codec', 'Ch', 'Sample Rate'])}
                <tbody>${inputRows}</tbody>
            </table>
        </div>
        <h2 class="mb-2 text-lg font-bold">Outputs <span class="badge badge-neutral badge-sm ml-1">${totalOuts}</span></h2>
        <div class="overflow-x-auto">
            <table class="table table-sm">
                ${thead(['Pipeline · Output', 'Status', 'Bitrate', 'Encoding', 'V.Codec', 'Resolution', 'FPS', 'A.Codec', 'Ch', 'Sample Rate'])}
                <tbody>${outputRows}</tbody>
            </table>
        </div>`;

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
    const editBtn = document.getElementById('pipe-edit-btn');
    const deleteBtn = document.getElementById('pipe-delete-btn');
    editBtn?.classList.toggle('btn-disabled', hasActiveOutputs);
    deleteBtn?.classList.toggle('btn-disabled', hasActiveOutputs);
    if (editBtn) editBtn.title = hasActiveOutputs ? 'Stop all outputs before editing' : '';
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
        srtEl.dataset.ip = pipeline.srtPublishUrl.slice(6, pipeline.srtPublishUrl.indexOf(':', 6));
        srtEl.dataset.streamId = `#!::r=live/${pipeline.streamKey},m=publish`;
    }

    renderPreview(pipeline);
    renderOutputsList(pipeline);
}

// ── Outputs list (right column) ───────────────────────

const ICON_PENCIL = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>`;
const ICON_TRASH = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>`;

function renderOutputCard(o: OutputView, inputLive: boolean): string {
    const isStopped = o.desiredState === 'stopped';
    const isRunning = o.status === 'running';
    const st = outStatus(o, inputLive);
    const statusClass =
        st === 'good'
            ? 'status-success'
            : st === 'warn'
              ? 'status-warning'
              : st === 'error'
                ? 'status-error'
                : 'status-neutral';
    const uptimeMs = st === 'good' && o.startedAtMs !== null ? Date.now() - o.startedAtMs : null;
    const badges = [`<span class="badge badge-sm whitespace-nowrap">${o.encoding}</span>`];
    if (uptimeMs !== null) {
        badges.push(
            `<span class="font-mono text-xs opacity-60 whitespace-nowrap">${formatUptime(uptimeMs)}</span>`,
        );
    }
    if (o.retries > 0) {
        badges.push(
            `<span class="badge badge-sm badge-warning whitespace-nowrap" title="Retry attempts">↺ ${o.retries}</span>`,
        );
    }
    if (isRunning && o.bitrateKbps !== null) {
        badges.push(
            `<span class="badge badge-sm whitespace-nowrap">${formatBitrate(o.bitrateKbps)}</span>`,
        );
    }
    const isPending = pendingOutputs.has(o.id);
    return `
    <div class="bg-base-100 px-3 py-2 shadow rounded-box w-full flex gap-2 items-start">
        <div class="min-w-0 flex-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <div class="flex items-center gap-2 shrink-0 font-semibold">
                <div aria-label="status" class="status status-lg ${statusClass} mx-1"></div>
                <button class="btn btn-xs ${isStopped ? 'btn-accent' : 'btn-accent btn-outline'}"
                    data-action="${isStopped ? 'start' : 'stop'}" data-out-id="${o.id}"${isPending ? ' disabled' : ''}>
                    ${isStopped ? 'Start' : 'Stop'}
                </button>
                <span>${o.name}</span>
            </div>
            <code class="text-sm font-normal opacity-60 truncate shrink min-w-0"
                  style="max-width:min(28rem,40%)" title="${o.url}">${o.url}</code>
            ${badges.join('')}
        </div>
        <div class="flex items-center gap-1 shrink-0">
            <button class="btn btn-xs btn-ghost" data-action="edit" data-out-id="${o.id}">${ICON_PENCIL}</button>
            <button class="btn btn-xs btn-ghost text-error ${isStopped ? '' : 'btn-disabled'}"
                data-action="delete" data-out-id="${o.id}">${ICON_TRASH}</button>
        </div>
    </div>`;
}

function renderOutputsList(pipeline: PipelineView): void {
    const listEl = document.getElementById('outputs-list');
    if (!listEl) return;

    if (pipeline.outs.length === 0) {
        listEl.innerHTML = '<p class="text-sm opacity-50">No outputs yet.</p>';
        return;
    }

    // Clear pending state once the output's actual status has settled into the
    // desired state (or for outputs that no longer exist, e.g. deleted).
    const presentIds = new Set(pipeline.outs.map((o) => o.id));
    for (const id of pendingOutputs) {
        if (!presentIds.has(id)) pendingOutputs.delete(id);
    }
    for (const o of pipeline.outs) {
        if (!pendingOutputs.has(o.id)) continue;
        const settled =
            (o.desiredState === 'running' && (o.status === 'running' || o.status === 'failed')) ||
            (o.desiredState === 'stopped' && o.status === 'stopped');
        if (settled) pendingOutputs.delete(o.id);
    }

    listEl.innerHTML = pipeline.outs.map((o) => renderOutputCard(o, pipeline.input.live)).join('');

    listEl.onclick = (e) => {
        const btn = (e.target as Element).closest('[data-action]') as HTMLButtonElement | null;
        if (!btn || btn.disabled || btn.classList.contains('btn-disabled')) return;
        const outId = btn.dataset.outId!;
        const action = btn.dataset.action!;
        if (action === 'start' || action === 'stop') {
            pendingOutputs.add(outId);
            btn.disabled = true;
        }
        void import('../features/editor.js').then((ed) => {
            if (action === 'start') ed.startOutput(pipeline.id, outId);
            else if (action === 'stop') ed.stopOutput(pipeline.id, outId);
            else if (action === 'edit') ed.openEditOutput(pipeline.id, outId);
            else if (action === 'delete') ed.confirmDeleteOutput(pipeline.id, outId);
        });
    };
}

// ── Preview ───────────────────────────────────────────

let previewPipelineId: string | null = null;
let hlsInstance: { destroy(): void } | null = null;

function teardownHls(): void {
    if (hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
    }
    const video = document.getElementById('preview-video') as HTMLVideoElement | null;
    if (video) {
        video.pause();
        video.removeAttribute('src');
        video.load();
        video.classList.add('hidden');
    }
    document.getElementById('preview-play-btn')?.classList.remove('hidden');
    document.getElementById('preview-stop-btn')?.classList.add('hidden');
}

export function stopCurrentPreview(): void {
    const pid = previewPipelineId;
    if (!pid) return;
    previewPipelineId = null;
    teardownHls();
    void import('../core/api.js').then(({ stopPreview }) => stopPreview(pid));
}

export function attachHls(pipelineId: string, hlsUrl: string): void {
    previewPipelineId = pipelineId;
    const video = document.getElementById('preview-video') as HTMLVideoElement | null;
    if (!video) return;
    video.classList.remove('hidden');
    document.getElementById('preview-play-btn')?.classList.add('hidden');
    document.getElementById('preview-stop-btn')?.classList.remove('hidden');

    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
        const hls = new Hls({
            liveSyncDurationCount: 5,
            fragLoadingMaxRetry: 10,
            fragLoadingRetryDelay: 500,
            manifestLoadingMaxRetry: 6,
            manifestLoadingRetryDelay: 500,
        }) as {
            destroy(): void;
            loadSource(u: string): void;
            attachMedia(v: HTMLVideoElement): void;
            on(e: string, cb: (...args: unknown[]) => void): void;
            Events: { MANIFEST_PARSED: string; ERROR: string };
        };
        hls.loadSource(hlsUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED as string, () => void video.play());
        hls.on(Hls.Events.ERROR as string, (...args: unknown[]) => {
            const data = args[1] as { fatal?: boolean };
            if (data?.fatal) setTimeout(() => stopCurrentPreview(), 0);
        });
        hlsInstance = hls;
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = hlsUrl;
        void video.play();
    }
}

function renderPreview(pipeline: PipelineView): void {
    const section = document.getElementById('preview-section');
    if (!section) return;

    if (!pipeline.input.live) {
        section.classList.add('hidden');
        if (previewPipelineId === pipeline.id) stopCurrentPreview();
        return;
    }

    section.classList.remove('hidden');

    if (previewPipelineId && previewPipelineId !== pipeline.id) stopCurrentPreview();

    const isActive = previewPipelineId === pipeline.id;
    document.getElementById('preview-play-btn')?.classList.toggle('hidden', isActive);
    document.getElementById('preview-stop-btn')?.classList.toggle('hidden', !isActive);
}

// ── Metrics (navbar) ──────────────────────────────────

export function renderMetrics(): void {
    const m = state.metrics;
    const cpu = m.cpu ?? null;
    const ram = m.ram ?? null;
    const disk = m.disk ?? null;
    const net = m.net ?? null;

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
