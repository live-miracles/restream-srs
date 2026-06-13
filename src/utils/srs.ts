const SRS_API_URL = process.env.SRS_API_URL || 'http://localhost:1985';
const SRS_RTMP_HOST = process.env.SRS_RTMP_HOST || 'localhost';
const SRS_RTMP_PORT = parseInt(process.env.SRS_RTMP_PORT || '1935');

export interface SrsStreamVideo {
    codec: string;
    profile: string;
    level: string;
    width: number;
    height: number;
    fps?: number | null;
}

export interface SrsStreamAudio {
    codec: string;
    sample_rate: number;
    channel: number;
    profile: string;
}

export interface AudioTrackInfo {
    index: number;
    codec: string;
    sampleRate: number;
    channels: number;
    profile: string;
    language: string | null;
    title: string | null;
}

export interface SrsStream {
    id: string;
    name: string;
    vhost: string;
    app: string;
    tcUrl?: string;
    live_ms: number;
    publish: { active: boolean; cid?: string };
    kbps: { recv_30s: number; send_30s: number };
    clients: number;
    frames: number;
    recv_bytes: number;
    send_bytes: number;
    video?: SrsStreamVideo;
    audio?: SrsStreamAudio;
}

export async function kickSrsClientsByStream(app: string, stream: string): Promise<void> {
    const res = await fetch(`${SRS_API_URL}/api/v1/clients?start=0&count=100`, {
        signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return;
    const data = (await res.json()) as {
        clients?: Array<{ id: string; app: string; stream: string }>;
    };
    for (const client of data.clients ?? []) {
        if (client.app === app && client.stream === stream) {
            await fetch(`${SRS_API_URL}/api/v1/clients/${client.id}`, {
                method: 'DELETE',
                signal: AbortSignal.timeout(3000),
            }).catch(() => {});
        }
    }
}

export async function fetchSrsStreams(): Promise<SrsStream[]> {
    const res = await fetch(`${SRS_API_URL}/api/v1/streams/`, {
        signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`SRS API ${res.status}`);
    const data = (await res.json()) as { code: number; streams: SrsStream[] };
    return data.streams || [];
}

export function rtmpPullUrl(streamKey: string): string {
    return `rtmp://${SRS_RTMP_HOST}:${SRS_RTMP_PORT}/live/${streamKey}`;
}

export function srtPullUrl(streamKey: string): string {
    return `srt://${SRS_RTMP_HOST}:10080?streamid=#!::r=live/${streamKey},m=request`;
}

export function rtmpPublishUrl(streamKey: string, host: string): string {
    return `rtmp://${host}:1935/live/${streamKey}`;
}

export function srtPublishUrl(streamKey: string, host: string, passphrase?: string | null): string {
    const url = `srt://${host}:10080?streamid=#!::r=live/${streamKey},m=publish`;
    if (!passphrase) return url;
    return `${url}&passphrase=${encodeURIComponent(passphrase)}&pbkeylen=16`;
}
