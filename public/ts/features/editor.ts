import * as api from '../core/api.js';
import { state } from '../core/state.js';
import { setUrlParam, maskStreamKey, withBusy } from '../core/utils.js';
import { refreshAfterMutation } from './dashboard.js';
import type { StreamKey } from '../types.js';

// ── Settings ──────────────────────────────────────────

export function openSettings(): void {
    const modal = document.getElementById('settings-modal') as HTMLDialogElement;
    const current = state.config.serverName ?? 'Restream SRS';
    const passphrase = state.config.srtPassphrase ?? '';
    (document.getElementById('settings-server-name-input') as HTMLInputElement).value = current;
    (document.getElementById('settings-public-host-input') as HTMLInputElement).value =
        state.config.publicHost ?? '';
    (document.getElementById('srt-passphrase-input') as HTMLInputElement).value = passphrase;
    (document.getElementById('current-password-input') as HTMLInputElement).value = '';
    (document.getElementById('new-password-input') as HTMLInputElement).value = '';
    (document.getElementById('confirm-password-input') as HTMLInputElement).value = '';
    (document.getElementById('confirm-password-input') as HTMLInputElement).classList.remove(
        'input-error',
    );
    const hasPipelines = (state.config.pipelines?.length ?? 0) > 0;
    const regenBtn = document.getElementById('regen-stream-keys-btn') as HTMLButtonElement;
    const regenHint = document.getElementById('regen-stream-keys-hint') as HTMLElement;
    regenBtn.disabled = hasPipelines;
    regenHint.classList.toggle('hidden', !hasPipelines);
    modal.showModal();
    void api.getVersion().then((v) => {
        if (!v) return;
        (document.getElementById('v-commit') as HTMLElement).textContent = v.commit;
        (document.getElementById('v-srs') as HTMLElement).textContent = v.srs;
        (document.getElementById('v-ffmpeg') as HTMLElement).textContent = v.ffmpeg;
        (document.getElementById('v-os') as HTMLElement).textContent = v.os;
        (document.getElementById('v-kernel') as HTMLElement).textContent = v.kernel;
    });
}

function getSrtPassphrase(): string | null | undefined {
    const value = (
        document.getElementById('srt-passphrase-input') as HTMLInputElement
    ).value.trim();
    if (!value) return null;
    if (value.length < 10 || value.length > 79) return undefined;
    return value;
}

export async function submitSettingsForm(btn?: HTMLButtonElement): Promise<void> {
    const name = (
        document.getElementById('settings-server-name-input') as HTMLInputElement
    ).value.trim();
    const publicHost = (
        document.getElementById('settings-public-host-input') as HTMLInputElement
    ).value.trim();
    const passphrase = getSrtPassphrase();
    if (!name || passphrase === undefined) return;

    const currentPw = (document.getElementById('current-password-input') as HTMLInputElement).value;
    const newPw = (document.getElementById('new-password-input') as HTMLInputElement).value;
    const confirmPw = (document.getElementById('confirm-password-input') as HTMLInputElement).value;
    const confirmEl = document.getElementById('confirm-password-input') as HTMLInputElement;
    const changingPassword = currentPw || newPw || confirmPw;

    if (changingPassword) {
        if (!currentPw || !newPw || !confirmPw || newPw !== confirmPw) {
            confirmEl.classList.add('input-error');
            return;
        }
    }

    await withBusy(btn, async () => {
        const result = await api.updateSettings(name, passphrase, publicHost);
        if (!result) return;

        if (changingPassword) {
            const pwResult = await api.changePassword(currentPw, newPw);
            if (!pwResult) return;
        }

        const el = document.getElementById('server-name-display');
        if (el) el.textContent = name;
        document.title = name;
        (document.getElementById('settings-modal') as HTMLDialogElement).close();
        await refreshAfterMutation();
    });
}

export async function logoutUser(): Promise<void> {
    await api.logout();
    window.location.href = '/login';
}

export async function regenerateStreamKeysBtn(btn?: HTMLButtonElement): Promise<void> {
    if (
        !confirm(
            'Regenerate all stream keys? All existing stream key values will be replaced with new ones.',
        )
    )
        return;
    await withBusy(btn, async () => {
        const result = await api.regenerateStreamKeys();
        if (result) await refreshAfterMutation();
    });
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
            const label = maskStreamKey(k.key);
            const selected = k.id === currentKeyId ? ' selected' : '';
            options.push(`<option value="${k.id}"${selected}>${label}</option>`);
        }
    }
    select.innerHTML = options.join('');
}

export async function createPipeline(btn?: HTMLButtonElement): Promise<void> {
    await withBusy(btn, async () => {
        const result = await api.createPipeline();
        if (result) {
            const created = result as { id: string };
            setUrlParam('p', String(created.id));
            await refreshAfterMutation();
        }
    });
}

export function openEditPipeline(id: string): void {
    const pipeline = state.pipelines.find((p) => p.id === id);
    if (!pipeline) return;
    const modal = pipeModal();
    const nameEl = document.getElementById('pipe-name-input') as HTMLInputElement;
    nameEl.value = pipeline.name;
    nameEl.classList.remove('input-error');
    (document.getElementById('pipe-id-input') as HTMLInputElement).value = id;
    (document.getElementById('pipe-modal-title') as HTMLElement).textContent = 'Edit Pipeline';
    populateKeySelect(pipeline.streamKeyId);
    modal.showModal();
}

export async function submitPipelineForm(btn?: HTMLButtonElement): Promise<void> {
    const id = (document.getElementById('pipe-id-input') as HTMLInputElement).value.trim();
    const nameEl = document.getElementById('pipe-name-input') as HTMLInputElement;
    const name = nameEl.value.trim();
    nameEl.classList.toggle('input-error', !name);
    if (!name) return;
    const streamKeyId = parseInt(
        (document.getElementById('pipe-key-select') as HTMLSelectElement).value,
    );

    await withBusy(btn, async () => {
        const result = await api.updatePipeline(id, name, streamKeyId);
        if (result) {
            pipeModal().close();
            await refreshAfterMutation();
        }
    });
}

export async function confirmDeletePipeline(id: string, btn?: HTMLButtonElement): Promise<void> {
    if (!confirm('Delete this pipeline and all its outputs?')) return;
    await withBusy(btn, async () => {
        const ok = await api.deletePipeline(id);
        if (ok) {
            setUrlParam('p', null);
            await refreshAfterMutation();
        }
    });
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

function clearOutErrors(): void {
    (document.getElementById('out-name-input') as HTMLInputElement).classList.remove('input-error');
    (document.getElementById('out-key-input') as HTMLInputElement).classList.remove('input-error');
}

export function openAddOutput(pipelineId: string): void {
    const modal = outModal();
    const existingCount = (state.config.outputs ?? []).filter(
        (o) => String(o.pipelineId) === pipelineId,
    ).length;
    (document.getElementById('out-pipe-id-input') as HTMLInputElement).value = pipelineId;
    (document.getElementById('out-id-input') as HTMLInputElement).value = '';
    (document.getElementById('out-name-input') as HTMLInputElement).value =
        `Output ${existingCount + 1}`;
    (document.getElementById('out-server-select') as HTMLSelectElement).value = '0';
    (document.getElementById('out-key-input') as HTMLInputElement).value = '';
    clearOutErrors();
    applyServerSelection(0);
    const encSelect = document.getElementById('out-encoding-input') as HTMLSelectElement;
    encSelect.innerHTML = outEncodingOptions('source');
    (document.getElementById('out-modal-title') as HTMLElement).textContent = 'Add Output';
    (document.getElementById('out-save-btn') as HTMLButtonElement).disabled = false;
    (document.getElementById('out-running-hint') as HTMLElement).classList.add('hidden');
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
    clearOutErrors();
    applyServerSelection(idx);
    const encSelect = document.getElementById('out-encoding-input') as HTMLSelectElement;
    encSelect.innerHTML = outEncodingOptions(output.encoding);
    (document.getElementById('out-modal-title') as HTMLElement).textContent = 'Edit Output';

    const pipeline = state.pipelines.find((p) => p.id === pipelineId);
    const isRunning = pipeline?.outs.find((o) => o.id === outId)?.status === 'running';
    const saveBtn = document.getElementById('out-save-btn') as HTMLButtonElement;
    const hint = document.getElementById('out-running-hint') as HTMLElement;
    saveBtn.disabled = isRunning;
    hint.classList.toggle('hidden', !isRunning);

    modal.showModal();
}

export async function submitOutputForm(btn?: HTMLButtonElement): Promise<void> {
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

    const nameEl = document.getElementById('out-name-input') as HTMLInputElement;
    const keyEl = document.getElementById('out-key-input') as HTMLInputElement;
    nameEl.classList.toggle('input-error', !name);
    keyEl.classList.toggle('input-error', !key);
    if (!name || !key) return;

    await withBusy(btn, async () => {
        const result = outId
            ? await api.updateOutput(pipelineId, outId, { name, url, encoding })
            : await api.createOutput(pipelineId, { name, url, encoding });
        if (result) {
            outModal().close();
            await refreshAfterMutation();
        }
    });
}

export async function confirmDeleteOutput(pipelineId: string, outId: string): Promise<void> {
    if (!confirm(`Delete output ${outId}?`)) return;
    const ok = await api.deleteOutput(pipelineId, outId);
    if (ok) await refreshAfterMutation();
}

export async function startOutput(pipelineId: string, outId: string): Promise<void> {
    await api.startOutput(pipelineId, outId);
    // desiredState lives in config, so refetch it (not just health) to flip the
    // Start/Stop label and let the pending-button logic settle correctly.
    await refreshAfterMutation();
}

export async function stopOutput(pipelineId: string, outId: string): Promise<void> {
    await api.stopOutput(pipelineId, outId);
    await refreshAfterMutation();
}
