import {
    getConfig,
    getHealth,
    getSystemMetrics,
    getOutputErrors,
    isServerUnreachable,
} from '../core/api.js';
import { parsePipelines } from '../core/pipeline.js';
import { state } from '../core/state.js';
import { renderPipelines, renderMetrics } from './render.js';

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

export function invalidateConfig(): void {
    configStale = true;
}

export async function refreshAfterMutation(): Promise<void> {
    invalidateConfig();
    await refreshDashboard();
}

async function fetchAndRender(): Promise<void> {
    const doConfig = configStale;
    configStale = false;

    const [configResult, healthResult, metricsResult, outputErrorsResult] = await Promise.all([
        doConfig ? getConfig() : Promise.resolve(null),
        getHealth(),
        getSystemMetrics(),
        getOutputErrors(),
    ]);

    if (configResult) {
        state.config = configResult;
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
    }
    // Recompute even when health couldn't be fetched: if the server itself is
    // unreachable, the connection banner already covers it, so suppress the
    // SRS-down banner to avoid showing two alerts at once.
    const showSrsBanner = !isServerUnreachable() && !!state.health && !state.health.srsReachable;
    document.getElementById('srs-banner')?.classList.toggle('hidden', !showSrsBanner);
    if (metricsResult) state.metrics = metricsResult;

    state.pipelines = parsePipelines(state.config, state.health, outputErrorsResult ?? undefined);
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
