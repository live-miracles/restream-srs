import {
    getConfig,
    getHealth,
    getHostProbes,
    getSystemMetrics,
    getMetricsHistory,
} from '../core/api.js';
import { parsePipelines } from '../core/pipeline.js';
import { state } from '../core/state.js';
import { getUrlParam } from '../core/utils.js';
import { publishDashboardSnapshot } from '../store.js';
import { dashboardUi } from '../ui.js';

let refreshInFlight: Promise<void> | null = null;
let refreshQueued = false;

export function invalidateHostProbes(): void {
    state.hostProbes = {};
}

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

function mergeMetricsHistory(samples: import('../types.js').MetricSample[]): void {
    if (samples.length === 0) return;
    const byTimestamp = new Map(state.metricsHistory.map((sample) => [sample.ts, sample]));
    for (const sample of samples) byTimestamp.set(sample.ts, sample);
    state.metricsHistory = [...byTimestamp.values()].sort((a, b) => a.ts - b.ts);
}

// The configRev the currently loaded /api/config corresponds to. Each health poll
// carries the server's current rev; when it no longer matches what we loaded, the
// config was edited elsewhere (another dashboard client) and we surface a reload
// banner. null until the first config load.
let loadedConfigRev: number | null = null;

export function invalidateConfig(): void {
    configStale = true;
}

// The config was edited in another session (every health snapshot carries the
// server's current configRev). Refetch it automatically instead of asking the
// user to click a reload button: a config reload is just another GET + render,
// identical to any poll, and edit forms live in static modals so nothing is
// ripped out from under the operator. Without this, other clients showed stale
// Start/Stop state until someone noticed the banner.
function resyncConfigIfChanged(healthRev: number | undefined): void {
    // configRev is monotonic, so only a health rev ahead of what we loaded means
    // a newer config exists. Using `>` (not `!=`) avoids a spurious refetch from
    // a health snapshot that is momentarily staler than a just-reloaded config.
    const changed =
        loadedConfigRev !== null && healthRev !== undefined && healthRev > loadedConfigRev;
    if (!changed) return;
    invalidateConfig();
    // Queues a follow-up pass on the in-flight refresh; the refetched config
    // advances loadedConfigRev, so this converges instead of looping.
    void refreshDashboard();
}

export async function refreshAfterMutation(): Promise<void> {
    invalidateConfig();
    invalidateHostProbes();
    await refreshDashboard();
}

export async function refreshHostProbes(hours = 6): Promise<void> {
    const hostProbesResult = await getHostProbes(hours);
    if (hostProbesResult) {
        state.hostProbes = hostProbesResult;
        publishDashboardSnapshot(
            state.config as import('../types.js').ConfigData,
            state.metrics,
            state.pipelines,
            state.hostProbes,
        );
    }
}

async function fetchAndRender(): Promise<void> {
    const doConfig = configStale;
    configStale = false;

    const inOverview = !getUrlParam('p');
    const latestMetricTs = state.metricsHistory.at(-1)?.ts;
    const [configResult, healthResult, metricsResult, historyResult] = await Promise.all([
        doConfig ? getConfig() : Promise.resolve(null),
        getHealth(),
        getSystemMetrics(),
        inOverview ? getMetricsHistory(latestMetricTs) : Promise.resolve(null),
    ]);

    if (configResult) {
        state.config = configResult;
        loadedConfigRev = configResult.configRev ?? loadedConfigRev;
        if (configResult.streamKeys?.length) {
            state.streamKeys = configResult.streamKeys;
        }
        if (configResult.serverName) {
            document.title = configResult.serverName;
        }
    }
    if (healthResult) {
        state.health = healthResult;
        resyncConfigIfChanged(healthResult.configRev);
    }
    dashboardUi.update((current) => ({
        ...current,
        srsReachable: state.health.srsReachable ?? null,
        srtRelay: state.health.srtRelay ?? null,
    }));
    if (metricsResult) state.metrics = metricsResult;
    if (historyResult) mergeMetricsHistory(historyResult);
    state.pipelines = parsePipelines(state.config, state.health);
    publishDashboardSnapshot(
        state.config as import('../types.js').ConfigData,
        state.metrics,
        state.pipelines,
        state.hostProbes,
    );
}

const POLL_MS = 5000;
const HIDDEN_POLL_MS = 30000;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function startPolling(ms: number): void {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => void refreshDashboard(), ms);
}

export interface DashboardPolling {
    ready: Promise<void>;
    stop: () => void;
}

export function startDashboardPolling(): DashboardPolling {
    const onVisibilityChange = (): void => {
        if (document.hidden) {
            startPolling(HIDDEN_POLL_MS);
        } else {
            startPolling(POLL_MS);
            void refreshDashboard();
        }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    const ready = refreshDashboard().finally(() => {
        startPolling(document.hidden ? HIDDEN_POLL_MS : POLL_MS);
    });

    const stop = (): void => {
        document.removeEventListener('visibilitychange', onVisibilityChange);
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    };

    return { ready, stop };
}
