import {
    getConfig,
    getHealth,
    getSystemMetrics,
    getMetricsHistory,
    isServerUnreachable,
} from '../core/api.js';
import { parsePipelines } from '../core/pipeline.js';
import { state } from '../core/state.js';
import { renderPipelines, renderMetrics } from './render.js';
import { getUrlParam } from '../core/utils.js';

let refreshInFlight: Promise<void> | null = null;
let refreshQueued = false;

export async function refreshDashboard(): Promise<void> {
    if (refreshInFlight) {
        refreshQueued = true;
        return refreshInFlight;
    }

    let lastPromise: Promise<void> | null = null;
    do {
        refreshQueued = false;
        lastPromise = fetchAndRender();
        refreshInFlight = lastPromise;
        try {
            await lastPromise;
        } finally {
            if (refreshInFlight === lastPromise) refreshInFlight = null;
        }
    } while (refreshQueued);
}

let configStale = true;

// The configRev the currently loaded /api/config corresponds to. Each health poll
// carries the server's current rev; when it no longer matches what we loaded, the
// config was edited elsewhere (another dashboard client) and we surface a reload
// banner. null until the first config load.
let loadedConfigRev: number | null = null;

export function invalidateConfig(): void {
    configStale = true;
}

function updateConfigChangedBanner(healthRev: number | undefined): void {
    // configRev is monotonic, so only a health rev ahead of what we loaded means a
    // newer config exists. Using `>` (not `!=`) avoids a false banner from a health
    // snapshot that is momentarily staler than a just-reloaded config.
    const changed =
        loadedConfigRev !== null && healthRev !== undefined && healthRev > loadedConfigRev;
    const banner = document.getElementById('config-changed-banner');
    banner?.classList.toggle('hidden', !changed);
    banner?.classList.toggle('flex', changed);
}

export async function refreshAfterMutation(): Promise<void> {
    invalidateConfig();
    await refreshDashboard();
}

async function fetchAndRender(): Promise<void> {
    const doConfig = configStale;
    configStale = false;

    const inOverview = !getUrlParam('p');
    const [configResult, healthResult, metricsResult, historyResult] = await Promise.all([
        doConfig ? getConfig() : Promise.resolve(null),
        getHealth(),
        getSystemMetrics(),
        inOverview ? getMetricsHistory() : Promise.resolve(null),
    ]);

    if (configResult) {
        state.config = configResult;
        loadedConfigRev = configResult.configRev ?? loadedConfigRev;
        if (configResult.streamKeys?.length) {
            state.streamKeys = configResult.streamKeys;
        }
        if (configResult.serverName) {
            const el = document.getElementById('server-name-display');
            if (el) el.textContent = configResult.serverName;
            document.title = configResult.serverName;
        }
    }
    if (healthResult) {
        state.health = healthResult;
        updateConfigChangedBanner(healthResult.configRev);
    }
    // Recompute even when health couldn't be fetched: if the server itself is
    // unreachable, the connection banner already covers it, so suppress the
    // SRS-down banner to avoid showing two alerts at once.
    const showSrsBanner = !isServerUnreachable() && !!state.health && !state.health.srsReachable;
    const srsBanner = document.getElementById('srs-banner');
    srsBanner?.classList.toggle('hidden', !showSrsBanner);
    srsBanner?.classList.toggle('flex', showSrsBanner);
    const showSrtRelayBanner =
        !isServerUnreachable() &&
        !!state.health.srtRelay &&
        state.health.srtRelay.status !== 'running';
    const srtRelayBanner = document.getElementById('srt-relay-banner');
    const srtRelayBannerText = document.getElementById('srt-relay-banner-text');
    srtRelayBanner?.classList.toggle('hidden', !showSrtRelayBanner);
    srtRelayBanner?.classList.toggle('flex', showSrtRelayBanner);
    if (srtRelayBannerText) {
        srtRelayBannerText.textContent =
            state.health.srtRelay?.lastError && state.health.srtRelay.status !== 'running'
                ? `SRT bonding relay is not responding: ${state.health.srtRelay.lastError}`
                : 'SRT bonding relay is not running — bonded SRT input unavailable';
    }
    if (metricsResult) state.metrics = metricsResult;
    if (historyResult) state.metricsHistory = historyResult;
    state.pipelines = parsePipelines(state.config, state.health);
    renderPipelines();
    renderMetrics();
}

const POLL_MS = 5000;
const HIDDEN_POLL_MS = 30000;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function startPolling(ms: number): void {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => void refreshDashboard(), ms);
}

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        startPolling(HIDDEN_POLL_MS);
    } else {
        startPolling(POLL_MS);
        void refreshDashboard();
    }
});

void (async () => {
    await refreshDashboard();
    startPolling(document.hidden ? HIDDEN_POLL_MS : POLL_MS);
})();
