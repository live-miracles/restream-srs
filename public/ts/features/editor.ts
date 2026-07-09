import * as api from '../core/api.js';
import { state } from '../core/state.js';
import { setUrlParam, maskStreamKey, withBusy, copyText, escapeHtml, flashSaveSuccess } from '../core/utils.js';
import { refreshAfterMutation } from './dashboard.js';
import type { StreamKey, AudioTrackInfo, HostProbeTarget, Fail2banBansData } from '../types.js';

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

function isValidIpOrCidr(value: string): boolean {
    const [addr, mask] = value.split('/');
    if (mask !== undefined && !/^\d{1,3}$/.test(mask)) return false;

    const ipv4Match = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4Match) {
        const octets = ipv4Match.slice(1).map(Number);
        if (!octets.every((o) => o >= 0 && o <= 255)) return false;
        return mask === undefined || Number(mask) <= 32;
    }

    if (/^[0-9a-fA-F:]+$/.test(addr) && addr.includes(':')) {
        return mask === undefined || Number(mask) <= 128;
    }

    return false;
}

function whitelistIpRowHtml(label = '', ips = ''): string {
    return `<tr data-whitelist-ip-row>
        <td><input type="text" class="input input-sm w-full js-whitelist-label" placeholder="Office" value="${escapeHtml(label)}" /></td>
        <td><input type="text" class="input input-sm w-full font-mono text-xs js-whitelist-ip"
               placeholder="203.0.113.4, 203.0.113.0/24" value="${escapeHtml(ips)}"
               oninput="this.classList.remove('input-error')" /></td>
        <td class="text-right">
            <button type="button" class="btn btn-xs btn-error btn-outline" onclick="removeWhitelistIpRowBtn(this)" aria-label="Remove row" title="Remove row">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                    <line x1="10" x2="10" y1="11" y2="17" /><line x1="14" x2="14" y1="11" y2="17" />
                </svg>
            </button>
        </td>
    </tr>`;
}

function renderWhitelistIpRows(ips: string[]): void {
    const container = document.getElementById('settings-whitelist-ip-rows');
    if (!container) return;
    container.innerHTML = ips.length ? whitelistIpRowHtml('', ips.join(', ')) : '';
}

export function addWhitelistIpRow(): void {
    const container = document.getElementById('settings-whitelist-ip-rows');
    container?.insertAdjacentHTML('beforeend', whitelistIpRowHtml());
}

export function removeWhitelistIpRow(btn: HTMLElement): void {
    btn.closest('[data-whitelist-ip-row]')?.remove();
}

// Label is frontend-only organization; only the parsed IP/CIDR values from
// every row are sent on to fail2ban.
function readWhitelistIps(): string[] | null {
    const inputs = Array.from(
        document.querySelectorAll<HTMLInputElement>('#settings-whitelist-ip-rows .js-whitelist-ip'),
    );
    const ips: string[] = [];
    let valid = true;
    for (const input of inputs) {
        input.classList.remove('input-error');
        const parts = input.value
            .split(',')
            .map((p) => p.trim())
            .filter(Boolean);
        for (const value of parts) {
            if (!isValidIpOrCidr(value)) {
                input.classList.add('input-error');
                valid = false;
                continue;
            }
            ips.push(value);
        }
    }
    return valid ? [...new Set(ips)] : null;
}

const FAIL2BAN_JAIL_LABELS: Record<string, string> = {
    'restream-srs': 'Bad stream key (publish/play)',
    'srt-bonding-relay': 'Bad SRT passphrase',
};

function fmtBanTs(ts: number | null): string {
    return ts === null ? '—' : new Date(ts).toLocaleString();
}

function renderFail2banBans(data: Fail2banBansData | null): void {
    const tbody = document.getElementById('settings-fail2ban-bans-rows');
    const status = document.getElementById('settings-fail2ban-bans-status');
    if (!tbody || !status) return;

    if (!data || !data.ok) {
        tbody.innerHTML = '';
        status.textContent = `fail2ban status unavailable${data?.error ? `: ${data.error}` : ''}.`;
        return;
    }

    if (data.bans.length === 0) {
        tbody.innerHTML = '';
        status.textContent = 'No IPs currently banned.';
        return;
    }

    status.textContent = '';
    tbody.innerHTML = data.bans
        .map((b) => {
            const label = FAIL2BAN_JAIL_LABELS[b.jail] ?? b.jail;
            const title = b.reason ? ` title="${escapeHtml(b.reason)}"` : '';
            return `<tr>
                <td class="font-mono text-xs">${escapeHtml(b.ip)}</td>
                <td class="text-xs"${title}>${escapeHtml(label)}</td>
                <td class="text-xs">${fmtBanTs(b.bannedAt)}</td>
                <td class="text-xs">${fmtBanTs(b.unbanAt)}</td>
            </tr>`;
        })
        .join('');
}

export async function refreshFail2banBans(btn?: HTMLButtonElement): Promise<void> {
    await withBusy(btn, async () => {
        renderFail2banBans(await api.getFail2banBans());
    });
}

// ── Settings ──────────────────────────────────────────

export function openSettings(): void {
    const modal = document.getElementById('settings-modal') as HTMLDialogElement;
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
    const whitelistIps = state.config.whitelistIps ?? [];
    renderWhitelistIpRows(whitelistIps);
    if (whitelistIps.length === 0) addWhitelistIpRow();
    (document.getElementById('settings-fail2ban-bans-rows') as HTMLElement).innerHTML = '';
    (document.getElementById('settings-fail2ban-bans-status') as HTMLElement).textContent =
        'Loading…';
    void api.getFail2banBans().then(renderFail2banBans);
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

export async function submitWhitelistForm(btn?: HTMLButtonElement): Promise<void> {
    const whitelistIps = readWhitelistIps();
    if (whitelistIps === null) return;

    await withBusy(btn, async () => {
        const result = await api.updateWhitelist(whitelistIps);
        if (!result) return;
        await refreshAfterMutation();
        flashSaveSuccess('settings-whitelist-save-success');

        // Settings still saved even if this failed (see src/api/settings.ts) —
        // surface it so a stale/unreachable fail2ban doesn't fail silently.
        if (!result.whitelistApplied) {
            api.showError(
                `IP whitelist saved, but applying it live failed: ${result.whitelistError ?? 'unknown error'}. It will take effect next time fail2ban restarts.`,
            );
        }
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
        keyLabel: 'SRT URL',
        placeholder: 'srt://host:port?streamid=...',
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

function sinkKeyFieldHtml(idx: number, key: string): string {
    if (isRestreamIdx(idx)) {
        return `<select class="select select-sm w-full js-sink-key" onchange="this.classList.remove('select-error')">${restreamPipelineOpts(key)}</select>`;
    }
    const s = SERVERS[idx];
    return `<input type="text" class="input input-sm w-full font-mono text-xs js-sink-key"
               placeholder="${s.placeholder}" value="${escapeHtml(key)}"
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
    const options = [
        '<option value="" disabled>Audio Encoding</option>',
        `<option value="copy"${selected === 'copy' ? ' selected' : ''}>copy</option>`,
    ];
    for (const t of tracks) {
        const val = String(t.index);
        seen.add(val);
        const parts = [`Track ${t.index + 1}`];
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

function sinkRowHtml(tracks: AudioTrackInfo[], url = '', audioEncoding = 'copy'): string {
    const { idx, key } = url ? detectServer(url) : { idx: CUSTOM_RTMP_IDX, key: '' };
    const serverOpts =
        '<option value="" disabled>Server</option>' +
        SERVERS.map(
            (s, i) => `<option value="${i}"${i === idx ? ' selected' : ''}>${s.label}</option>`,
        ).join('');
    return `
    <div class="js-sink-row flex items-center gap-2 rounded-box bg-base-200 px-2 py-1">
      <select class="select select-sm w-36 shrink-0 js-sink-server" onchange="outSinkServerChange(this)">${serverOpts}</select>
      <div class="flex-1 min-w-0 js-sink-key-fieldset">${sinkKeyFieldHtml(idx, key)}</div>
      <select class="select select-sm w-36 js-sink-audio">${audioOptionsHtml(tracks, audioEncoding)}</select>
      <button type="button" class="btn btn-xs btn-error btn-outline js-sink-remove"
              onclick="outRemoveSink(this)" title="Remove destination">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
          <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
          <line x1="10" x2="10" y1="11" y2="17" /><line x1="14" x2="14" y1="11" y2="17" />
        </svg>
      </button>
    </div>`;
}

function updateSinkRemoveButtons(): void {
    const rows = document.querySelectorAll('#out-sinks-container .js-sink-row');
    rows.forEach((row) => {
        const btn = row.querySelector('.js-sink-remove') as HTMLButtonElement | null;
        if (btn) btn.disabled = rows.length <= 1;
    });
}

// Constrain each sink's audio-track selector to match the input. RTMP inputs are
// single-track, so the selector is locked to "copy"; SRT inputs expose every
// track for selection.
function refreshSinkAudioMode(): void {
    document
        .querySelectorAll<HTMLSelectElement>('#out-sinks-container .js-sink-audio')
        .forEach((sel) => {
            if (!currentInputIsSrt) {
                sel.innerHTML = '<option value="copy">copy</option>';
                sel.value = 'copy';
                sel.disabled = true;
            } else {
                const prev = sel.value;
                sel.innerHTML = audioOptionsHtml(currentSinkTracks, prev);
                sel.disabled = false;
            }
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
    refreshSinkAudioMode();
}

export function addSinkRow(): void {
    const container = document.getElementById('out-sinks-container');
    if (!container) return;
    container.insertAdjacentHTML('beforeend', sinkRowHtml(currentSinkTracks));
    updateSinkRemoveButtons();
    refreshSinkAudioMode();
}

export function removeSinkRow(btn: HTMLElement): void {
    const rows = document.querySelectorAll('#out-sinks-container .js-sink-row');
    if (rows.length <= 1) return;
    btn.closest('.js-sink-row')?.remove();
    updateSinkRemoveButtons();
}

export function onSinkServerChange(select: HTMLSelectElement): void {
    select.classList.remove('select-error');
    const row = select.closest('.js-sink-row');
    if (!row) return;
    const idx = parseInt(select.value);
    const fieldset = row.querySelector('.js-sink-key-fieldset') as HTMLElement | null;
    if (!fieldset) return;
    const existing = fieldset.querySelector('.js-sink-key') as HTMLElement | null;
    const wasRestream = existing?.tagName === 'SELECT';
    const nowRestream = isRestreamIdx(idx);
    if (wasRestream !== nowRestream) {
        const el = fieldset.querySelector('.js-sink-key');
        if (el) el.outerHTML = sinkKeyFieldHtml(idx, '');
    } else if (!nowRestream) {
        const input = fieldset.querySelector('.js-sink-key') as HTMLInputElement | null;
        if (input) input.placeholder = SERVERS[idx].placeholder;
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
    currentInputIsSrt = state.pipelines.find((p) => p.id === pipelineId)?.input.isSrt ?? false;
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
    currentInputIsSrt = state.pipelines.find((p) => p.id === pipelineId)?.input.isSrt ?? false;
    (document.getElementById('out-video-encoding-input') as HTMLSelectElement).innerHTML =
        outVideoEncodingOptions(output.videoEncoding);
    populateSinks(pipelineTracks(pipelineId), output.sinks);
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
            keyEl.classList.toggle('select-error', !pipeline);
            if (!pipeline) {
                sinksValid = false;
                continue;
            }
            url =
                serverIdx === RESTREAM_RTMP_IDX
                    ? pipeline.rtmpPublishUrlLocal
                    : pipeline.srtPublishUrlLocal;
        } else if (serverIdx === INSTAGRAM_RTMP_IDX) {
            if (keyEl instanceof HTMLInputElement) keyEl.classList.toggle('input-error', !key);
            if (!key) {
                sinksValid = false;
                continue;
            }
            url = buildInstagramUrl(key);
        } else {
            if (keyEl instanceof HTMLInputElement) keyEl.classList.toggle('input-error', !key);
            if (!key) {
                sinksValid = false;
                continue;
            }
            url = SERVERS[serverIdx].prefix + key;
            if (!isValidSinkUrl(serverIdx, url)) {
                if (keyEl instanceof HTMLInputElement) keyEl.classList.add('input-error');
                sinksValid = false;
                continue;
            }
        }
        sinks.push({ url, audioEncoding });
    }

    if (sinksValid && sinks.length > 0) {
        const hasSrt = sinks.some((s) => s.url.startsWith('srt://'));
        const hasRtmp = sinks.some((s) => !s.url.startsWith('srt://'));
        if (hasSrt && hasRtmp) {
            for (const row of rows) {
                (row.querySelector('.js-sink-server') as HTMLSelectElement).classList.add(
                    'select-error',
                );
            }
            sinksValid = false;
        }
    }

    if (!name || !sinksValid || sinks.length === 0) return;

    await withBusy(btn, async () => {
        const payload = { name, videoEncoding, sinks };
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

export function showOutputError(pipelineId: string, outId: string): void {
    const modal = document.getElementById('logs-modal') as HTMLDialogElement | null;
    const titleEl = document.getElementById('logs-modal-title');
    const contentEl = document.getElementById('logs-modal-content');
    if (!modal || !contentEl) return;

    const pipeline = state.pipelines.find((p) => p.id === pipelineId);
    const output = pipeline?.outs.find((o) => o.id === outId);
    if (titleEl) titleEl.textContent = `Error — ${output?.name ?? outId}`;

    if (!output?.lastError) {
        contentEl.innerHTML = '<p class="opacity-50 text-sm">No error recorded.</p>';
        modal.showModal();
        return;
    }

    const ts = output.lastErrorAt
        ? new Date(output.lastErrorAt).toLocaleString(undefined, { hour12: false })
        : '';
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    contentEl.innerHTML = `
        <div class="flex items-center gap-2 mb-2">
            <span class="badge badge-xs badge-error uppercase">error</span>
            <span class="text-xs opacity-50">${ts}</span>
        </div>
        <pre class="text-xs text-error opacity-80 whitespace-pre-wrap break-all overflow-x-auto">${esc(output.lastError)}</pre>`;
    modal.showModal();
}

export async function showSrsLogs(): Promise<void> {
    const modal = document.getElementById('logs-modal') as HTMLDialogElement | null;
    const titleEl = document.getElementById('logs-modal-title');
    const contentEl = document.getElementById('logs-modal-content');
    if (!modal || !contentEl) return;

    if (titleEl) titleEl.textContent = 'SRS Logs';
    contentEl.textContent = 'Loading…';
    modal.showModal();

    const data = await api.getSrsLogs();
    if (!data) return;

    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const fmtTs = (ts: number) => new Date(ts).toLocaleString();
    const colorizeLevel = (line: string) =>
        line
            .replace(/\[ERROR\]/g, '<span class="text-error font-semibold">[ERROR]</span>')
            .replace(/\[WARNING\]/g, '<span class="text-warning font-semibold">[WARNING]</span>');

    let html = '<p class="text-xs font-semibold uppercase opacity-50 mb-2">Connectivity</p>';
    if (data.events.length === 0) {
        html += '<p class="text-sm opacity-50 mb-4">No events recorded yet.</p>';
    } else {
        html += [...data.events]
            .reverse()
            .map(
                (e) =>
                    `<div class="flex items-center gap-3 border-b border-base-200 py-1.5 last:border-0">
                        <span class="badge badge-xs leading-none shrink-0 uppercase ${e.type === 'up' ? 'badge-success' : 'badge-error'}">${e.type}</span>
                        <span class="opacity-70 shrink-0">${fmtTs(e.ts)}</span>
                        <span class="opacity-80">${esc(e.message)}</span>
                    </div>`,
            )
            .join('');
    }

    html +=
        '<p class="text-xs font-semibold uppercase opacity-50 mt-4 mb-2">SRS Output (last 200 lines)</p>';
    if (data.logTail.length === 0) {
        const msg =
            data.logFileExists === false
                ? 'SRS log file not found. SRS may not have been started yet.'
                : 'SRS log file is empty — no log output yet.';
        html += `<p class="text-sm opacity-50">${msg}</p>`;
    } else {
        html += `<div class="rounded-xl border border-white/10 bg-black p-3">
            <pre class="text-gray-300 whitespace-pre-wrap break-all">${data.logTail.map((l) => colorizeLevel(esc(l))).join('\n')}</pre>
        </div>`;
    }

    contentEl.innerHTML = html;
    contentEl.scrollTop = contentEl.scrollHeight;
}

// ── Output copy / paste ───────────────────────────────

function parseOutputsPayload(
    text: string,
):
    | { name: string; videoEncoding: string; sinks: { url: string; audioEncoding: string }[] }[]
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
        sinks: { url: string; audioEncoding: string }[];
    }[] = [];
    for (const item of parsed) {
        if (!item || typeof item !== 'object') {
            api.showError('Invalid output format in clipboard.');
            return null;
        }
        const { name, videoEncoding, sinks } = item as Record<string, unknown>;
        if (typeof name !== 'string' || !name.trim()) {
            api.showError('Each output must have a non-empty name.');
            return null;
        }
        if (typeof videoEncoding !== 'string') {
            api.showError('Each output must have a videoEncoding.');
            return null;
        }
        if (!Array.isArray(sinks) || sinks.length === 0) {
            api.showError('Each output must have at least one sink.');
            return null;
        }
        const validSinks: { url: string; audioEncoding: string }[] = [];
        for (const sink of sinks) {
            if (!sink || typeof sink !== 'object') {
                api.showError('Invalid sink format in clipboard.');
                return null;
            }
            const { url, audioEncoding } = sink as Record<string, unknown>;
            if (typeof url !== 'string' || !url.trim()) {
                api.showError('Each sink must have a non-empty url.');
                return null;
            }
            if (typeof audioEncoding !== 'string') {
                api.showError('Each sink must have an audioEncoding.');
                return null;
            }
            validSinks.push({ url, audioEncoding });
        }
        outputs.push({ name: name.trim(), videoEncoding, sinks: validSinks });
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
        .map(({ name, videoEncoding, sinks }) => ({
            name,
            videoEncoding,
            sinks: sinks.map(({ url, audioEncoding }) => ({ url, audioEncoding })),
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
