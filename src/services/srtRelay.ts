import { readRelayConfig } from '../utils/relayConfig.js';

const SRT_BONDING_POLL_MS = 5000;
const SRT_BONDING_FETCH_TIMEOUT_MS = 2000;

export interface SrtRelayStats {
    status: 'running' | 'stopping' | 'stopped' | 'failed';
    pid: number | null;
    startedAtMs: number | null;
    lastError: string | null;
    port: number;
}

export interface SrtRelayStreamStatus {
    inputActive: boolean;
    outputConnected: boolean;
    retryFailures: number;
    forwardedPackets: number;
    forwardedBytes: number;
    lastPacketAt: number | null;
    lastInputPacketAt: number | null;
    recvPacketsTotal: number;
    recvUniquePacketsTotal: number;
    recvLossTotal: number;
    recvDropTotal: number;
    retransTotal: number;
    rttMs: number | null;
    lastErrorAt: number | null;
    lastError: string | null;
}

export interface SrtRelayService {
    getStats(): SrtRelayStats;
    getStreamStatus(streamId: string): SrtRelayStreamStatus;
    start(): void;
    shutdown(): void;
}

interface RelayStatusResponse {
    pid?: number;
    startedAtMs?: number;
    lastError?: string | null;
    streamStates?: Array<{
        streamId?: string;
        inputActive?: boolean;
        outputConnected?: boolean;
        retryFailures?: number;
        forwardedPackets?: number;
        forwardedBytes?: number;
        lastPacketAt?: number;
        lastInputPacketAt?: number;
        recvPacketsTotal?: number | null;
        recvUniquePacketsTotal?: number;
        recvLossTotal?: number;
        recvDropTotal?: number;
        retransTotal?: number;
        rttMs?: number | null;
        lastErrorAt?: number;
        lastError?: string | null;
    }>;
}

function extractStreamResource(streamId: string): string | null {
    const match = /(?:^|[?,&#]|::|,)r=([^,&#]+)/.exec(streamId);
    if (!match?.[1]) return null;
    return match[1].replace(/^\/+/, '');
}

const EMPTY_STREAM_STATUS: SrtRelayStreamStatus = {
    inputActive: false,
    outputConnected: false,
    retryFailures: 0,
    forwardedPackets: 0,
    forwardedBytes: 0,
    lastPacketAt: null,
    lastInputPacketAt: null,
    recvPacketsTotal: 0,
    recvUniquePacketsTotal: 0,
    recvLossTotal: 0,
    recvDropTotal: 0,
    retransTotal: 0,
    rttMs: null,
    lastErrorAt: null,
    lastError: null,
};

function parseStreamStatus(
    s: NonNullable<RelayStatusResponse['streamStates']>[number],
): SrtRelayStreamStatus {
    return {
        inputActive: !!s.inputActive,
        outputConnected: !!s.outputConnected,
        retryFailures: typeof s.retryFailures === 'number' ? s.retryFailures : 0,
        forwardedPackets: typeof s.forwardedPackets === 'number' ? s.forwardedPackets : 0,
        forwardedBytes: typeof s.forwardedBytes === 'number' ? s.forwardedBytes : 0,
        lastPacketAt: typeof s.lastPacketAt === 'number' ? s.lastPacketAt : null,
        lastInputPacketAt: typeof s.lastInputPacketAt === 'number' ? s.lastInputPacketAt : null,
        recvPacketsTotal: typeof s.recvPacketsTotal === 'number' ? s.recvPacketsTotal : 0,
        recvUniquePacketsTotal:
            typeof s.recvUniquePacketsTotal === 'number' ? s.recvUniquePacketsTotal : 0,
        recvLossTotal: typeof s.recvLossTotal === 'number' ? s.recvLossTotal : 0,
        recvDropTotal: typeof s.recvDropTotal === 'number' ? s.recvDropTotal : 0,
        retransTotal: typeof s.retransTotal === 'number' ? s.retransTotal : 0,
        rttMs: typeof s.rttMs === 'number' ? s.rttMs : null,
        lastErrorAt: typeof s.lastErrorAt === 'number' ? s.lastErrorAt : null,
        lastError: s.lastError ?? null,
    };
}

export function createSrtRelayService(): SrtRelayService {
    let stats: SrtRelayStats = {
        status: 'stopped',
        pid: null,
        startedAtMs: null,
        lastError: null,
        port: readRelayConfig().input_port,
    };
    let streamStates = new Map<string, SrtRelayStreamStatus>();
    let pollTimer: NodeJS.Timeout | null = null;
    let everReachedRelay = false;
    let refreshInFlight: Promise<void> | null = null;

    async function refresh(): Promise<void> {
        if (refreshInFlight) return refreshInFlight;
        refreshInFlight = (async () => {
            try {
                const relayConfig = readRelayConfig();
                const statusUrl = `http://127.0.0.1:${relayConfig.status_port}/status`;
                const res = await fetch(statusUrl, {
                    signal: AbortSignal.timeout(SRT_BONDING_FETCH_TIMEOUT_MS),
                    headers: { Connection: 'close' },
                });
                if (!res.ok) throw new Error(`Relay status HTTP ${res.status}`);
                const data = (await res.json()) as RelayStatusResponse;
                const pid = typeof data.pid === 'number' ? data.pid : null;
                const startedAtMs = typeof data.startedAtMs === 'number' ? data.startedAtMs : null;
                streamStates = new Map(
                    (data.streamStates ?? [])
                        .filter(
                            (s): s is typeof s & { streamId: string } =>
                                typeof s.streamId === 'string' && s.streamId.length > 0,
                        )
                        .map((s) => [s.streamId, parseStreamStatus(s)]),
                );
                everReachedRelay = true;
                stats = {
                    status: 'running',
                    pid,
                    startedAtMs,
                    lastError: data.lastError ?? null,
                    port: relayConfig.input_port,
                };
            } catch (err) {
                const relayConfig = readRelayConfig();
                streamStates = new Map();
                stats = {
                    status: everReachedRelay ? 'failed' : 'stopped',
                    pid: null,
                    startedAtMs: null,
                    lastError: err instanceof Error ? err.message : String(err),
                    port: relayConfig.input_port,
                };
            } finally {
                refreshInFlight = null;
            }
        })();
        return refreshInFlight;
    }

    function start(): void {
        void refresh();
        pollTimer = setInterval(() => void refresh(), SRT_BONDING_POLL_MS);
        pollTimer.unref?.();
    }

    function getStreamStatus(streamId: string): SrtRelayStreamStatus {
        const exact = streamStates.get(streamId);
        if (exact) return exact;

        const wantedResource = extractStreamResource(streamId);
        if (wantedResource) {
            for (const [rawStreamId, status] of streamStates) {
                if (extractStreamResource(rawStreamId) === wantedResource) return status;
            }
        }

        return { ...EMPTY_STREAM_STATUS };
    }

    return {
        getStats(): SrtRelayStats {
            return stats;
        },

        getStreamStatus(streamId: string): SrtRelayStreamStatus {
            return getStreamStatus(streamId);
        },

        start,

        shutdown(): void {
            if (pollTimer) clearInterval(pollTimer);
            pollTimer = null;
            stats = {
                status: 'stopping',
                pid: stats.pid,
                startedAtMs: stats.startedAtMs,
                lastError: stats.lastError,
                port: stats.port,
            };
        },
    };
}
