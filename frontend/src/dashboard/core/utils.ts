export function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
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

export function formatBitrate(kbps: number | null): string {
    if (kbps === null) return '—';
    if (kbps >= 1_000_000) return `${(kbps / 1_000_000).toFixed(1)} gbps`;
    if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} mbps`;
    return `${Math.round(kbps * 10) / 10} kbps`;
}

export function formatBytesCompact(bytes: number): string {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} gb`;
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} mb`;
    return `${(bytes / 1024).toFixed(0)} kb`;
}

export function fmtMs(ms: number | null | undefined): string {
    return ms != null ? `${ms.toFixed(ms >= 10 ? 0 : 1)} ms` : '—';
}

export function fmtMbpsValue(v: number | null | undefined): string {
    return v != null ? formatBitrate(v * 1000) : '—';
}

export function maskStreamKey(key: string | null | undefined): string {
    const k = String(key ?? '');
    const idx = k.indexOf('_');
    if (idx < 0) return k;
    const name = k.slice(0, idx);
    const secret = k.slice(idx + 1);
    return secret.length <= 4
        ? `${name}_${secret}`
        : `${name}_${secret.slice(0, 2)}...${secret.slice(-2)}`;
}

export function maskSecret(secret: string | null | undefined): string {
    const s = String(secret ?? '');
    return s.length <= 4 ? s : `${s.slice(0, 2)}...${s.slice(-2)}`;
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
