import {
    setInnerText,
    statusColor,
    formatBitrate,
    formatBytes,
    formatBytesCompact,
    getUrlParam,
    maskStreamKey,
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

// ── Pipeline list (left column) ───────────────────────

function renderPipelineList(): void {
    const listEl = document.getElementById('pipelines');
    if (!listEl) return;

    const inputsOn = state.pipelines.filter((p) => p.input.live).length;
    const totalOutputs = state.pipelines.reduce((s, p) => s + p.outs.length, 0);
    const outputsOn = state.pipelines.reduce(
        (s, p) => s + p.outs.filter((o) => o.status === 'running').length,
        0,
    );
    const outputsFailed = state.pipelines.reduce(
        (s, p) =>
            s + p.outs.filter((o) => o.desiredState === 'running' && o.status === 'failed').length,
        0,
    );
    const outputsOff = state.pipelines.reduce(
        (s, p) => s + p.outs.filter((o) => o.desiredState === 'stopped').length,
        0,
    );

    setInnerText('pipe-cnt', state.pipelines.length);
    setInnerText('pipe-oks', inputsOn);
    setInnerText('pipe-offs', state.pipelines.length - inputsOn);
    setInnerText('out-cnt', totalOutputs);
    setInnerText('out-oks', outputsOn);
    setInnerText('out-errors', outputsFailed);
    setInnerText('out-offs', outputsOff);

    const selectedId = getUrlParam('p');

    listEl.innerHTML = state.pipelines
        .map((p) => {
            const outRunning = p.outs.filter((o) => o.status === 'running').length;
            const outFailed = p.outs.filter(
                (o) => o.desiredState === 'running' && o.status === 'failed',
            ).length;
            const outOff = p.outs.filter((o) => o.desiredState === 'stopped').length;

            const inColor = statusColor(p.input.live);
            const outColor = outFailed > 0 ? '#ef4444' : outRunning > 0 ? '#22c55e' : '#6b7280';
            const selected = p.id === selectedId ? 'bg-base-100' : '';

            const badge = (n: number, cls: string) =>
                n > 0 ? `<div class="badge badge-sm ${cls} px-2">${n}</div>` : '';

            return `<li>
            <div class="flex items-center gap-2 ${selected} cursor-pointer js-select-pipeline" data-id="${p.id}">
                <div class="rounded-box h-5 w-5 shrink-0" style="background:linear-gradient(90deg,${inColor},${inColor} 45%,#242933 45%,#242933 55%,${outColor} 55%)"></div>
                ${badge(outRunning, 'badge-success')}
                ${badge(outFailed, 'badge-error')}
                ${badge(outOff, 'badge-ghost')}
                <a class="truncate">${p.name}</a>
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
    if (!input.live) {
        return `<div class="text-sm opacity-40 italic">No active publisher</div>`;
    }

    const v = input.video;
    const a = input.audio;

    const stat = (label: string, val: string | number | null | undefined) =>
        `<div class="stat p-3">
            <div class="stat-title text-xs">${label}</div>
            <div class="stat-value text-sm">${val ?? '—'}</div>
        </div>`;

    const sourceTag = input.isSrt
        ? `<span class="badge badge-sm badge-outline badge-info ml-1">SRT</span>`
        : `<span class="badge badge-sm badge-outline badge-warning ml-1">RTMP</span>`;

    return `
        <div class="flex items-center gap-1 mb-2">${sourceTag}</div>
        <div class="stats shadow mt-2 flex-wrap">
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

function renderPipelineInfo(selectedId: string | null): void {
    const pipeline = selectedId ? state.pipelines.find((p) => p.id === selectedId) : null;
    const col = document.getElementById('pipe-info-col');
    const outsCol = document.getElementById('outs-col');

    if (!pipeline) {
        col?.classList.add('hidden');
        outsCol?.classList.add('hidden');
        return;
    }

    col?.classList.remove('hidden');
    outsCol?.classList.remove('hidden');

    setInnerText('pipe-name', pipeline.name);

    const inputDot = document.getElementById('input-live-dot');
    if (inputDot)
        inputDot.className = `rounded-full w-2 h-2 ${pipeline.input.live ? 'bg-success' : 'bg-base-content/30'}`;
    setInnerText('input-status-text', pipeline.input.live ? 'Live' : 'Offline');

    const statsEl = document.getElementById('input-stats');
    if (statsEl) statsEl.innerHTML = renderInputStats(pipeline.input);

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

function renderOutputCard(o: OutputView): string {
    const isStopped = o.desiredState === 'stopped';
    const isRunning = o.status === 'running';
    const statusClass = isStopped
        ? 'status-neutral'
        : isRunning
          ? 'status-success'
          : 'status-error';
    const badges = [`<span class="badge badge-sm whitespace-nowrap">${o.encoding}</span>`];
    if (isRunning && o.bitrateKbps !== null) {
        badges.push(
            `<span class="badge badge-sm whitespace-nowrap">${formatBitrate(o.bitrateKbps)}</span>`,
        );
    }
    return `
    <div class="bg-base-100 px-3 py-2 shadow rounded-box w-full flex gap-2 items-start">
        <div class="min-w-0 flex-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <div class="flex items-center gap-2 shrink-0 font-semibold">
                <div aria-label="status" class="status status-lg ${statusClass} mx-1"></div>
                <button class="btn btn-xs ${isStopped ? 'btn-accent' : 'btn-accent btn-outline'}"
                    data-action="${isStopped ? 'start' : 'stop'}" data-out-id="${o.id}">
                    ${isStopped ? 'Start' : 'Stop'}
                </button>
                <span>${o.name}</span>
            </div>
            <code class="text-sm font-normal opacity-60 truncate shrink min-w-0"
                  style="max-width:min(28rem,40%)" title="${o.url}">${o.url}</code>
            ${badges.join('')}
        </div>
        <div class="flex items-center gap-1 shrink-0">
            <button class="btn btn-xs btn-ghost" data-action="edit" data-out-id="${o.id}">✎</button>
            <button class="btn btn-xs btn-ghost text-error ${isStopped ? '' : 'btn-disabled'}"
                data-action="delete" data-out-id="${o.id}">🗙</button>
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

    listEl.innerHTML = pipeline.outs.map((o) => renderOutputCard(o)).join('');

    listEl.onclick = (e) => {
        const btn = (e.target as Element).closest('[data-action]') as HTMLElement | null;
        if (!btn) return;
        const outId = btn.dataset.outId!;
        const action = btn.dataset.action!;
        if (action === 'delete' && btn.classList.contains('btn-disabled')) return;
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
        const hls = new Hls({ liveSyncDurationCount: 3 }) as {
            destroy(): void;
            loadSource(u: string): void;
            attachMedia(v: HTMLVideoElement): void;
            on(e: string, cb: () => void): void;
            Events: { MANIFEST_PARSED: string };
        };
        hls.loadSource(hlsUrl);
        hls.attachMedia(video);
        (hls as unknown as { on(e: string, cb: () => void): void }).on(
            Hls.Events.MANIFEST_PARSED as string,
            () => void video.play(),
        );
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
