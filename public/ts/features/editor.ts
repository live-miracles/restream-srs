import * as api from '../core/api.js';
import { state } from '../core/state.js';
import { setUrlParam } from '../core/utils.js';
import { refreshDashboard } from './dashboard.js';
import type { StreamKey } from '../types.js';

// ── Settings ──────────────────────────────────────────

export function openSettings(): void {
    const modal = document.getElementById('settings-modal') as HTMLDialogElement;
    const current = state.config.serverName ?? 'Restream SRS';
    const latency = state.config.srtLatency ?? null;
    const passphrase = state.config.srtPassphrase ?? '';
    (document.getElementById('settings-server-name-input') as HTMLInputElement).value = current;
    (document.getElementById('srt-passphrase-input') as HTMLInputElement).value = passphrase;
    const modeSelect = document.getElementById('srt-latency-mode') as HTMLSelectElement;
    const input = document.getElementById('srt-latency-input') as HTMLInputElement;
    modeSelect.value = latency != null ? 'custom' : 'default';
    input.value = latency != null ? String(latency) : '500';
    toggleSrtLatencyInput();
    modal.showModal();
}

export const openEditSrtLatency = openSettings;

export function toggleSrtLatencyInput(): void {
    const mode = (document.getElementById('srt-latency-mode') as HTMLSelectElement).value;
    const field = document.getElementById('srt-latency-field') as HTMLElement;
    field.classList.toggle('hidden', mode !== 'custom');
}

function getSettingsLatency(): number | null | undefined {
    const mode = (document.getElementById('srt-latency-mode') as HTMLSelectElement).value;
    if (mode === 'custom') {
        const val = parseInt(
            (document.getElementById('srt-latency-input') as HTMLInputElement).value,
        );
        if (isNaN(val) || val < 20 || val > 60000) return undefined;
        return val;
    }
    return null;
}

function getSrtPassphrase(): string | null | undefined {
    const value = (
        document.getElementById('srt-passphrase-input') as HTMLInputElement
    ).value.trim();
    if (!value) return null;
    if (value.length < 10 || value.length > 79) return undefined;
    return value;
}

export async function submitSettingsForm(): Promise<void> {
    const name = (
        document.getElementById('settings-server-name-input') as HTMLInputElement
    ).value.trim();
    const latency = getSettingsLatency();
    const passphrase = getSrtPassphrase();
    if (!name || latency === undefined || passphrase === undefined) return;

    const result = await api.updateSettings(name, latency, passphrase);
    if (result) {
        const el = document.getElementById('server-name-display');
        if (el) el.textContent = name;
        document.title = name;
        (document.getElementById('settings-modal') as HTMLDialogElement).close();
        await refreshDashboard();
    }
}

export const submitSrtLatencyForm = submitSettingsForm;

export async function dismissSrtPending(): Promise<void> {
    await api.dismissSrtLatencyPending();
    await refreshDashboard();
}

// ── Server name ───────────────────────────────────────

export function openEditServerName(): void {
    openSettings();
}

export async function submitServerNameForm(): Promise<void> {
    await submitSettingsForm();
}

// ── Pipeline ──────────────────────────────────────────

function pipeModal(): HTMLDialogElement {
    return document.getElementById('edit-pipe-modal') as HTMLDialogElement;
}

function populateKeySelect(currentKeyId: number): void {
    const select = document.getElementById('pipe-key-select') as HTMLSelectElement;
    const assignedIds = new Set((state.config.pipelines ?? []).map((p) => p.streamKeyId));
    const options: string[] = [];
    for (const k of state.streamKeys as StreamKey[]) {
        if (!assignedIds.has(k.id) || k.id === currentKeyId) {
            const label = k.key.slice(0, 16) + '...';
            const selected = k.id === currentKeyId ? ' selected' : '';
            options.push(`<option value="${k.id}"${selected}>${label}</option>`);
        }
    }
    select.innerHTML = options.join('');
}

export async function createPipeline(): Promise<void> {
    const result = await api.createPipeline();
    if (result) {
        const created = result as { id: string };
        setUrlParam('p', String(created.id));
        await refreshDashboard();
    }
}

export function openEditPipeline(id: string): void {
    const pipeline = state.pipelines.find((p) => p.id === id);
    if (!pipeline) return;
    const modal = pipeModal();
    (document.getElementById('pipe-id-input') as HTMLInputElement).value = id;
    (document.getElementById('pipe-name-input') as HTMLInputElement).value = pipeline.name;
    (document.getElementById('pipe-modal-title') as HTMLElement).textContent = 'Edit Pipeline';
    populateKeySelect(pipeline.streamKeyId);
    modal.showModal();
}

export async function submitPipelineForm(): Promise<void> {
    const id = (document.getElementById('pipe-id-input') as HTMLInputElement).value.trim();
    const name = (document.getElementById('pipe-name-input') as HTMLInputElement).value.trim();
    if (!name) return;
    const streamKeyId = parseInt(
        (document.getElementById('pipe-key-select') as HTMLSelectElement).value,
    );

    const result = await api.updatePipeline(id, name, streamKeyId);
    if (result) {
        pipeModal().close();
        await refreshDashboard();
    }
}

export async function confirmDeletePipeline(id: string): Promise<void> {
    if (!confirm('Delete this pipeline and all its outputs?')) return;
    const ok = await api.deletePipeline(id);
    if (ok) {
        setUrlParam('p', null);
        await refreshDashboard();
    }
}

// ── Output modal ──────────────────────────────────────

const SERVERS = [
    {
        label: 'YouTube RTMP',
        prefix: 'rtmp://a.rtmp.youtube.com/live2/',
        keyLabel: 'Stream Key',
        placeholder: 'xxxx-xxxx-xxxx-xxxx',
    },
    {
        label: 'Facebook RTMP',
        prefix: 'rtmps://live-api-s.facebook.com:443/rtmp/',
        keyLabel: 'Stream Key',
        placeholder: 'xxxx-xxxx-xxxx-xxxx',
    },
    { label: 'Custom RTMP', prefix: '', keyLabel: 'RTMP URL', placeholder: 'rtmp://...' },
    {
        label: 'Custom SRT',
        prefix: '',
        keyLabel: 'SRT URL',
        placeholder: 'srt://host:port?streamid=...',
    },
] as const;

function detectServer(url: string): { idx: number; key: string } {
    for (let i = 0; i < SERVERS.length; i++) {
        const { prefix } = SERVERS[i];
        if (prefix && url.startsWith(prefix)) return { idx: i, key: url.slice(prefix.length) };
    }
    return { idx: url.startsWith('srt://') ? 3 : 2, key: url };
}

function applyServerSelection(idx: number): void {
    const s = SERVERS[idx];
    const legend = document.getElementById('out-key-label');
    const input = document.getElementById('out-key-input') as HTMLInputElement;
    if (legend) legend.textContent = s.keyLabel;
    if (input) input.placeholder = s.placeholder;
}

export function onOutServerChange(): void {
    const select = document.getElementById('out-server-select') as HTMLSelectElement;
    applyServerSelection(parseInt(select.value));
}

function outModal(): HTMLDialogElement {
    return document.getElementById('edit-out-modal') as HTMLDialogElement;
}

function outEncodingOptions(selected: string): string {
    const encodings = state.config.encodings ?? ['source', '720p', '1080p'];
    return encodings
        .map((e) => `<option value="${e}" ${e === selected ? 'selected' : ''}>${e}</option>`)
        .join('');
}

export function openAddOutput(pipelineId: string): void {
    const modal = outModal();
    (document.getElementById('out-pipe-id-input') as HTMLInputElement).value = pipelineId;
    (document.getElementById('out-id-input') as HTMLInputElement).value = '';
    (document.getElementById('out-name-input') as HTMLInputElement).value = '';
    (document.getElementById('out-server-select') as HTMLSelectElement).value = '0';
    (document.getElementById('out-key-input') as HTMLInputElement).value = '';
    applyServerSelection(0);
    const encSelect = document.getElementById('out-encoding-input') as HTMLSelectElement;
    encSelect.innerHTML = outEncodingOptions('source');
    (document.getElementById('out-modal-title') as HTMLElement).textContent = 'Add Output';
    modal.showModal();
}

export function openEditOutput(pipelineId: string, outId: string): void {
    const output = state.config.outputs?.find(
        (o) => o.id === outId && String(o.pipelineId) === pipelineId,
    );
    if (!output) return;
    const { idx, key } = detectServer(output.url);
    const modal = outModal();
    (document.getElementById('out-pipe-id-input') as HTMLInputElement).value = pipelineId;
    (document.getElementById('out-id-input') as HTMLInputElement).value = outId;
    (document.getElementById('out-name-input') as HTMLInputElement).value = output.name;
    (document.getElementById('out-server-select') as HTMLSelectElement).value = String(idx);
    (document.getElementById('out-key-input') as HTMLInputElement).value = key;
    applyServerSelection(idx);
    const encSelect = document.getElementById('out-encoding-input') as HTMLSelectElement;
    encSelect.innerHTML = outEncodingOptions(output.encoding);
    (document.getElementById('out-modal-title') as HTMLElement).textContent = 'Edit Output';
    modal.showModal();
}

export async function submitOutputForm(): Promise<void> {
    const pipelineId = (
        document.getElementById('out-pipe-id-input') as HTMLInputElement
    ).value.trim();
    const outId = (document.getElementById('out-id-input') as HTMLInputElement).value.trim();
    const name = (document.getElementById('out-name-input') as HTMLInputElement).value.trim();
    const serverIdx = parseInt(
        (document.getElementById('out-server-select') as HTMLSelectElement).value,
    );
    const key = (document.getElementById('out-key-input') as HTMLInputElement).value.trim();
    const url = SERVERS[serverIdx].prefix + key;
    const encoding = (document.getElementById('out-encoding-input') as HTMLSelectElement).value;

    if (!name || !key) return;

    let result;
    if (outId) {
        result = await api.updateOutput(pipelineId, outId, { name, url, encoding });
    } else {
        result = await api.createOutput(pipelineId, { name, url, encoding });
    }
    if (result) {
        outModal().close();
        await refreshDashboard();
    }
}

export async function confirmDeleteOutput(pipelineId: string, outId: string): Promise<void> {
    if (!confirm(`Delete output ${outId}?`)) return;
    const ok = await api.deleteOutput(pipelineId, outId);
    if (ok) await refreshDashboard();
}

export async function startOutput(pipelineId: string, outId: string): Promise<void> {
    await api.startOutput(pipelineId, outId);
    await refreshDashboard();
}

export async function stopOutput(pipelineId: string, outId: string): Promise<void> {
    await api.stopOutput(pipelineId, outId);
    await refreshDashboard();
}
