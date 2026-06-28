const SRS_API_URL = process.env.SRS_API_URL || 'http://localhost:1985';
const SRS_RTMP_HOST = process.env.SRS_RTMP_HOST || 'localhost';
const SRS_RTMP_PORT = parseInt(process.env.SRS_RTMP_PORT || '1935');
const SRS_SRT_PORT = parseInt(process.env.SRS_SRT_PORT || '10080');
const SRS_CLIENT_FETCH_TIMEOUT_MS = 3000;
const SRS_STREAMS_FETCH_TIMEOUT_MS = 5000;

export interface SrsStreamVideo {
    codec: string;
    profile: string;
    level: string;
    width: number;
    height: number;
    fps?: number | null;
    fieldOrder?: string | null;
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
    const PAGE_SIZE = 100;
    let start = 0;
    while (true) {
        const res = await fetch(`${SRS_API_URL}/api/v1/clients?start=${start}&count=${PAGE_SIZE}`, {
            signal: AbortSignal.timeout(SRS_CLIENT_FETCH_TIMEOUT_MS),
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
            clients?: Array<{ id: string; app: string; stream: string }>;
        };
        const clients = data.clients ?? [];
        for (const client of clients) {
            if (client.app === app && client.stream === stream) {
                await fetch(`${SRS_API_URL}/api/v1/clients/${client.id}`, {
                    method: 'DELETE',
                    signal: AbortSignal.timeout(SRS_CLIENT_FETCH_TIMEOUT_MS),
                }).catch(() => {});
            }
        }
        if (clients.length < PAGE_SIZE) break;
        start += PAGE_SIZE;
    }
}

export async function fetchSrsStreams(): Promise<SrsStream[]> {
    const res = await fetch(`${SRS_API_URL}/api/v1/streams/`, {
        signal: AbortSignal.timeout(SRS_STREAMS_FETCH_TIMEOUT_MS),
        headers: { Connection: 'close' },
    });
    if (!res.ok) throw new Error(`SRS API ${res.status}`);
    const data = (await res.json()) as { code: number; streams: SrsStream[] };
    return data.streams || [];
}

export function rtmpPullUrl(streamKey: string): string {
    return `rtmp://${SRS_RTMP_HOST}:${SRS_RTMP_PORT}/live/${streamKey}`;
}

// latency/transtype are required, not optional tuning. Without an explicit
// receiver latency, ffmpeg's libsrt default is too tight for SRS's TSBPD send
// timing: the SRT link tears down ("Timer expired" / SRTS_BROKEN) before any
// payload arrives, so the pull reads 0 bytes. A 200 ms receiver buffer (with
// transtype=live) lets the stream flow. This pulls the raw MPEG-TS untouched,
// so every audio track survives (RTMP/srt_to_rtmp would collapse to one) and
// the timestamps stay clean (no srt_to_rtmp jitter — ffmpeg demuxes the TS).
export function srtPullUrl(streamKey: string): string {
    return `srt://${SRS_RTMP_HOST}:${SRS_SRT_PORT}?streamid=#!::r=live/${streamKey},m=request&latency=200000&transtype=live`;
}

export function rtmpPublishUrl(streamKey: string, host: string): string {
    return `rtmp://${host}:1935/live/${streamKey}`;
}

export function srtPublishUrl(streamKey: string, host: string, passphrase?: string | null): string {
    const url = `srt://${host}:10080?streamid=#!::r=live/${streamKey},m=publish`;
    if (!passphrase) return url;
    return `${url}&passphrase=${encodeURIComponent(passphrase)}&pbkeylen=16`;
}
