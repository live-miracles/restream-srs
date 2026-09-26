import { setInnerText, formatBitrate, formatBytesCompact } from '../core/utils.js';
import { state } from '../core/state.js';
import type { PipelineView } from '../types.js';
import {
    getPreviewPipelineId,
    populatePreviewTrackSelect,
    stopCurrentPreview,
    syncPreviewControls,
} from './preview.js';
import { formatUptime } from './input-stats-view.js';

type MetricsViewDeps = {
    setMetricSeverity: (id: string, value: number | null) => void;
};

export function renderMetrics(deps: MetricsViewDeps): void {
    const metrics = state.metrics;
    const cpu = metrics.cpu ?? null;
    const ram = metrics.ram ?? null;
    const disk = metrics.disk ?? null;
    const net = metrics.net ?? null;
    const uptimeSecs = metrics.uptimeSeconds ?? null;
    const cpuPercent = cpu ? cpu.percent : null;
    const ramPercent = ram ? Math.round((ram.usedBytes / ram.totalBytes) * 100) : null;
    const diskPercent = disk ? Math.round((disk.usedBytes / disk.totalBytes) * 100) : null;

    setInnerText(
        'navbar-uptime',
        uptimeSecs !== null ? `Up ${formatUptime(uptimeSecs * 1000)}` : 'Up —',
    );
    setInnerText('navbar-cpu-value', cpu ? `${cpu.cores}c CPU: ${cpuPercent}%` : 'CPU —');
    deps.setMetricSeverity('navbar-cpu-value', cpuPercent);
    setInnerText(
        'navbar-ram-value',
        ram ? `${formatBytesCompact(ram.totalBytes)} RAM: ${ramPercent}%` : 'RAM —',
    );
    deps.setMetricSeverity('navbar-ram-value', ramPercent);
    setInnerText(
        'navbar-disk-value',
        disk ? `${formatBytesCompact(disk.totalBytes)} Disk: ${diskPercent}%` : 'Disk —',
    );
    deps.setMetricSeverity('navbar-disk-value', diskPercent);
    setInnerText(
        'navbar-net-rx',
        net ? `↓ ${formatBitrate((net.rxBytesPerSec * 8) / 1000)}` : '↓ —',
    );
    setInnerText(
        'navbar-net-tx',
        net ? `↑ ${formatBitrate((net.txBytesPerSec * 8) / 1000)}` : '↑ —',
    );
}

export function renderPreview(pipeline: PipelineView): void {
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
