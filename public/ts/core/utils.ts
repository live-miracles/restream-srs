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

export function statusColor(live: boolean): string {
    return live ? '#22c55e' : '#6b7280';
}

export function outputStatusColor(status: string, desiredState: string): string {
    if (desiredState === 'stopped') return '#6b7280';
    if (status === 'running') return '#22c55e';
    if (status === 'failed') return '#ef4444';
    return '#6b7280';
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

export function maskStreamKey(key: string | null | undefined): string {
    const k = String(key ?? '');
    const idx = k.indexOf('_');
    if (idx < 0) return k;
    const name = k.slice(0, idx);
    const secret = k.slice(idx + 1);
    if (secret.length <= 4) return `${name}_${secret}`;
    return `${name}_${secret.slice(0, 2)}...${secret.slice(-2)}`;
}

export async function copyText(text: string): Promise<void> {
    try {
        await navigator.clipboard.writeText(text);
        const el = document.getElementById('copied-notification');
        el?.classList.remove('hidden');
        setTimeout(() => el?.classList.add('hidden'), 1500);
    } catch {
        /* ignore */
    }
}
