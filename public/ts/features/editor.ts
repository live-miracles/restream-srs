import * as api from '../core/api.js';
import { state } from '../core/state.js';
import {
    setUrlParam,
    maskStreamKey,
    withBusy,
    copyText,
    escapeHtml,
    flashSaveSuccess,
} from '../core/utils.js';
import { refreshAfterMutation } from './dashboard.js';
import type { StreamKey, AudioTrackInfo, HostProbeTarget, ServerLogTail } from '../types.js';

const MAX_HOST_PROBE_TARGETS = 10;

function hostProbeRowHtml(slot: number, target?: HostProbeTarget): string {
    return `<tr data-host-probe-row="${slot}">
        <td><input type="text" class="input input-sm w-full" data-host-probe-slot="${slot}" data-host-probe-field="label" placeholder="YouTube" value="${escapeHtml(target?.label ?? '')}" /></td>
        <td><input type="text" class="input input-sm w-full font-mono text-sm" data-host-probe-slot="${slot}" data-host-probe-field="host" placeholder="a.rtmp.youtube.com" value="${escapeHtml(target?.host ?? '')}" /></td>
        <td><input type="number" min="1" max="65535" class="input input-sm w-full font-mono text-sm" data-host-probe-slot="${slot}" data-host-probe-field="port" placeholder="1935" value="${target?.port ?? ''}" /></td>
        <td class="text-right">
            <button type="button" class="btn btn-xs btn-error btn-outline" onclick="removeHostProbeRowBtn(${slot})" aria-label="Remove host probe" title="Remove host probe">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                    <line x1="10" x2="10" y1="11" y2="17" /><line x1="14" x2="14" y1="11" y2="17" />
                </svg>
            </button>
        </td>
    </tr>`;
}

function nextHostProbeSlot(targets: HostProbeTarget[]): number | null {
    for (let slot = 1; slot <= MAX_HOST_PROBE_TARGETS; slot++) {
        if (!targets.some((target) => target.slot === slot)) return slot;
    }
    return null;
}

function syncHostProbeAddButton(targets: HostProbeTarget[]): void {
    const btn = document.getElementById('settings-add-host-probe-btn') as HTMLButtonElement | null;
    if (!btn) return;
    btn.disabled = targets.length >= MAX_HOST_PROBE_TARGETS;
}

function renderHostProbeRows(targets: HostProbeTarget[]): void {
    const tbody = document.getElementById('settings-host-probe-rows');
    if (!tbody) return;
    const sorted = [...targets].sort((a, b) => a.slot - b.slot);
    tbody.innerHTML = sorted.map((target) => hostProbeRowHtml(target.slot, target)).join('');
    syncHostProbeAddButton(sorted);
}

function currentHostProbeTargetsFromDom(): HostProbeTarget[] {
    const rows = Array.from(document.querySelectorAll('[data-host-probe-row]'));
    return rows
        .map((row) => Number((row as HTMLElement).dataset.hostProbeRow))
        .filter((slot) => Number.isInteger(slot))
        .sort((a, b) => a - b)
        .map((slot) => {
            const labelEl = document.querySelector(
                `[data-host-probe-slot="${slot}"][data-host-probe-field="label"]`,
            ) as HTMLInputElement;
            const hostEl = document.querySelector(
                `[data-host-probe-slot="${slot}"][data-host-probe-field="host"]`,
            ) as HTMLInputElement;
            const portEl = document.querySelector(
                `[data-host-probe-slot="${slot}"][data-host-probe-field="port"]`,
            ) as HTMLInputElement;
            return {
                slot,
                label: labelEl?.value.trim() ?? '',
                host: hostEl?.value.trim() ?? '',
                port: Number(portEl?.value.trim() || '1935'),
            };
        });
}

export function addHostProbeRow(): void {
    const tbody = document.getElementById('settings-host-probe-rows');
    if (!tbody) return;
    const targets = currentHostProbeTargetsFromDom();
    const slot = nextHostProbeSlot(targets);
    if (slot === null) return;
    tbody.insertAdjacentHTML('beforeend', hostProbeRowHtml(slot));
    syncHostProbeAddButton([...targets, { slot, label: '', host: '', port: 1935 }]);
}

export function removeHostProbeRow(slot: number): void {
    const row = document.querySelector(`[data-host-probe-row="${slot}"]`);
    row?.remove();
    syncHostProbeAddButton(currentHostProbeTargetsFromDom());
}

function readHostProbeRows(): HostProbeTarget[] | null {
    const targets: HostProbeTarget[] = [];
    for (const existing of currentHostProbeTargetsFromDom()) {
        const slot = existing.slot;
        const labelEl = document.querySelector(
            `[data-host-probe-slot="${slot}"][data-host-probe-field="label"]`,
        ) as HTMLInputElement | null;
        const hostEl = document.querySelector(
            `[data-host-probe-slot="${slot}"][data-host-probe-field="host"]`,
        ) as HTMLInputElement | null;
        const portEl = document.querySelector(
            `[data-host-probe-slot="${slot}"][data-host-probe-field="port"]`,
        ) as HTMLInputElement | null;
        if (!labelEl || !hostEl || !portEl) continue;

        const label = labelEl.value.trim();
        const host = hostEl.value.trim();
        const portRaw = portEl.value.trim();

        labelEl.classList.remove('input-error');
        hostEl.classList.remove('input-error');
        portEl.classList.remove('input-error');

        if (!label && !host && !portRaw) continue;

        const port = Number(portRaw || '1935');
        const valid = !!label && !!host && Number.isInteger(port) && port >= 1 && port <= 65535;
        if (!valid) {
            if (!label) labelEl.classList.add('input-error');
            if (!host) hostEl.classList.add('input-error');
            if (!Number.isInteger(port) || port < 1 || port > 65535) {
                portEl.classList.add('input-error');
            }
            return null;
        }

        targets.push({ slot, label, host, port });
    }
    return targets;
}

// ── Settings ──────────────────────────────────────────

export function openSettings(): void {
    const current = state.config.serverName ?? 'Restream SRS';
    (document.getElementById('settings-server-name-input') as HTMLInputElement).value = current;
    (document.getElementById('settings-public-host-input') as HTMLInputElement).value =
        state.config.publicHost ?? '';
    (document.getElementById('current-password-input') as HTMLInputElement).value = '';
    (document.getElementById('new-password-input') as HTMLInputElement).value = '';
    (document.getElementById('confirm-password-input') as HTMLInputElement).value = '';
    (document.getElementById('confirm-password-input') as HTMLInputElement).classList.remove(
        'input-error',
    );
    const probeTargets = state.config.hostProbeTargets ?? [];
    renderHostProbeRows(probeTargets);
    if (probeTargets.length === 0) addHostProbeRow();
    const hasPipelines = (state.config.pipelines?.length ?? 0) > 0;
    const regenBtn = document.getElementById('regen-stream-keys-btn') as HTMLButtonElement;
    const regenHint = document.getElementById('regen-stream-keys-hint') as HTMLElement;
    regenBtn.disabled = hasPipelines;
    regenHint.classList.toggle('hidden', !hasPipelines);
    void api.getVersion().then((v) => {
        if (!v) return;
        (document.getElementById('v-app') as HTMLElement).textContent = `v${v.app}`;
        (document.getElementById('v-commit') as HTMLElement).textContent = v.commit;
        (document.getElementById('v-srs') as HTMLElement).textContent = v.srs;
        (document.getElementById('v-relay') as HTMLElement).textContent = v.srtRelay;
        (document.getElementById('v-ffmpeg') as HTMLElement).textContent = v.ffmpeg;
        (document.getElementById('v-os') as HTMLElement).textContent = v.os;
        (document.getElementById('v-kernel') as HTMLElement).textContent = v.kernel;
    });
}

export async function submitGeneralSettingsForm(btn?: HTMLButtonElement): Promise<void> {
    const name = (
        document.getElementById('settings-server-name-input') as HTMLInputElement
    ).value.trim();
    const publicHost = (
        document.getElementById('settings-public-host-input') as HTMLInputElement
    ).value.trim();
    if (!name) return;

    await withBusy(btn, async () => {
        const result = await api.updateGeneralSettings(name, publicHost);
        if (!result) return;

        const el = document.getElementById('server-name-display');
        if (el) el.textContent = name;
        document.title = name;
        await refreshAfterMutation();
        flashSaveSuccess('settings-general-save-success');
    });
}

export async function submitHostProbesForm(btn?: HTMLButtonElement): Promise<void> {
    const hostProbeTargets = readHostProbeRows();
    if (hostProbeTargets === null) return;

    await withBusy(btn, async () => {
        const result = await api.updateHostProbes(hostProbeTargets);
        if (!result) return;
        await refreshAfterMutation();
        flashSaveSuccess('settings-host-probes-save-success');
    });
}

export async function submitPasswordForm(btn?: HTMLButtonElement): Promise<void> {
    const currentPw = (document.getElementById('current-password-input') as HTMLInputElement).value;
    const newPw = (document.getElementById('new-password-input') as HTMLInputElement).value;
    const confirmPw = (document.getElementById('confirm-password-input') as HTMLInputElement).value;
    const confirmEl = document.getElementById('confirm-password-input') as HTMLInputElement;

    if (!currentPw || !newPw || !confirmPw || newPw !== confirmPw) {
        confirmEl.classList.add('input-error');
        return;
    }

    await withBusy(btn, async () => {
        const result = await api.changePassword(currentPw, newPw);
        if (!result) return;
        (document.getElementById('current-password-input') as HTMLInputElement).value = '';
        (document.getElementById('new-password-input') as HTMLInputElement).value = '';
        (document.getElementById('confirm-password-input') as HTMLInputElement).value = '';
        flashSaveSuccess('settings-password-save-success');
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

// ── Pipeline ──────────────────────────────────────────

function pipeModal(): HTMLDialogElement {
    return document.getElementById('edit-pipe-modal') as HTMLDialogElement;
}

function populateKeySelect(currentKeyId: number): void {
    const select = document.getElementById('pipe-key-select') as HTMLSelectElement;
    const options: string[] = [];
    for (const k of state.streamKeys as StreamKey[]) {
        const label = maskStreamKey(k.key);
        const selected = k.id === currentKeyId ? ' selected' : '';
        options.push(`<option value="${k.id}"${selected}>${label}</option>`);
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
    const keySelect = document.getElementById('pipe-key-select') as HTMLSelectElement;
    const hasActiveOutputs = pipeline.outs.some((o) => o.desiredState !== 'stopped');
    keySelect.disabled = hasActiveOutputs;
    keySelect.title = hasActiveOutputs ? 'Stop all outputs before changing stream key' : '';
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
        if (!result) return;
        pipeModal().close();
        await refreshAfterMutation();
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
    { label: 'Custom RTMP', prefix: '', keyLabel: 'RTMP URL', placeholder: 'rtmp://...' },
    {
        label: 'Custom SRT',
        prefix: '',
        keyLabel: 'SRT Settings',
        placeholder: '',
    },
    {
        label: 'YT RTMP',
        prefix: 'rtmp://a.rtmp.youtube.com/live2/',
        keyLabel: 'Stream Key',
        placeholder: 'xxxx-xxxx-xxxx-xxxx',
    },
    {
        label: 'YT RTMP (Backup)',
        prefix: 'rtmp://b.rtmp.youtube.com/live2?backup=1/',
        keyLabel: 'Stream Key',
        placeholder: 'xxxx-xxxx-xxxx-xxxx',
    },
    {
        label: 'Facebook RTMP',
        prefix: 'rtmps://live-api-s.facebook.com:443/rtmp/',
        keyLabel: 'Stream Key',
        placeholder: 'xxxx-xxxx-xxxx-xxxx',
    },
    {
        label: 'Instagram RTMPS',
        prefix: '',
        keyLabel: 'Stream Key',
        placeholder: '1234567890?s_bl=1&s_prp=xxx-1&...',
    },
    { label: 'Restream RTMP', prefix: '', keyLabel: 'Pipeline', placeholder: '' },
    { label: 'Restream SRT', prefix: '', keyLabel: 'Pipeline', placeholder: '' },
] as const;

const CUSTOM_RTMP_IDX = 0;
const CUSTOM_SRT_IDX = 1;
const INSTAGRAM_RTMP_IDX = 5;
const RESTREAM_RTMP_IDX = 6;
const RESTREAM_SRT_IDX = 7;

function isRestreamIdx(idx: number): boolean {
    return idx === RESTREAM_RTMP_IDX || idx === RESTREAM_SRT_IDX;
}

function serverOptionsHtml(selectedIdx: number): string {
    return SERVERS.map(
        (s, i) => `<option value="${i}"${i === selectedIdx ? ' selected' : ''}>${s.label}</option>`,
    ).join('');
}

function buildInstagramUrl(key: string): string {
    const m = key.match(/[?&]s_prp=([^&]+)/);
    const sPrp = m ? m[1] : '';
    return `rtmps://edgetee-upload-${sPrp}.xx.fbcdn.net:443/rtmp/${key}`;
}

function detectInstagramKey(url: string): string | null {
    const m = url.match(/^rtmps:\/\/edgetee-upload-[^.]+\.xx\.fbcdn\.net:443\/rtmp\/(.+)$/);
    return m ? m[1] : null;
}

function detectServer(url: string): { idx: number; key: string } {
    for (const p of state.config.pipelines ?? []) {
        if (url === p.rtmpPublishUrlLocal) return { idx: RESTREAM_RTMP_IDX, key: String(p.id) };
        if (url === p.srtPublishUrlLocal) return { idx: RESTREAM_SRT_IDX, key: String(p.id) };
    }
    const instagramKey = detectInstagramKey(url);
    if (instagramKey !== null) return { idx: INSTAGRAM_RTMP_IDX, key: instagramKey };
    for (let i = 0; i < SERVERS.length; i++) {
        const { prefix } = SERVERS[i];
        if (prefix && url.startsWith(prefix)) return { idx: i, key: url.slice(prefix.length) };
    }
    return { idx: url.startsWith('srt://') ? CUSTOM_SRT_IDX : CUSTOM_RTMP_IDX, key: url };
}

type SrtFormSettings = {
    mode: 'caller' | 'listener';
    host: string;
    port: number | null;
    latencyMs: number | null;
    passphrase: string;
    pbKeyLen: 16 | 24 | 32 | null;
    streamId: string;
};

const DEFAULT_SRT_SETTINGS: SrtFormSettings = {
    mode: 'caller',
    host: '',
    port: null,
    latencyMs: 240,
    passphrase: '',
    pbKeyLen: null,
    streamId: '',
};

function parseSrtUrl(url: string): SrtFormSettings {
    if (!url.startsWith('srt://')) return { ...DEFAULT_SRT_SETTINGS };
    try {
        const parsed = new URL(url);
        const latency = Number(parsed.searchParams.get('latency') ?? '');
        const port = Number(parsed.port || '');
        const pbKeyLen = Number(parsed.searchParams.get('pbkeylen') ?? '');
        return {
            mode: parsed.searchParams.get('mode') === 'listener' ? 'listener' : 'caller',
            host: parsed.hostname,
            port: Number.isInteger(port) && port > 0 ? port : null,
            latencyMs: Number.isInteger(latency) && latency > 0 ? Math.round(latency / 1000) : null,
            passphrase: parsed.searchParams.get('passphrase') ?? '',
            pbKeyLen: pbKeyLen === 16 || pbKeyLen === 24 || pbKeyLen === 32 ? pbKeyLen : null,
            streamId: parsed.searchParams.get('streamid') ?? '',
        };
    } catch {
        return { ...DEFAULT_SRT_SETTINGS };
    }
}

function buildSrtUrl(
    settings: Omit<SrtFormSettings, 'port' | 'latencyMs'> & { port: number; latencyMs: number },
): string {
    const params = new URLSearchParams();
    params.set('mode', settings.mode);
    params.set('latency', String(settings.latencyMs * 1000));
    if (settings.passphrase) {
        params.set('passphrase', settings.passphrase);
        params.set('pbkeylen', String(settings.pbKeyLen ?? 32));
    }
    if (settings.streamId) params.set('streamid', settings.streamId);
    return `srt://${settings.host}:${settings.port}?${params.toString()}`;
}

function restreamPipelineOpts(selectedId: string): string {
    const pipelines = state.config.pipelines ?? [];
    if (!pipelines.length) return '<option value="" disabled>No pipelines</option>';
    const header = `<option value="" disabled${selectedId ? '' : ' selected'}>Pipeline</option>`;
    return (
        header +
        pipelines
            .map(
                (p) =>
                    `<option value="${escapeHtml(String(p.id))}"${String(p.id) === selectedId ? ' selected' : ''}>${escapeHtml(p.name)}</option>`,
            )
            .join('')
    );
}

function fieldsetHtml(label: string, sizeClass: string, inputHtml: string): string {
    return `<fieldset class="fieldset ${sizeClass}">
        <legend class="fieldset-legend">${label}</legend>
        ${inputHtml}
    </fieldset>`;
}

function sinkKeyFieldHtml(idx: number, key: string): string {
    if (isRestreamIdx(idx)) {
        return fieldsetHtml(
            'Pipeline',
            'flex-1',
            `<select class="select select-sm w-full js-sink-key" onchange="this.classList.remove('select-error')">${restreamPipelineOpts(key)}</select>`,
        );
    }
    if (idx === CUSTOM_SRT_IDX) {
        const srt = parseSrtUrl(key);
        return [
            fieldsetHtml(
                'Hostname',
                '',
                `<input type="text" class="input input-sm w-40 font-mono text-xs js-srt-host" placeholder="xxx.xxx.xxx.xxx" value="${escapeHtml(srt.host)}" oninput="this.classList.remove('input-error')" />`,
            ),
            fieldsetHtml(
                'Port',
                '',
                `<input type="number" min="1" max="65535" class="input input-sm w-20 font-mono text-xs js-srt-port" placeholder="10000" value="${srt.port ?? ''}" oninput="this.classList.remove('input-error')" />`,
            ),
            fieldsetHtml(
                'Type',
                '',
                `<select class="select select-sm w-28 js-srt-mode">
                    <option value="caller"${srt.mode === 'caller' ? ' selected' : ''}>Caller</option>
                    <option value="listener"${srt.mode === 'listener' ? ' selected' : ''}>Listener</option>
                </select>`,
            ),
            fieldsetHtml(
                'Latency (ms)',
                '',
                `<input type="number" min="1" step="1" class="input input-sm w-28 font-mono text-xs js-srt-latency" placeholder="240" value="${srt.latencyMs ?? ''}" oninput="this.classList.remove('input-error')" />`,
            ),
            fieldsetHtml(
                'Passphrase',
                '',
                `<input type="text" class="input input-sm w-56 font-mono text-xs js-srt-passphrase" placeholder="Passphrase" value="${escapeHtml(srt.passphrase)}" oninput="this.classList.remove('input-error')" />`,
            ),
            fieldsetHtml(
                'Key Length',
                '',
                `<select class="select select-sm w-24 js-srt-keylen" title="Key length">
                    <option value="" disabled${srt.pbKeyLen === null ? ' selected' : ''}>—</option>
                    <option value="16"${srt.pbKeyLen === 16 ? ' selected' : ''}>16</option>
                    <option value="24"${srt.pbKeyLen === 24 ? ' selected' : ''}>24</option>
                    <option value="32"${srt.pbKeyLen === 32 ? ' selected' : ''}>32</option>
                </select>`,
            ),
            fieldsetHtml(
                'Stream ID',
                '',
                `<input type="text" class="input input-sm w-56 font-mono text-xs js-srt-streamid" placeholder="Stream ID" value="${escapeHtml(srt.streamId)}" oninput="this.classList.remove('input-error')" />`,
            ),
        ].join('');
    }
    const s = SERVERS[idx];
    return fieldsetHtml(
        s.keyLabel,
        'flex-1',
        `<input type="text" class="input input-sm w-full font-mono text-xs js-sink-key"
               placeholder="${s.placeholder}" value="${escapeHtml(key)}"
               oninput="this.classList.remove('input-error')" />`,
    );
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

// Tracks for the pipeline whose output modal is currently open. Captured when the
// modal opens so the global add-sink handler can build new rows with the same list.
let currentSinkTracks: AudioTrackInfo[] = [];
// Whether that pipeline's input is published over SRT. An RTMP input carries a
// single audio track, so its sinks are locked to "copy"; an SRT input exposes
// every track for per-sink selection. Captured when the modal opens.
let currentInputIsSrt = false;

// Build the audio-track <option>s for one sink. Always preserves the currently
// selected track even when the input is offline / unprobed (so editing a saved
// output doesn't silently reset its track to copy).
function audioOptionsHtml(tracks: AudioTrackInfo[], selected: string): string {
    const seen = new Set<string>(['copy']);
    const options = [`<option value="copy"${selected === 'copy' ? ' selected' : ''}>copy</option>`];
    for (const t of tracks) {
        const val = String(t.index);
        seen.add(val);
        const parts = [`Track ${t.index + 1}`];
        if (t.pid != null) parts.push(`[pid: ${t.pid}]`);
        if (t.language) parts.push(`(${t.language})`);
        if (t.title) parts.push(`— ${t.title}`);
        parts.push(`· ${t.codec} ${t.channels}ch`);
        options.push(
            `<option value="${val}"${selected === val ? ' selected' : ''}>${escapeHtml(parts.join(' '))}</option>`,
        );
    }
    if (selected !== 'copy' && !seen.has(selected)) {
        options.push(`<option value="${selected}" selected>Track ${Number(selected) + 1}</option>`);
    }
    return options.join('');
}

function sinkRowHtmlForServer(idx: number, key = ''): string {
    const serverField = fieldsetHtml(
        'Server',
        '',
        `<select class="select select-sm w-40" id="out-server-input" onchange="outServerChange(this)">${serverOptionsHtml(idx)}</select>`,
    );
    return `<div class="js-sink-row flex flex-wrap items-end gap-2 rounded-box bg-base-200 px-2 py-2">${serverField}${sinkKeyFieldHtml(idx, key)}</div>`;
}

// Constrain the audio-track selector to match the input. RTMP inputs are
// single-track, so the selector is locked to "copy"; SRT inputs expose every
// track for selection.
function refreshSinkAudioMode(): void {
    const sel = document.getElementById('out-audio-encoding-input') as HTMLSelectElement | null;
    if (!sel) return;
    if (!currentInputIsSrt) {
        sel.innerHTML = '<option value="copy">copy</option>';
        sel.value = 'copy';
        sel.disabled = true;
    } else {
        const prev = sel.value;
        sel.innerHTML = audioOptionsHtml(currentSinkTracks, prev);
        sel.disabled = false;
    }
}

function populateDestination(
    tracks: AudioTrackInfo[],
    destination: { url: string; audioEncoding: string } | null,
): void {
    currentSinkTracks = tracks;
    const { idx, key } = destination?.url
        ? detectServer(destination.url)
        : { idx: CUSTOM_RTMP_IDX, key: '' };

    const container = document.getElementById('out-sinks-container');
    if (container) container.innerHTML = sinkRowHtmlForServer(idx, key);

    const audioSel = document.getElementById(
        'out-audio-encoding-input',
    ) as HTMLSelectElement | null;
    if (audioSel)
        audioSel.innerHTML = audioOptionsHtml(tracks, destination?.audioEncoding ?? 'copy');

    refreshSinkAudioMode();
}

export function onOutServerChange(select: HTMLSelectElement): void {
    const idx = parseInt(select.value);
    const container = document.getElementById('out-sinks-container');
    if (container) container.innerHTML = sinkRowHtmlForServer(idx, '');
}

function pipelineTracks(pipelineId: string): AudioTrackInfo[] {
    return state.pipelines.find((p) => p.id === pipelineId)?.input.audioTracks ?? [];
}

export function openAddOutput(pipelineId: string): void {
    const modal = outModal();
    const pipeline = state.pipelines.find((p) => p.id === pipelineId);
    const existingCount = pipeline?.outs.length ?? 0;
    (document.getElementById('out-pipe-id-input') as HTMLInputElement).value = pipelineId;
    (document.getElementById('out-id-input') as HTMLInputElement).value = '';
    const nameEl = document.getElementById('out-name-input') as HTMLInputElement;
    nameEl.value = `Output ${existingCount + 1}`;
    nameEl.classList.remove('input-error');
    currentInputIsSrt = pipeline?.input.isSrt ?? false;

    // Prefill from the pipeline's most recently added output so repeat destinations
    // (same server/encoding) don't have to be re-entered from scratch each time.
    const previous = pipeline?.outs[pipeline.outs.length - 1] ?? null;

    (document.getElementById('out-video-encoding-input') as HTMLSelectElement).innerHTML =
        outVideoEncodingOptions(previous?.videoEncoding ?? 'copy');
    populateDestination(
        pipelineTracks(pipelineId),
        previous ? { url: previous.url, audioEncoding: previous.audioEncoding } : null,
    );
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
    currentInputIsSrt = state.pipelines.find((p) => p.id === pipelineId)?.input.isSrt ?? false;
    (document.getElementById('out-video-encoding-input') as HTMLSelectElement).innerHTML =
        outVideoEncodingOptions(output.videoEncoding);
    populateDestination(pipelineTracks(pipelineId), {
        url: output.url,
        audioEncoding: output.audioEncoding,
    });
    (document.getElementById('out-modal-title') as HTMLElement).textContent = 'Edit Output';

    const isRunning = output.desiredState === 'running';
    const saveBtn = document.getElementById('out-save-btn') as HTMLButtonElement;
    const hint = document.getElementById('out-running-hint') as HTMLElement;
    saveBtn.disabled = isRunning;
    hint.classList.toggle('hidden', !isRunning);

    modal.showModal();
}

function isValidSinkUrl(serverIdx: number, url: string): boolean {
    if (serverIdx === CUSTOM_RTMP_IDX)
        return url.startsWith('rtmp://') || url.startsWith('rtmps://');
    if (serverIdx === CUSTOM_SRT_IDX) return url.startsWith('srt://');
    return true;
}

function readSrtSettings(row: Element): { url: string } | { error: true } {
    const hostEl = row.querySelector('.js-srt-host') as HTMLInputElement | null;
    const portEl = row.querySelector('.js-srt-port') as HTMLInputElement | null;
    const latencyEl = row.querySelector('.js-srt-latency') as HTMLInputElement | null;
    const passphraseEl = row.querySelector('.js-srt-passphrase') as HTMLInputElement | null;
    const modeEl = row.querySelector('.js-srt-mode') as HTMLSelectElement | null;
    const keyLenEl = row.querySelector('.js-srt-keylen') as HTMLSelectElement | null;
    const streamIdEl = row.querySelector('.js-srt-streamid') as HTMLInputElement | null;
    if (!hostEl || !portEl || !latencyEl || !passphraseEl || !modeEl || !keyLenEl || !streamIdEl) {
        return { error: true };
    }

    const host = hostEl.value.trim();
    const port = Number(portEl.value.trim());
    const latencyMs = Number(latencyEl.value.trim());
    const passphrase = passphraseEl.value.trim();
    const pbKeyLen = keyLenEl.value ? (Number(keyLenEl.value) as 16 | 24 | 32) : null;
    const streamId = streamIdEl.value.trim();

    const portValid = Number.isInteger(port) && port >= 1 && port <= 65535;
    const latencyValid = Number.isInteger(latencyMs) && latencyMs > 0;
    const passphraseValid = !passphrase || (passphrase.length >= 10 && passphrase.length <= 79);
    const keyLenValid = !passphrase || pbKeyLen !== null;

    hostEl.classList.toggle('input-error', !host);
    portEl.classList.toggle('input-error', !portValid);
    latencyEl.classList.toggle('input-error', !latencyValid);
    passphraseEl.classList.toggle('input-error', !passphraseValid);
    keyLenEl.classList.toggle('input-error', !keyLenValid);

    if (!host || !portValid || !latencyValid || !passphraseValid || !keyLenValid) {
        return { error: true };
    }

    return {
        url: buildSrtUrl({
            mode: modeEl.value === 'listener' ? 'listener' : 'caller',
            host,
            port,
            latencyMs,
            passphrase,
            pbKeyLen,
            streamId,
        }),
    };
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
    const audioEncoding = (document.getElementById('out-audio-encoding-input') as HTMLSelectElement)
        .value;
    const serverIdx = parseInt(
        (document.getElementById('out-server-input') as HTMLSelectElement).value,
    );

    const row = document.querySelector('#out-sinks-container .js-sink-row');
    let url = '';
    let destinationValid = row !== null;
    if (row) {
        const keyEl = row.querySelector('.js-sink-key') as
            | HTMLInputElement
            | HTMLSelectElement
            | null;
        const key = keyEl?.value.trim() ?? '';
        if (serverIdx === CUSTOM_SRT_IDX) {
            const srt = readSrtSettings(row);
            if ('error' in srt) {
                destinationValid = false;
            } else {
                url = srt.url;
            }
        } else if (isRestreamIdx(serverIdx)) {
            const pipeline = (state.config.pipelines ?? []).find((p) => String(p.id) === key);
            keyEl?.classList.toggle('select-error', !pipeline);
            if (!pipeline) {
                destinationValid = false;
            } else {
                url =
                    serverIdx === RESTREAM_RTMP_IDX
                        ? pipeline.rtmpPublishUrlLocal
                        : pipeline.srtPublishUrlLocal;
            }
        } else if (serverIdx === INSTAGRAM_RTMP_IDX) {
            if (keyEl instanceof HTMLInputElement) keyEl.classList.toggle('input-error', !key);
            if (!key) {
                destinationValid = false;
            } else {
                url = buildInstagramUrl(key);
            }
        } else {
            if (keyEl instanceof HTMLInputElement) keyEl.classList.toggle('input-error', !key);
            if (!key) {
                destinationValid = false;
            } else {
                url = SERVERS[serverIdx].prefix + key;
                if (!isValidSinkUrl(serverIdx, url)) {
                    if (keyEl instanceof HTMLInputElement) keyEl.classList.add('input-error');
                    destinationValid = false;
                }
            }
        }
    }

    if (!name || !destinationValid) return;

    await withBusy(btn, async () => {
        const payload = { name, videoEncoding, url, audioEncoding };
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

export async function showPipelineLogs(pipelineId: string): Promise<void> {
    const modal = document.getElementById('logs-modal') as HTMLDialogElement | null;
    const titleEl = document.getElementById('logs-modal-title');
    const contentEl = document.getElementById('logs-modal-content');
    if (!modal || !contentEl) return;

    const pipelineName = state.pipelines.find((p) => p.id === pipelineId)?.name ?? pipelineId;
    if (titleEl) titleEl.textContent = `History — ${pipelineName}`;
    contentEl.textContent = 'Loading…';
    modal.showModal();

    const logs = await api.getPipelineLogs(pipelineId);
    if (!logs || logs.length === 0) {
        contentEl.innerHTML = '<p class="opacity-50 text-sm">No history recorded yet.</p>';
        return;
    }

    const fmtTs = (ts: number) => new Date(ts).toLocaleString();
    contentEl.innerHTML = logs
        .map(
            (
                l,
            ) => `<div class="flex items-center gap-3 border-b border-base-200 py-1.5 last:border-0">
                <span class="badge badge-xs leading-none ${l.event === 'online' ? 'badge-success' : 'badge-neutral'} shrink-0 uppercase">${l.event}</span>
                <span class="text-xs opacity-70 shrink-0">${fmtTs(l.ts)}</span>
                <span class="text-xs opacity-80">${l.message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span>
            </div>`,
        )
        .join('');
}

export async function showOutputError(pipelineId: string, outId: string): Promise<void> {
    const modal = document.getElementById('logs-modal') as HTMLDialogElement | null;
    const titleEl = document.getElementById('logs-modal-title');
    const contentEl = document.getElementById('logs-modal-content');
    if (!modal || !contentEl) return;

    const pipeline = state.pipelines.find((p) => p.id === pipelineId);
    const output = pipeline?.outs.find((o) => o.id === outId);
    if (titleEl) titleEl.textContent = `Error History - ${output?.name ?? outId}`;
    contentEl.textContent = 'Loading…';
    modal.showModal();

    const history = await api.getOutputErrorHistory(pipelineId, outId);
    if (!history || history.length === 0) {
        contentEl.innerHTML = '<p class="opacity-50 text-sm">No error recorded.</p>';
        return;
    }

    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    contentEl.innerHTML = history
        .slice()
        .reverse()
        .map((entry, idx) => {
            const ts = entry.ts
                ? new Date(entry.ts).toLocaleString(undefined, { hour12: false })
                : '';
            // 'stopped' entries are leftover stderr captured at a deliberate
            // stop, not a failure — badge and text stay neutral so they read
            // as diagnostic info rather than an error.
            const isCrash = entry.kind !== 'stopped';
            const badgeClass = isCrash ? 'badge-error' : 'badge-neutral';
            const badgeLabel = isCrash
                ? idx === 0
                    ? 'latest crash'
                    : 'crash'
                : 'stopped (stderr)';
            const textClass = isCrash ? 'text-error opacity-80' : 'opacity-60';
            return `<div class="${idx === 0 ? '' : 'mt-4 pt-4 border-t border-base-200'}">
                <div class="flex items-center gap-2 mb-2">
                    <span class="badge badge-xs ${badgeClass} uppercase">${badgeLabel}</span>
                    <span class="text-xs opacity-50">${ts}</span>
                </div>
                <pre class="text-xs ${textClass} whitespace-pre-wrap break-all overflow-x-auto">${esc(entry.message)}</pre>
            </div>`;
        })
        .join('');
}

// Unlike output errors, the relay only ever carries one lastError/lastErrorAt
// pair (no persisted history), so this reads straight from the already-loaded
// health snapshot instead of calling out to an API.
export function showRelayError(pipelineId: string): void {
    const modal = document.getElementById('logs-modal') as HTMLDialogElement | null;
    const titleEl = document.getElementById('logs-modal-title');
    const contentEl = document.getElementById('logs-modal-content');
    if (!modal || !contentEl) return;

    const pipeline = state.pipelines.find((p) => p.id === pipelineId);
    if (titleEl) titleEl.textContent = `SRT Bonding Relay Error — ${pipeline?.name ?? pipelineId}`;

    const message = pipeline?.srtBonding.lastError;
    if (!message) {
        contentEl.innerHTML = '<p class="opacity-50 text-sm">No error recorded.</p>';
        modal.showModal();
        return;
    }

    const ts = pipeline?.srtBonding.lastErrorAt
        ? new Date(pipeline.srtBonding.lastErrorAt).toLocaleString(undefined, { hour12: false })
        : '';
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    contentEl.innerHTML = `
        <div class="text-xs opacity-50 mb-2">${ts}</div>
        <pre class="text-xs text-error opacity-80 whitespace-pre-wrap break-all overflow-x-auto">${esc(message)}</pre>
    `;
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

function ansiLineToHtml(line: string): string {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let html = '';
    let lastIndex = 0;
    let openSpan = false;
    ANSI_SGR_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ANSI_SGR_REGEX.exec(line))) {
        html += esc(line.slice(lastIndex, match.index));
        lastIndex = ANSI_SGR_REGEX.lastIndex;
        if (openSpan) {
            html += '</span>';
            openSpan = false;
        }
        for (const code of match[1].split(';')) {
            const cls = ANSI_FG_CLASS[code];
            if (cls) {
                html += `<span class="${cls}">`;
                openSpan = true;
            }
        }
    }
    html += esc(line.slice(lastIndex));
    if (openSpan) html += '</span>';
    return html;
}

export async function showSrsLogs(): Promise<void> {
    const contentEl = document.getElementById('srs-logs-content');
    if (!contentEl) return;

    contentEl.textContent = 'Loading…';

    const data = await api.getSrsLogs();
    if (!data) return;

    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const fmtTs = (ts: number) => new Date(ts).toLocaleString();

    const renderTerminal = (label: string, elId: string, tail: ServerLogTail): string => {
        let section = `<p class="text-xs font-semibold uppercase opacity-50 mb-2">${label} (last 200 lines)</p>`;
        if (tail.lines.length === 0) {
            const msg =
                tail.source === 'none'
                    ? `No ${label} log output found — it may not have started yet.`
                    : `${label} log output is empty — no log output yet.`;
            section += `<p class="text-sm opacity-50 mb-4">${msg}</p>`;
        } else {
            section += `<div id="${elId}" class="h-72 overflow-y-auto rounded-xl border border-white/10 bg-black p-3">
                <pre class="text-gray-300 whitespace-pre-wrap break-all">${tail.lines.map((l) => ansiLineToHtml(l)).join('\n')}</pre>
            </div>`;
        }
        return section;
    };

    let html = '';
    for (const { label, elId, key } of LOG_TERMINALS) {
        html += renderTerminal(label, elId, data[key]);
    }

    const CONNECTIVITY_SOURCE_LABEL: Record<'srs' | 'relay', string> = {
        srs: 'SRS',
        relay: 'SRT Bonding Relay',
    };

    html += '<p class="text-xs font-semibold uppercase opacity-50 mt-4 mb-2">Connectivity</p>';
    if (data.events.length === 0) {
        html += '<p class="text-sm opacity-50 mb-4">No events recorded yet.</p>';
    } else {
        html +=
            '<div class="mb-4">' +
            [...data.events]
                .reverse()
                .map(
                    (e) =>
                        `<div class="flex items-center gap-3 border-b border-base-200 py-1.5 last:border-0">
                            <span class="badge badge-xs leading-none shrink-0 uppercase ${e.type === 'up' ? 'badge-success' : 'badge-error'}">${e.type}</span>
                            <span class="badge badge-xs badge-outline shrink-0">${CONNECTIVITY_SOURCE_LABEL[e.source]}</span>
                            <span class="opacity-70 shrink-0">${fmtTs(e.ts)}</span>
                            <span class="opacity-80">${esc(e.message)}</span>
                        </div>`,
                )
                .join('') +
            '</div>';
    }

    contentEl.innerHTML = html;
    for (const { elId } of LOG_TERMINALS) {
        const tailEl = document.getElementById(elId);
        if (tailEl) tailEl.scrollTop = tailEl.scrollHeight;
    }
}

// ── Output copy / paste ───────────────────────────────

function parseOutputsPayload(text: string):
    | {
          name: string;
          videoEncoding: string;
          url: string;
          audioEncoding: string;
      }[]
    | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        api.showError('Clipboard content is not valid JSON.');
        return null;
    }
    if (!Array.isArray(parsed)) {
        api.showError('Expected a JSON array of outputs.');
        return null;
    }
    const outputs: {
        name: string;
        videoEncoding: string;
        url: string;
        audioEncoding: string;
    }[] = [];
    for (const item of parsed) {
        if (!item || typeof item !== 'object') {
            api.showError('Invalid output format in clipboard.');
            return null;
        }
        const { name, videoEncoding, url, audioEncoding } = item as Record<string, unknown>;
        if (typeof name !== 'string' || !name.trim()) {
            api.showError('Each output must have a non-empty name.');
            return null;
        }
        if (typeof videoEncoding !== 'string') {
            api.showError('Each output must have a videoEncoding.');
            return null;
        }
        if (typeof url !== 'string' || !url.trim()) {
            api.showError('Each output must have a non-empty url.');
            return null;
        }
        if (typeof audioEncoding !== 'string') {
            api.showError('Each output must have an audioEncoding.');
            return null;
        }
        outputs.push({
            name: name.trim(),
            videoEncoding,
            url,
            audioEncoding,
        });
    }
    if (outputs.length === 0) {
        api.showError('No outputs found in clipboard.');
        return null;
    }
    return outputs;
}

export async function startAllOutputs(pipelineId: string, btn: HTMLButtonElement): Promise<void> {
    if (
        !confirm(
            'Start all outputs for this pipeline? They will start staggered to avoid overloading the server.',
        )
    )
        return;
    await withBusy(btn, async () => {
        const ok = await api.startAllOutputs(pipelineId);
        if (!ok) return;
        await refreshAfterMutation();
    });
}

export async function stopAllOutputs(pipelineId: string, btn: HTMLButtonElement): Promise<void> {
    if (!confirm('Stop all outputs for this pipeline?')) return;
    await withBusy(btn, async () => {
        const ok = await api.stopAllOutputs(pipelineId);
        if (!ok) return;
        await refreshAfterMutation();
    });
}

export async function copyOutputs(pipelineId: string): Promise<void> {
    const outputs = (state.config.outputs ?? [])
        .filter((o) => String(o.pipelineId) === pipelineId)
        .map(({ name, videoEncoding, url, audioEncoding }) => ({
            name,
            videoEncoding,
            url,
            audioEncoding,
        }));
    await copyText(JSON.stringify(outputs, null, 2));
}

export async function pasteOutputs(pipelineId: string, btn: HTMLButtonElement): Promise<void> {
    if (
        !confirm(
            'Replace all outputs for this pipeline with the clipboard contents? This cannot be undone.',
        )
    )
        return;

    let text: string;
    try {
        text = await navigator.clipboard.readText();
    } catch {
        api.showError('Could not read clipboard. Please allow clipboard access.');
        return;
    }

    const outputs = parseOutputsPayload(text);
    if (!outputs) return;

    await withBusy(btn, async () => {
        const cleared = await api.clearOutputs(pipelineId);
        if (!cleared) return;

        const created = await api.createOutputsBulk(pipelineId, outputs);
        if (!created) return;

        await refreshAfterMutation();
    });
}
