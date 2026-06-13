import * as api from '../core/api.js';
import { state } from '../core/state.js';
import { setUrlParam, maskStreamKey, withBusy } from '../core/utils.js';
import { refreshAfterMutation } from './dashboard.js';
import type { StreamKey, AudioTrackInfo, PullMethod } from '../types.js';

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
    { label: 'Restream RTMP', prefix: '', keyLabel: 'Pipeline', placeholder: '' },
    { label: 'Restream SRT', prefix: '', keyLabel: 'Pipeline', placeholder: '' },
] as const;

const RESTREAM_RTMP_IDX = 4;
const RESTREAM_SRT_IDX = 5;

function isRestreamIdx(idx: number): boolean {
    return idx === RESTREAM_RTMP_IDX || idx === RESTREAM_SRT_IDX;
}

const RESTREAM_RTMP_PREFIX = 'rtmp://localhost:1935/live/';
const RESTREAM_SRT_PREFIX = 'srt://localhost:10080?streamid=#!::r=live/';

function restreamRtmpUrl(streamKey: string): string {
    return `${RESTREAM_RTMP_PREFIX}${streamKey}`;
}

function restreamSrtUrl(streamKey: string): string {
    const passphrase = state.config.srtPassphrase;
    const url = `${RESTREAM_SRT_PREFIX}${streamKey},m=publish`;
    if (!passphrase) return url;
    return `${url}&passphrase=${encodeURIComponent(passphrase)}&pbkeylen=16`;
}

function detectServer(url: string): { idx: number; key: string } {
    if (url.startsWith(RESTREAM_RTMP_PREFIX)) {
        const sk = url.slice(RESTREAM_RTMP_PREFIX.length);
        const p = (state.config.pipelines ?? []).find((p) => p.streamKey === sk);
        if (p) return { idx: RESTREAM_RTMP_IDX, key: p.id };
    }
    if (url.startsWith(RESTREAM_SRT_PREFIX) && url.includes('m=publish')) {
        const sk = url.slice(RESTREAM_SRT_PREFIX.length).split(',')[0];
        const p = (state.config.pipelines ?? []).find((p) => p.streamKey === sk);
        if (p) return { idx: RESTREAM_SRT_IDX, key: p.id };
    }
    for (let i = 0; i < SERVERS.length; i++) {
        const { prefix } = SERVERS[i];
        if (prefix && url.startsWith(prefix)) return { idx: i, key: url.slice(prefix.length) };
    }
    return { idx: url.startsWith('srt://') ? 3 : 2, key: url };
}

function restreamPipelineOpts(selectedId: string): string {
    const pipelines = state.config.pipelines ?? [];
    if (!pipelines.length) return '<option value="" disabled>No pipelines</option>';
    return pipelines
        .map(
            (p) =>
                `<option value="${escapeAttr(String(p.id))}"${String(p.id) === selectedId ? ' selected' : ''}>${escapeAttr(p.name)}</option>`,
        )
        .join('');
}

function sinkKeyFieldHtml(idx: number, key: string): string {
    if (isRestreamIdx(idx)) {
        return `<select class="select select-sm w-full js-sink-key">${restreamPipelineOpts(key)}</select>`;
    }
    const s = SERVERS[idx];
    return `<input type="text" class="input input-sm w-full font-mono text-xs js-sink-key"
               placeholder="${s.placeholder}" value="${escapeAttr(key)}"
               oninput="this.classList.remove('input-error')" />`;
}

function outModal(): HTMLDialogElement {
    return document.getElementById('edit-out-modal') as HTMLDialogElement;
}

function outVideoEncodingOptions(selected: string): string {
    const encodings = state.config.encodings ?? ['copy', '720p', '1080p'];
    return encodings
        .map((e) => `<option value="${e}" ${e === selected ? 'selected' : ''}>${e}</option>`)
        .join('');
}

function escapeAttr(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// Tracks for the pipeline whose output modal is currently open. Captured when the
// modal opens so the global add-sink handler can build new rows with the same list.
let currentSinkTracks: AudioTrackInfo[] = [];

// Build the audio-track <option>s for one sink. Always preserves the currently
// selected track even when the input is offline / unprobed (so editing a saved
// output doesn't silently reset its track to copy).
function audioOptionsHtml(tracks: AudioTrackInfo[], selected: string): string {
    const seen = new Set<string>(['copy']);
    const options = [
        `<option value="copy"${selected === 'copy' ? ' selected' : ''}>Copy (default)</option>`,
    ];
    for (const t of tracks) {
        const val = String(t.index);
        seen.add(val);
        const parts = [`Track ${t.index + 1}`];
        if (t.language) parts.push(`(${t.language})`);
        if (t.title) parts.push(`— ${t.title}`);
        parts.push(`· ${t.codec} ${t.channels}ch`);
        options.push(
            `<option value="${val}"${selected === val ? ' selected' : ''}>${parts.join(' ')}</option>`,
        );
    }
    if (selected !== 'copy' && !seen.has(selected)) {
        options.push(`<option value="${selected}" selected>Track ${Number(selected) + 1}</option>`);
    }
    return options.join('');
}

function sinkRowHtml(tracks: AudioTrackInfo[], url = '', audioEncoding = 'copy'): string {
    const { idx, key } = url ? detectServer(url) : { idx: 0, key: '' };
    const server = SERVERS[idx];
    const serverOpts = SERVERS.map(
        (s, i) => `<option value="${i}"${i === idx ? ' selected' : ''}>${s.label}</option>`,
    ).join('');
    return `
    <div class="js-sink-row flex items-end gap-2 rounded-box bg-base-200 p-2">
      <fieldset class="fieldset">
        <legend class="fieldset-legend">Server</legend>
        <select class="select select-sm js-sink-server" onchange="outSinkServerChange(this)">${serverOpts}</select>
      </fieldset>
      <fieldset class="fieldset flex-1 js-sink-key-fieldset">
        <legend class="fieldset-legend js-sink-key-label">${server.keyLabel}</legend>
        ${sinkKeyFieldHtml(idx, key)}
      </fieldset>
      <fieldset class="fieldset w-36">
        <legend class="fieldset-legend">Audio</legend>
        <select class="select select-sm w-full js-sink-audio">${audioOptionsHtml(tracks, audioEncoding)}</select>
      </fieldset>
      <button type="button" class="btn btn-sm btn-ghost text-error js-sink-remove"
              onclick="outRemoveSink(this)" title="Remove destination">✕</button>
    </div>`;
}

function updateSinkRemoveButtons(): void {
    const rows = document.querySelectorAll('#out-sinks-container .js-sink-row');
    rows.forEach((row) => {
        const btn = row.querySelector('.js-sink-remove') as HTMLButtonElement | null;
        if (btn) btn.disabled = rows.length <= 1;
    });
}

function populateSinks(
    tracks: AudioTrackInfo[],
    sinks: { url: string; audioEncoding: string }[],
): void {
    currentSinkTracks = tracks;
    const container = document.getElementById('out-sinks-container');
    if (!container) return;
    const rows = sinks.length ? sinks : [{ url: '', audioEncoding: 'copy' }];
    container.innerHTML = rows.map((s) => sinkRowHtml(tracks, s.url, s.audioEncoding)).join('');
    updateSinkRemoveButtons();
}

export function addSinkRow(): void {
    const container = document.getElementById('out-sinks-container');
    if (!container) return;
    container.insertAdjacentHTML('beforeend', sinkRowHtml(currentSinkTracks));
    updateSinkRemoveButtons();
}

export function removeSinkRow(btn: HTMLElement): void {
    const rows = document.querySelectorAll('#out-sinks-container .js-sink-row');
    if (rows.length <= 1) return;
    btn.closest('.js-sink-row')?.remove();
    updateSinkRemoveButtons();
}

export function onSinkServerChange(select: HTMLSelectElement): void {
    const row = select.closest('.js-sink-row');
    if (!row) return;
    const idx = parseInt(select.value);
    const s = SERVERS[idx];
    const label = row.querySelector('.js-sink-key-label') as HTMLElement | null;
    const fieldset = row.querySelector('.js-sink-key-fieldset') as HTMLElement | null;
    if (label) label.textContent = s.keyLabel;
    if (!fieldset) return;
    const existing = fieldset.querySelector('.js-sink-key') as HTMLElement | null;
    const wasRestream = existing?.tagName === 'SELECT';
    const nowRestream = isRestreamIdx(idx);
    if (wasRestream !== nowRestream) {
        const el = fieldset.querySelector('.js-sink-key');
        if (el) el.outerHTML = sinkKeyFieldHtml(idx, '');
    } else if (!nowRestream) {
        const input = fieldset.querySelector('.js-sink-key') as HTMLInputElement | null;
        if (input) input.placeholder = s.placeholder;
    }
}

function pipelineTracks(pipelineId: string): AudioTrackInfo[] {
    return state.pipelines.find((p) => p.id === pipelineId)?.input.audioTracks ?? [];
}

export function openAddOutput(pipelineId: string): void {
    const modal = outModal();
    const existingCount = (state.config.outputs ?? []).filter(
        (o) => String(o.pipelineId) === pipelineId,
    ).length;
    (document.getElementById('out-pipe-id-input') as HTMLInputElement).value = pipelineId;
    (document.getElementById('out-id-input') as HTMLInputElement).value = '';
    const nameEl = document.getElementById('out-name-input') as HTMLInputElement;
    nameEl.value = `Output ${existingCount + 1}`;
    nameEl.classList.remove('input-error');
    (document.getElementById('out-pull-method-input') as HTMLSelectElement).value = 'rtmp';
    (document.getElementById('out-video-encoding-input') as HTMLSelectElement).innerHTML =
        outVideoEncodingOptions('copy');
    populateSinks(pipelineTracks(pipelineId), []);
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
    const modal = outModal();
    (document.getElementById('out-pipe-id-input') as HTMLInputElement).value = pipelineId;
    (document.getElementById('out-id-input') as HTMLInputElement).value = outId;
    const nameEl = document.getElementById('out-name-input') as HTMLInputElement;
    nameEl.value = output.name;
    nameEl.classList.remove('input-error');
    (document.getElementById('out-pull-method-input') as HTMLSelectElement).value =
        output.pullMethod;
    (document.getElementById('out-video-encoding-input') as HTMLSelectElement).innerHTML =
        outVideoEncodingOptions(output.videoEncoding);
    populateSinks(pipelineTracks(pipelineId), output.sinks);
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
    const nameEl = document.getElementById('out-name-input') as HTMLInputElement;
    const name = nameEl.value.trim();
    nameEl.classList.toggle('input-error', !name);

    const videoEncoding = (document.getElementById('out-video-encoding-input') as HTMLSelectElement)
        .value;
    const pullMethod = (document.getElementById('out-pull-method-input') as HTMLSelectElement)
        .value as PullMethod;

    const rows = Array.from(document.querySelectorAll('#out-sinks-container .js-sink-row'));
    const sinks: { url: string; audioEncoding: string }[] = [];
    let sinksValid = true;
    for (const row of rows) {
        const serverIdx = parseInt(
            (row.querySelector('.js-sink-server') as HTMLSelectElement).value,
        );
        const keyEl = row.querySelector('.js-sink-key') as HTMLInputElement | HTMLSelectElement;
        const key = keyEl.value.trim();
        const audioEncoding = (row.querySelector('.js-sink-audio') as HTMLSelectElement).value;
        let url: string;
        if (isRestreamIdx(serverIdx)) {
            const pipeline = (state.config.pipelines ?? []).find((p) => String(p.id) === key);
            if (!pipeline) {
                sinksValid = false;
                continue;
            }
            url =
                serverIdx === RESTREAM_RTMP_IDX
                    ? restreamRtmpUrl(pipeline.streamKey)
                    : restreamSrtUrl(pipeline.streamKey);
        } else {
            if (keyEl instanceof HTMLInputElement) keyEl.classList.toggle('input-error', !key);
            if (!key) {
                sinksValid = false;
                continue;
            }
            url = SERVERS[serverIdx].prefix + key;
        }
        sinks.push({ url, audioEncoding });
    }

    if (!name || !sinksValid || sinks.length === 0) return;

    await withBusy(btn, async () => {
        const payload = { name, videoEncoding, pullMethod, sinks };
        const result = outId
            ? await api.updateOutput(pipelineId, outId, payload)
            : await api.createOutput(pipelineId, payload);
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
