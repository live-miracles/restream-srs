import type { ConfigData, HealthData, SystemMetrics } from '../types.js';

let loadingCount = 0;

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
    opts: { method?: string; body?: unknown } = {},
): Promise<T | null> {
    const method = opts.method?.toUpperCase() || 'GET';
    const fetchOpts: RequestInit = { method };
    if (opts.body !== undefined) {
        fetchOpts.headers = { 'Content-Type': 'application/json' };
        fetchOpts.body = JSON.stringify(opts.body);
    }
    if (isMutating(method)) setLoading(true);
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
        return data;
    } catch (e) {
        showError('Request failed: ' + String(e));
        return null;
    } finally {
        if (isMutating(method)) setLoading(false);
    }
}

export const getConfig = () => apiRequest<ConfigData>('/config');
export const getHealth = () => apiRequest<HealthData>('/health');
export const getSystemMetrics = () => apiRequest<SystemMetrics>('/metrics/system');

export const updateServerName = (name: string) =>
    apiRequest('/api/settings/server-name', { method: 'POST', body: { name } });

export const updateSettings = (name: string, srtPassphrase: string | null) =>
    apiRequest('/api/settings', { method: 'POST', body: { name, srtPassphrase } });

export const createPipeline = () => apiRequest('/api/pipelines', { method: 'POST' });

export const updatePipeline = (id: string, name: string, streamKeyId?: number) =>
    apiRequest(`/api/pipelines/${id}`, {
        method: 'POST',
        body: streamKeyId !== undefined ? { name, streamKeyId } : { name },
    });

export const deletePipeline = (id: string) =>
    apiRequest(`/api/pipelines/${id}`, { method: 'DELETE' });

export const createOutput = (
    pipelineId: string,
    data: { name: string; url: string; encoding: string },
) => apiRequest(`/api/pipelines/${pipelineId}/outputs`, { method: 'POST', body: data });

export const updateOutput = (
    pipelineId: string,
    outId: string,
    data: { name: string; url: string; encoding: string },
) => apiRequest(`/api/pipelines/${pipelineId}/outputs/${outId}`, { method: 'POST', body: data });

export const deleteOutput = (pipelineId: string, outId: string) =>
    apiRequest(`/api/pipelines/${pipelineId}/outputs/${outId}`, { method: 'DELETE' });

export const startOutput = (pipelineId: string, outId: string) =>
    apiRequest(`/api/pipelines/${pipelineId}/outputs/${outId}/start`, { method: 'POST' });

export const stopOutput = (pipelineId: string, outId: string) =>
    apiRequest(`/api/pipelines/${pipelineId}/outputs/${outId}/stop`, { method: 'POST' });

export const startPreview = (pipelineId: string) =>
    apiRequest<{ hlsUrl: string }>(`/api/pipelines/${pipelineId}/preview/start`, {
        method: 'POST',
    });

export const stopPreview = (pipelineId: string) =>
    apiRequest(`/api/pipelines/${pipelineId}/preview/stop`, { method: 'POST' });

export const logout = () => apiRequest<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });

export const changePassword = (currentPassword: string, newPassword: string) =>
    apiRequest<{ ok: boolean }>('/api/auth/change-password', {
        method: 'POST',
        body: { currentPassword, newPassword },
    });
