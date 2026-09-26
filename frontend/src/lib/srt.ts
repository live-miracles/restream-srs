export type SrtMode = 'caller' | 'listener';

export interface SrtOutputSettings {
    mode: SrtMode;
    host: string;
    port: number;
    latencyMs: number | null;
    passphrase: string;
    pbKeyLen: 16 | 24 | 32 | null;
    streamId: string;
}

export function isSrtHostRequired(mode: SrtMode): boolean {
    return mode !== 'listener';
}

export function buildSrtOutputUrl(settings: SrtOutputSettings): string {
    const params = [`mode=${settings.mode}`];
    if (settings.latencyMs !== null) params.push(`latency=${settings.latencyMs * 1000}`);
    if (settings.passphrase) {
        params.push(`passphrase=${encodeURIComponent(settings.passphrase)}`);
        params.push(`pbkeylen=${settings.pbKeyLen ?? 32}`);
    }
    if (settings.streamId) params.push(`streamid=${settings.streamId}`);
    return `srt://${settings.host}:${settings.port}?${params.join('&')}`;
}
