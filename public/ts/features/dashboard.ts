import { getConfig, getHealth, getSystemMetrics } from '../core/api.js';
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

let fetchConfigNextTick = true;

async function fetchAndRender(): Promise<void> {
    const doConfig = fetchConfigNextTick;
    fetchConfigNextTick = !fetchConfigNextTick;

    const [configResult, healthResult, metricsResult] = await Promise.all([
        doConfig ? getConfig() : Promise.resolve(null),
        getHealth(),
        getSystemMetrics(),
    ]);

    if (configResult) {
        state.config = configResult;
        if (!state.streamKeys.length && configResult.streamKeys?.length) {
            state.streamKeys = configResult.streamKeys;
        }
        if (configResult.serverName) {
            const el = document.getElementById('server-name-display');
            if (el) el.textContent = configResult.serverName;
            document.title = configResult.serverName;
        }
    }
    if (healthResult) state.health = healthResult;
    if (metricsResult) state.metrics = metricsResult;

    state.pipelines = parsePipelines(state.config, state.health);
    renderPipelines();
    renderMetrics();
}

const POLL_MS = 4000;
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
        fetchConfigNextTick = true;
        startPolling(POLL_MS);
        void refreshDashboard();
    }
});

void (async () => {
    await refreshDashboard();
    startPolling(document.hidden ? HIDDEN_POLL_MS : POLL_MS);
})();
