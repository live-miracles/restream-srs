import * as api from '../core/api.js';
import { state } from '../core/state.js';
import { escapeHtml, fmtMs, fmtMbpsValue } from '../core/utils.js';
import type { LegHistoryData, LegHistorySample } from '../types.js';

const MAX_HOST_PROBE_TARGETS = 10;

// Upper bound on selectable audio tracks. Outputs are often configured before
// the pipeline's input has ever connected (so nothing has been probed yet), so
// the track list is a static range rather than derived from live probe data.
const MAX_AUDIO_TRACKS = 50;
const LEG_HISTORY_WINDOW_MS = 30 * 60 * 1000;
const LEG_HISTORY_PAGE_STEP_MS = 10 * 60 * 1000;
const legHistoryOffsets = new Map<string, number>();
const legHistoryCache = new Map<string, LegHistoryData>();
const legHistoryRequestIds = new Map<string, number>();
const legHistoryInFlight = new Set<string>();

function formatLegChartTimeTick(ts: number): string {
    const date = new Date(ts);
    const minutes = date.getMinutes();
    if (minutes % 5 !== 0) return '';
    const minuteLabel = minutes.toString().padStart(2, '0');
    if (minutes % 10 !== 0) return minuteLabel;
    return `${date.getHours().toString().padStart(2, '0')}:${minuteLabel}`;
}

function legHistoryChart(
    canvasId: string,
    series: LegHistoryData['legs'],
    value: (sample: LegHistorySample) => number | null,
    maxValue: number,
    formatValue: (value: number) => string,
): void {
    const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const width = canvas.clientWidth || 640;
    const height = canvas.clientHeight || 130;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
    const styles = getComputedStyle(canvas);
    const color = styles.color || '#9ca3af';
    const grid = 'rgba(156, 163, 175, 0.18)';
    const left = 42;
    const right = 8;
    const top = 8;
    const bottom = 22;
    const plotW = Math.max(1, width - left - right);
    const plotH = Math.max(1, height - top - bottom);
    const allSamples = series.flatMap((leg) => leg.samples);
    const minTs = Math.min(...allSamples.map((sample) => sample.ts));
    const maxTs = Math.max(...allSamples.map((sample) => sample.ts));
    const range = Math.max(1, maxTs - minTs);
    const observedMax = Math.max(...allSamples.map((sample) => value(sample) ?? 0));
    // Keep a configured ceiling for charts that need one, but let sparse or
    // low-valued series use their own range so small loss spikes are visible.
    const yMax = maxValue > 0 ? maxValue : observedMax > 0 ? observedMax * 1.2 : 1;
    ctx.clearRect(0, 0, width, height);
    ctx.font = '10px sans-serif';
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.65;
    const tickMinutes = 1;
    const tickIntervalMs = tickMinutes * 60_000;
    const firstMinute = Math.ceil(minTs / tickIntervalMs) * tickIntervalMs;
    ctx.textAlign = 'center';
    for (let tickTs = firstMinute; tickTs <= maxTs; tickTs += tickIntervalMs) {
        const x = left + ((tickTs - minTs) / range) * plotW;
        ctx.strokeStyle = grid;
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, height - bottom);
        ctx.stroke();
        ctx.fillText(formatLegChartTimeTick(tickTs), x, height - 5);
    }
    ctx.textAlign = 'start';
    for (let i = 0; i <= 2; i++) {
        const y = top + (plotH * i) / 2;
        ctx.strokeStyle = grid;
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(width - right, y);
        ctx.stroke();
        ctx.fillText(formatValue(yMax * (1 - i / 2)), 2, y + 3);
    }
    ctx.globalAlpha = 1;
    const colors = ['#38bdf8', '#a78bfa', '#f59e0b', '#34d399', '#fb7185', '#f97316'];
    series.forEach((leg, legIndex) => {
        const points = leg.samples
            .map((sample) => {
                const current = value(sample);
                if (current === null) return null;
                return {
                    x: left + ((sample.ts - minTs) / range) * plotW,
                    y: top + (1 - Math.min(1, Math.max(0, current / yMax))) * plotH,
                };
            })
            .filter((point): point is { x: number; y: number } => point !== null);
        if (points.length === 0) return;
        ctx.strokeStyle = colors[legIndex % colors.length];
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        points.forEach((point, index) => {
            if (index === 0) ctx.moveTo(point.x, point.y);
            else ctx.lineTo(point.x, point.y);
        });
        ctx.stroke();
        if (points.length === 1) {
            ctx.fillStyle = ctx.strokeStyle;
            ctx.beginPath();
            ctx.arc(points[0].x, points[0].y, 2.5, 0, Math.PI * 2);
            ctx.fill();
        }
    });
}

function renderLegHistoryCharts(pipelineId: string, data: LegHistoryData): void {
    const wrap = document.getElementById('srt-leg-history-content');
    if (!wrap) return;
    if (data.legs.length === 0 || data.legs.every((leg) => leg.samples.length === 0)) {
        wrap.innerHTML =
            '<p class="text-sm opacity-50">No SRT input history is available for this period.</p>';
        delete wrap.dataset.chartMode;
        return;
    }
    const fmt = (value: number) => (value >= 10 ? value.toFixed(0) : value.toFixed(1));
    const hasLossTotals = data.legs.some((leg) =>
        leg.samples.some((sample) => sample.lossTotal != null),
    );
    const hasDropTotals = data.legs.some((leg) =>
        leg.samples.some((sample) => sample.dropTotal != null),
    );
    if (!hasLossTotals && !hasDropTotals) {
        wrap.innerHTML =
            '<p class="text-sm opacity-50">No SRT packet loss/drop history is available for this period.</p>';
        delete wrap.dataset.chartMode;
        return;
    }
    const chartMode = `${hasLossTotals ? 'loss' : ''}${hasDropTotals ? 'drop' : ''}`;
    const legend = data.legs
        .map(
            (leg, index) =>
                `<span class="inline-flex items-center gap-1 text-xs"><span class="inline-block h-2 w-2 rounded-full" style="background:${['#38bdf8', '#a78bfa', '#f59e0b', '#34d399', '#fb7185', '#f97316'][index % 6]}"></span>${escapeHtml(leg.ip)}</span>`,
        )
        .join('');
    if (wrap.dataset.chartMode !== chartMode) {
        const lossChart = hasLossTotals
            ? '<div><div class="text-xs opacity-60 mb-1">Cumulative packet loss</div><canvas id="srt-leg-loss-chart" class="w-full h-32 text-base-content"></canvas></div>'
            : '';
        const dropChart = hasDropTotals
            ? '<div><div class="text-xs opacity-60 mb-1">Cumulative packet drops</div><canvas id="srt-leg-drop-chart" class="w-full h-32 text-base-content"></canvas></div>'
            : '';
        wrap.innerHTML = `<div class="flex flex-wrap gap-x-3 gap-y-1 mb-2">${legend}</div>
            <div class="grid grid-cols-1 gap-4">
                ${lossChart}
                ${dropChart}
            </div>`;
        wrap.dataset.chartMode = chartMode;
    }
    if (hasLossTotals) {
        legHistoryChart(
            'srt-leg-loss-chart',
            data.legs,
            (sample) => sample.lossTotal ?? null,
            0,
            (value) => fmt(value),
        );
    }
    if (hasDropTotals) {
        legHistoryChart(
            'srt-leg-drop-chart',
            data.legs,
            (sample) => sample.dropTotal ?? null,
            0,
            (value) => fmt(value),
        );
    }
}

function mergeLegHistory(
    pipelineId: string,
    data: LegHistoryData,
    from: number,
    to: number,
): LegHistoryData {
    const cached = legHistoryCache.get(pipelineId);
    if (!cached) {
        legHistoryCache.set(pipelineId, data);
        return data;
    }

    // The relay identifies a leg by source IP. Its port can change when the
    // sender reconnects, so including the port here would split one source
    // into multiple chart series and colors.
    const incomingByKey = new Map(data.legs.map((leg) => [leg.ip, leg]));
    const cachedByKey = new Map(cached.legs.map((leg) => [leg.ip, leg]));
    const keys = new Set([...cachedByKey.keys(), ...incomingByKey.keys()]);
    const legs = [...keys].map((key) => {
        const previous = cachedByKey.get(key);
        const incoming = incomingByKey.get(key);
        const samplesByTimestamp = new Map(
            (previous?.samples ?? []).map((sample) => [sample.ts, sample]),
        );
        for (const sample of incoming?.samples ?? []) samplesByTimestamp.set(sample.ts, sample);
        return {
            ip: incoming?.ip ?? previous!.ip,
            port: incoming?.port ?? previous!.port,
            samples: [...samplesByTimestamp.values()]
                .filter((sample) => sample.ts >= from && sample.ts <= to)
                .sort((a, b) => a.ts - b.ts),
        };
    });
    const merged = { ...data, from, to, legs };
    legHistoryCache.set(pipelineId, merged);
    return merged;
}

async function loadLegHistory(pipelineId: string, showLoading = true): Promise<void> {
    const offset = legHistoryOffsets.get(pipelineId) ?? 0;
    const requestKey = `${pipelineId}:${offset}`;
    if (legHistoryInFlight.has(requestKey)) return;
    legHistoryInFlight.add(requestKey);

    const requestId = (legHistoryRequestIds.get(pipelineId) ?? 0) + 1;
    legHistoryRequestIds.set(pipelineId, requestId);
    const isCurrentRequest = (): boolean => {
        if (legHistoryRequestIds.get(pipelineId) !== requestId) return false;
        const details = document.getElementById('srt-bonding-details');
        return !details?.dataset.pipelineId || details.dataset.pipelineId === pipelineId;
    };
    const to = Date.now() - offset;
    const from = to - LEG_HISTORY_WINDOW_MS;
    const content = document.getElementById('srt-leg-history-content');
    if (content && showLoading) {
        // The chart canvases are about to be replaced by the placeholder, so
        // drop the chart-mode marker too — otherwise renderLegHistoryCharts
        // sees a matching mode on the next render and skips recreating the
        // canvases it just lost, leaving this placeholder on screen forever.
        delete content.dataset.chartMode;
        content.innerHTML = '<p class="text-sm opacity-50">Loading leg history…</p>';
    }
    const cached = offset === 0 ? legHistoryCache.get(pipelineId) : undefined;
    const cachedTimestamps =
        cached?.legs.flatMap((leg) => leg.samples.map((sample) => sample.ts)) ?? [];
    const latestCachedTs = cachedTimestamps.length > 0 ? Math.max(...cachedTimestamps) : undefined;
    try {
        const data = await api.getLegHistory(pipelineId, from, to, latestCachedTs);
        if (!isCurrentRequest()) return;
        const content = document.getElementById('srt-leg-history-content');
        if (!content) return;
        if (!data) {
            content.innerHTML =
                '<p class="text-sm text-error">Unable to load SRT input history. Please try again.</p>';
            return;
        }
        const displayData = offset === 0 ? mergeLegHistory(pipelineId, data, from, to) : data;
        const range = document.getElementById('srt-leg-history-range');
        if (range) {
            const fmt = (ts: number) =>
                new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            range.innerHTML =
                offset === 0
                    ? '<span class="badge badge-success badge-xs gap-1">LIVE</span>'
                    : `<span class="font-mono text-xs opacity-60">${fmt(data.from)} – ${fmt(data.to)}</span>`;
        }
        const back = document.getElementById('srt-leg-history-back') as HTMLButtonElement | null;
        const forward = document.getElementById(
            'srt-leg-history-forward',
        ) as HTMLButtonElement | null;
        if (back) back.disabled = data.oldestTs === null || data.from <= data.oldestTs;
        if (forward) forward.disabled = offset === 0;
        renderLegHistoryCharts(pipelineId, displayData);
    } catch {
        if (!isCurrentRequest()) return;
        const content = document.getElementById('srt-leg-history-content');
        if (content) {
            content.innerHTML =
                '<p class="text-sm text-error">Unable to load SRT input history. Please try again.</p>';
        }
    } finally {
        legHistoryInFlight.delete(requestKey);
    }
}

function renderLegHistorySection(pipelineId: string): string {
    return `<div id="srt-leg-history-section" class="mt-1">
        <div class="mb-2 flex items-center justify-center gap-2 px-1">
            <div class="flex items-center gap-1">
                <button id="srt-leg-history-back" type="button" class="btn btn-xs btn-ghost">&#8592; 10 min</button>
                <span id="srt-leg-history-range" class="inline-flex w-36 justify-center whitespace-nowrap"><span class="badge badge-success badge-xs gap-1">LIVE</span></span>
                <button id="srt-leg-history-forward" type="button" class="btn btn-xs btn-ghost" disabled>10 min &#8594;</button>
            </div>
        </div>
        <div id="srt-leg-history-content"><p class="text-sm opacity-50">Loading leg history…</p></div>
    </div>`;
}

function srtDetailRow(label: string, value: string): string {
    return `<div class="flex items-center gap-3 py-1 border-b border-base-content/10 last:border-b-0">
        <span class="opacity-60">${label}</span>
        <span>${value}</span>
    </div>`;
}

function srtDetailSection(title: string, rowsHtml: string): string {
    return `<div class="mb-4">
        <div class="text-xs font-semibold uppercase opacity-50 mb-1">${escapeHtml(title)}</div>
        <div class="text-xs">${rowsHtml}</div>
    </div>`;
}

function fmtRawCount(n: number | null | undefined): string {
    return n != null ? n.toLocaleString() : '—';
}

// Full, unabbreviated dump of every field the relay reports for a stream's
// input/output/legs — the compact stats row and bonded-legs table only
// surface a curated subset, this is the "show me everything" escape hatch.
// Split from showSrtBondingDetails so the modal's refresh button can re-pull
// the latest polled state.pipelines snapshot without reopening the dialog.
function renderSrtBondingDetailsContent(pipelineId: string, target?: HTMLElement | null): void {
    const titleEl = document.getElementById('logs-modal-title');
    const contentEl = target ?? document.getElementById('logs-modal-content');
    if (!contentEl) return;

    const pipeline = state.pipelines.find((p) => p.id === pipelineId);
    if (titleEl) titleEl.textContent = `SRT Bonding Details — ${pipeline?.name ?? pipelineId}`;
    if (!pipeline) {
        contentEl.innerHTML = '<p class="opacity-50 text-sm">No SRT bonding data.</p>';
        return;
    }

    const { input, output } = pipeline.srtBonding;

    const inputRows = (
        input.legs.length > 0
            ? [
                  srtDetailRow('Recv Packets Total', fmtRawCount(input.recvPacketsTotal)),
                  srtDetailRow(
                      'Recv Unique Packets Total',
                      fmtRawCount(input.recvUniquePacketsTotal),
                  ),
                  srtDetailRow('Recv Drop Total', fmtRawCount(input.recvDropTotal)),
                  srtDetailRow('Latency', fmtMs(input.latencyMs)),
              ]
            : [
                  srtDetailRow('Recv Packets Total', fmtRawCount(input.recvPacketsTotal)),
                  srtDetailRow(
                      'Recv Unique Packets Total',
                      fmtRawCount(input.recvUniquePacketsTotal),
                  ),
                  srtDetailRow('Recv Loss Total', fmtRawCount(input.recvLossTotal)),
                  srtDetailRow('Recv Drop Total', fmtRawCount(input.recvDropTotal)),
                  srtDetailRow('Retransmit Total', fmtRawCount(input.retransTotal)),
                  srtDetailRow('RTT', fmtMs(input.rttMs)),
                  srtDetailRow('Latency', fmtMs(input.latencyMs)),
                  srtDetailRow('Bandwidth', fmtMbpsValue(input.bandwidthMbps)),
                  srtDetailRow('Recv Rate', fmtMbpsValue(input.recvRateMbps)),
                  srtDetailRow('Belated Total', fmtRawCount(input.belatedTotal)),
                  srtDetailRow('Belated Avg', fmtMs(input.belatedAvgMs)),
                  srtDetailRow('Undecrypt Total', fmtRawCount(input.undecryptTotal)),
                  srtDetailRow('Reorder Distance', fmtRawCount(input.reorderDistance)),
                  srtDetailRow('Recv Buffer', fmtMs(input.rcvBufMs)),
              ]
    ).join('');

    const outputRows = [
        srtDetailRow('Sent Packets Total', fmtRawCount(output.sentPacketsTotal)),
        srtDetailRow('Send Loss Total', fmtRawCount(output.sendLossTotal)),
        srtDetailRow('Send Drop Total', fmtRawCount(output.sendDropTotal)),
        srtDetailRow('Retransmit Total', fmtRawCount(output.retransTotal)),
        srtDetailRow('RTT', fmtMs(output.rttMs)),
        srtDetailRow('Latency', fmtMs(output.latencyMs)),
        srtDetailRow('Bandwidth', fmtMbpsValue(output.bandwidthMbps)),
        srtDetailRow('Send Rate', fmtMbpsValue(output.sendRateMbps)),
        srtDetailRow('Undecrypt Total', fmtRawCount(output.undecryptTotal)),
        srtDetailRow('Send Buffer', fmtMs(output.sndBufMs)),
    ].join('');

    const legsHtml =
        input.legs.length === 0
            ? '<p class="opacity-50 text-sm">No bonded legs.</p>'
            : input.legs
                  .map((leg, idx) => {
                      const legRows = [
                          srtDetailRow('IP', escapeHtml(leg.ip)),
                          srtDetailRow('Port', String(leg.port)),
                          srtDetailRow(
                              'Health',
                              (
                                  leg.health ?? (leg.state === 'running' ? 'ok' : 'warn')
                              ).toUpperCase(),
                          ),
                          ...(leg.healthReason
                              ? [srtDetailRow('Health issue', escapeHtml(leg.healthReason))]
                              : []),
                          srtDetailRow('State', escapeHtml(leg.state)),
                          srtDetailRow('RTT', fmtMs(leg.rttMs)),
                          srtDetailRow('Latency', fmtMs(leg.latencyMs)),
                          srtDetailRow('Recv Packets Total', fmtRawCount(leg.recvPacketsTotal)),
                          srtDetailRow(
                              'Recv Unique Packets Total',
                              fmtRawCount(leg.recvUniquePacketsTotal),
                          ),
                          srtDetailRow('Recv Loss Total', fmtRawCount(leg.recvLossTotal)),
                          srtDetailRow('Recv Drop Total', fmtRawCount(leg.recvDropTotal)),
                          srtDetailRow('Retransmit Total', fmtRawCount(leg.retransTotal)),
                          srtDetailRow('Bandwidth', fmtMbpsValue(leg.bandwidthMbps)),
                          srtDetailRow('Recv Rate', fmtMbpsValue(leg.recvRateMbps)),
                          srtDetailRow('Belated Total', fmtRawCount(leg.belatedTotal)),
                          srtDetailRow('Belated Avg', fmtMs(leg.belatedAvgMs)),
                          srtDetailRow('Undecrypt Total', fmtRawCount(leg.undecryptTotal)),
                          srtDetailRow('Reorder Distance', fmtRawCount(leg.reorderDistance)),
                          srtDetailRow('Recv Buffer', fmtMs(leg.rcvBufMs)),
                      ].join('');
                      return srtDetailSection(`Leg ${idx + 1} — ${escapeHtml(leg.ip)}`, legRows);
                  })
                  .join('');

    contentEl.innerHTML =
        renderLegHistorySection(pipelineId) +
        srtDetailSection('Input', inputRows) +
        srtDetailSection('Output', outputRows) +
        legsHtml;
    document.getElementById('srt-leg-history-back')?.addEventListener('click', () => {
        legHistoryOffsets.set(
            pipelineId,
            (legHistoryOffsets.get(pipelineId) ?? 0) + LEG_HISTORY_PAGE_STEP_MS,
        );
        void loadLegHistory(pipelineId);
    });
    document.getElementById('srt-leg-history-forward')?.addEventListener('click', () => {
        legHistoryOffsets.set(
            pipelineId,
            Math.max(0, (legHistoryOffsets.get(pipelineId) ?? 0) - LEG_HISTORY_PAGE_STEP_MS),
        );
        void loadLegHistory(pipelineId);
    });
    void loadLegHistory(pipelineId);
}

export function renderSrtBondingDetailsInline(pipelineId: string): void {
    const target = document.getElementById('srt-bonding-details');
    if (!target) return;
    const alreadyRendered =
        target.dataset.pipelineId === pipelineId &&
        !!document.getElementById('srt-leg-history-section');
    if (alreadyRendered) {
        // Poll refreshes re-render the live dashboard every five seconds. Do
        // not restart a paged historical request on each poll, otherwise a
        // slow request can be perpetually superseded before it renders.
        if ((legHistoryOffsets.get(pipelineId) ?? 0) === 0) {
            void loadLegHistory(pipelineId, false);
        }
        return;
    }
    target.dataset.pipelineId = pipelineId;
    renderSrtBondingDetailsContent(pipelineId, target);
    const graphs = document.getElementById('srt-bonding-graphs');
    const history = target.querySelector('#srt-leg-history-section');
    if (graphs && history) {
        graphs.innerHTML = '';
        graphs.append(history);
    }
}

function hideLogsModalClearErrors(): void {
    const clearBtn = document.getElementById('logs-modal-clear-errors') as HTMLButtonElement | null;
    if (!clearBtn) return;
    clearBtn.classList.add('hidden');
    clearBtn.onclick = null;
}

export function showSrtBondingDetails(pipelineId: string): void {
    const modal = document.getElementById('logs-modal') as HTMLDialogElement | null;
    const refreshBtn = document.getElementById('logs-modal-refresh');
    if (!modal) return;
    hideLogsModalClearErrors();

    renderSrtBondingDetailsContent(pipelineId);
    if (refreshBtn) {
        refreshBtn.classList.remove('hidden');
        refreshBtn.classList.add('inline-flex');
        refreshBtn.onclick = () => renderSrtBondingDetailsContent(pipelineId);
    }
    modal.showModal();
}

const LOG_TERMINALS: { label: string; elId: string; key: 'srs' | 'dashboard' | 'relay' }[] = [
    { label: 'Dashboard', elId: 'dashboard-log-tail', key: 'dashboard' },
    { label: 'SRS', elId: 'srs-log-tail', key: 'srs' },
    { label: 'Relay', elId: 'relay-log-tail', key: 'relay' },
];

// Maps ANSI SGR foreground codes to the same severity colors SRS itself
// uses (red for its ERROR lines, yellow for WARN), so the web terminal
// mirrors a real terminal instead of hand-matching level text.
const ANSI_FG_CLASS: Record<string, string> = {
    '31': 'text-error',
    '91': 'text-error',
    '33': 'text-warning',
    '93': 'text-warning',
    '32': 'text-success',
    '92': 'text-success',
    '34': 'text-info',
    '94': 'text-info',
    '36': 'text-info',
    '96': 'text-info',
    '35': 'text-secondary',
    '95': 'text-secondary',
};
const ANSI_SGR_REGEX = /\x1b\[([0-9;]*)m/g;
