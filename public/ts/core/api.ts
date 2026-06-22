import type {
    ConfigData,
    HealthData,
    PipelineLog,
    OutputPayload,
    SystemMetrics,
    MetricSample,
    SrsLogsData,
} from '../types.js';

let loadingCount = 0;
let serverUnreachable = false;

export function isServerUnreachable(): boolean {
    return serverUnreachable;
}

function setConnectionBanner(unreachable: boolean): void {
    if (unreachable === serverUnreachable) return;
    serverUnreachable = unreachable;
    const banner = document.getElementById('connection-banner');
    banner?.classList.toggle('hidden', !unreachable);
    banner?.classList.toggle('flex', unreachable);
}

function setLoading(active: boolean): void {
    const el = document.getElementById('saving-badge');
    if (active) {
        loadingCount++;
        el?.classList.remove('hidden');
        el?.classList.add('flex');
    } else {
        loadingCount = Math.max(0, loadingCount - 1);
        if (loadingCount === 0) {
            el?.classList.add('hidden');
            el?.classList.remove('flex');
        }
    }
}

function showError(msg: unknown): void {
    const el = document.getElementById('error-msg');
    const alert = document.getElementById('error-alert');
    if (el) el.textContent = String(msg);
    alert?.classList.remove('hidden');
    setTimeout(() => alert?.classList.add('hidden'), 5000);
}

const isMutating = (method: string) => !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());

async function apiRequest<T>(
    url: string,
    opts: { method?: string; body?: unknown; silent?: boolean } = {},
): Promise<T | null> {
    const method = opts.method?.toUpperCase() || 'GET';
    const fetchOpts: RequestInit = { method };
    if (opts.body !== undefined) {
        fetchOpts.headers = { 'Content-Type': 'application/json' };
        fetchOpts.body = JSON.stringify(opts.body);
    }
    const showLoading = isMutating(method) && !opts.silent;
    if (showLoading) setLoading(true);
    try {
        const res = await fetch(url, fetchOpts);
        if (res.status === 401) {
            window.location.href = '/login';
            return null;
        }
        const data = (await res.json()) as T & { error?: string };
        if (!res.ok) {
            showError((data as { error?: string })?.error || `HTTP ${res.status}`);
            return null;
        }
        setConnectionBanner(false);
        return data;
    } catch {
        setConnectionBanner(true);
        return null;
    } finally {
        if (showLoading) setLoading(false);
    }
}

export const getConfig = () => apiRequest<ConfigData>('/api/config');
export const getHealth = () => apiRequest<HealthData>('/api/health');
export const getSystemMetrics = () => apiRequest<SystemMetrics>('/api/metrics/system');
export const getMetricsHistory = () => apiRequest<MetricSample[]>('/api/metrics/history');

export const updateSettings = (name: string, srtPassphrase: string | null, publicHost: string) =>
    apiRequest('/api/settings', { method: 'POST', body: { name, srtPassphrase, publicHost } });

export const createPipeline = () => apiRequest('/api/pipelines', { method: 'POST' });

export const updatePipeline = (id: string, name: string, streamKeyId?: number) =>
    apiRequest(`/api/pipelines/${id}`, {
        method: 'POST',
        body: streamKeyId !== undefined ? { name, streamKeyId } : { name },
    });

export const deletePipeline = (id: string) =>
    apiRequest(`/api/pipelines/${id}`, { method: 'DELETE' });

export const createOutput = (pipelineId: string, data: OutputPayload) =>
    apiRequest(`/api/pipelines/${pipelineId}/outputs`, { method: 'POST', body: data });

export const updateOutput = (pipelineId: string, outId: string, data: OutputPayload) =>
    apiRequest(`/api/pipelines/${pipelineId}/outputs/${outId}`, { method: 'POST', body: data });

export const deleteOutput = (pipelineId: string, outId: string) =>
    apiRequest(`/api/pipelines/${pipelineId}/outputs/${outId}`, { method: 'DELETE' });

export const startOutput = (pipelineId: string, outId: string) =>
    apiRequest(`/api/pipelines/${pipelineId}/outputs/${outId}/start`, { method: 'POST' });

export const stopOutput = (pipelineId: string, outId: string) =>
    apiRequest(`/api/pipelines/${pipelineId}/outputs/${outId}/stop`, { method: 'POST' });

export const startPreview = (pipelineId: string, audioTrackCount?: number) =>
    apiRequest<{ hlsUrl: string }>(`/api/pipelines/${pipelineId}/preview/start`, {
        method: 'POST',
        body: { audioTrackCount: audioTrackCount ?? 1 },
        silent: true,
    });

export const stopPreview = (pipelineId: string) =>
    apiRequest(`/api/pipelines/${pipelineId}/preview/stop`, { method: 'POST', silent: true });

export const logout = () => apiRequest<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });

export const getVersion = () =>
    apiRequest<{ commit: string; srs: string; ffmpeg: string; os: string; kernel: string }>(
        '/api/version',
    );

export const changePassword = (currentPassword: string, newPassword: string) =>
    apiRequest<{ ok: boolean }>('/api/auth/change-password', {
        method: 'POST',
        body: { currentPassword, newPassword },
    });

export const regenerateStreamKeys = () =>
    apiRequest<{ streamKeys: unknown[] }>('/api/settings/regenerate-stream-keys', {
        method: 'POST',
    });

export const getPipelineLogs = (pipelineId: string) =>
    apiRequest<PipelineLog[]>(`/api/pipelines/${pipelineId}/logs`);

export const getSrsLogs = () => apiRequest<SrsLogsData>('/api/srs-logs');
