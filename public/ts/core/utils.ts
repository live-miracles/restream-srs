export function setInnerText(id: string, val: unknown): void {
    const el = document.getElementById(id);
    if (el) el.textContent = String(val ?? '');
}

export function getUrlParam(key: string): string | null {
    return new URLSearchParams(window.location.search).get(key);
}

export function setUrlParam(key: string, value: string | null): void {
    const url = new URL(window.location.href);
    if (value === null) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
    window.history.replaceState({}, '', url);
}

export const LOW_BITRATE_KBPS = 200;

export const STATUS_COLOR_GOOD = '#22c55e';
export const STATUS_COLOR_WARN = '#facc15';
export const STATUS_COLOR_ERROR = '#ef4444';
export const STATUS_COLOR_OFF = '#6b7280';

export function statusColor(live: boolean, bitrateKbps?: number | null): string {
    if (!live) return STATUS_COLOR_OFF;
    if (bitrateKbps != null && bitrateKbps < LOW_BITRATE_KBPS) return STATUS_COLOR_WARN;
    return STATUS_COLOR_GOOD;
}

export function formatBitrate(kbps: number | null): string {
    if (kbps === null) return '—';
    if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mb/s`;
    return `${kbps} kb/s`;
}

export function formatBytes(bytes: number): string {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
    return `${(bytes / 1024).toFixed(0)} KB`;
}

export function formatBytesCompact(bytes: number): string {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}G`;
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)}M`;
    return `${(bytes / 1024).toFixed(0)}K`;
}

export function maskStreamKey(key: string | null | undefined): string {
    const k = String(key ?? '');
    const idx = k.indexOf('_');
    if (idx < 0) return k;
    const name = k.slice(0, idx);
    const secret = k.slice(idx + 1);
    if (secret.length <= 4) return `${name}_${secret}`;
    return `${name}_${secret.slice(0, 2)}...${secret.slice(-2)}`;
}

// Disables a button and shows a spinner while an async action runs, so the
// user gets immediate feedback even when the server takes a moment to respond.
export async function withBusy(
    btn: HTMLButtonElement | null | undefined,
    fn: () => Promise<void>,
): Promise<void> {
    if (!btn) {
        await fn();
        return;
    }
    if (btn.dataset.busy === '1') return;
    btn.dataset.busy = '1';
    const original = btn.innerHTML;
    const wasDisabled = btn.disabled;
    btn.disabled = true;
    btn.innerHTML = '<span class="loading loading-spinner loading-xs"></span>';
    try {
        await fn();
    } finally {
        // Only restore if the button is still in the DOM (it may have been
        // re-rendered or removed by the refresh that the action triggered).
        if (btn.isConnected) {
            btn.innerHTML = original;
            btn.disabled = wasDisabled;
            delete btn.dataset.busy;
        }
    }
}

export async function copyText(text: string): Promise<void> {
    try {
        if (navigator.clipboard) {
            await navigator.clipboard.writeText(text);
        } else {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
        }
        const el = document.getElementById('copied-notification');
        el?.classList.remove('hidden');
        setTimeout(() => el?.classList.add('hidden'), 1500);
    } catch {
        /* ignore */
    }
}
