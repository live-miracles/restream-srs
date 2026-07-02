const SRT_BONDING_PORT = parseInt(process.env.SRT_BONDING_PORT || '10081');
const SRT_BONDING_STATUS_PORT = parseInt(process.env.SRT_BONDING_STATUS_PORT || '10082');
const SRT_BONDING_STATUS_URL =
    process.env.SRT_BONDING_STATUS_URL || `http://127.0.0.1:${SRT_BONDING_STATUS_PORT}/status`;
const SRT_BONDING_POLL_MS = 5000;
const SRT_BONDING_FETCH_TIMEOUT_MS = 2000;

export interface SrtRelayStats {
    status: 'running' | 'stopping' | 'stopped' | 'failed';
    pid: number | null;
    startedAtMs: number | null;
    lastError: string | null;
}

export interface SrtRelayStreamStatus {
    inputActive: boolean;
    outputConnected: boolean;
    retryFailures: number;
    forwardedPackets: number;
    forwardedBytes: number;
    lastPacketAt: number | null;
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
    getPort(): number;
    getStats(): SrtRelayStats;
    isStreamActive(streamId: string): boolean;
    getStreamStatus(streamId: string): SrtRelayStreamStatus;
    start(): void;
    shutdown(): void;
}

interface RelayStatusResponse {
    pid?: number;
    startedAtMs?: number;
    activeStreamIds?: string[];
    lastError?: string | null;
    streamStates?: Array<{
        streamId?: string;
        inputActive?: boolean;
        outputConnected?: boolean;
        retryFailures?: number;
        forwardedPackets?: number;
        forwardedBytes?: number;
        lastPacketAt?: number;
        recvPacketsTotal?: number;
        recvUniquePacketsTotal?: number;
        recvLossTotal?: number;
        recvDropTotal?: number;
        retransTotal?: number;
        rttMs?: number;
        lastErrorAt?: number;
        lastError?: string | null;
    }>;
}

function extractStreamResource(streamId: string): string | null {
    const match = /(?:^|[?,,#]|::|,)r=([^,]+)/.exec(streamId);
    if (!match?.[1]) return null;
    return match[1].replace(/^\/+/, '');
}

export function createSrtRelayService(): SrtRelayService {
    let stats: SrtRelayStats = {
        status: 'stopped',
        pid: null,
        startedAtMs: null,
        lastError: null,
    };
    let activeStreamIds = new Set<string>();
    let streamStates = new Map<string, SrtRelayStreamStatus>();
    let pollTimer: NodeJS.Timeout | null = null;
    let everReachedRelay = false;
    let refreshInFlight: Promise<void> | null = null;

    async function refresh(): Promise<void> {
        if (refreshInFlight) return refreshInFlight;
        refreshInFlight = (async () => {
            try {
                const res = await fetch(SRT_BONDING_STATUS_URL, {
                    signal: AbortSignal.timeout(SRT_BONDING_FETCH_TIMEOUT_MS),
                    headers: { Connection: 'close' },
                });
                if (!res.ok) throw new Error(`Relay status HTTP ${res.status}`);
                const data = (await res.json()) as RelayStatusResponse;
                const pid = typeof data.pid === 'number' ? data.pid : null;
                const startedAtMs = typeof data.startedAtMs === 'number' ? data.startedAtMs : null;
                activeStreamIds = new Set(
                    (data.activeStreamIds ?? []).filter(
                        (s): s is string => typeof s === 'string' && s.length > 0,
                    ),
                );
                streamStates = new Map(
                    (data.streamStates ?? [])
                        .filter(
                            (s): s is typeof s & { streamId: string } =>
                                typeof s.streamId === 'string' && s.streamId.length > 0,
                        )
                        .map((s) => [
                            s.streamId,
                            {
                                inputActive: !!s.inputActive,
                                outputConnected: !!s.outputConnected,
                                retryFailures:
                                    typeof s.retryFailures === 'number' ? s.retryFailures : 0,
                                forwardedPackets:
                                    typeof s.forwardedPackets === 'number' ? s.forwardedPackets : 0,
                                forwardedBytes:
                                    typeof s.forwardedBytes === 'number' ? s.forwardedBytes : 0,
                                lastPacketAt:
                                    typeof s.lastPacketAt === 'number' ? s.lastPacketAt : null,
                                recvPacketsTotal:
                                    typeof s.recvPacketsTotal === 'number' ? s.recvPacketsTotal : 0,
                                recvUniquePacketsTotal:
                                    typeof s.recvUniquePacketsTotal === 'number'
                                        ? s.recvUniquePacketsTotal
                                        : 0,
                                recvLossTotal:
                                    typeof s.recvLossTotal === 'number' ? s.recvLossTotal : 0,
                                recvDropTotal:
                                    typeof s.recvDropTotal === 'number' ? s.recvDropTotal : 0,
                                retransTotal:
                                    typeof s.retransTotal === 'number' ? s.retransTotal : 0,
                                rttMs: typeof s.rttMs === 'number' ? s.rttMs : null,
                                lastErrorAt:
                                    typeof s.lastErrorAt === 'number' ? s.lastErrorAt : null,
                                lastError: s.lastError ?? null,
                            },
                        ]),
                );
                everReachedRelay = true;
                stats = {
                    status: 'running',
                    pid,
                    startedAtMs,
                    lastError: data.lastError ?? null,
                };
            } catch (err) {
                activeStreamIds = new Set();
                streamStates = new Map();
                stats = {
                    status: everReachedRelay ? 'failed' : 'stopped',
                    pid: null,
                    startedAtMs: null,
                    lastError: err instanceof Error ? err.message : String(err),
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

    return {
        getPort(): number {
            return SRT_BONDING_PORT;
        },

        getStats(): SrtRelayStats {
            return stats;
        },

        isStreamActive(streamId: string): boolean {
            return activeStreamIds.has(streamId);
        },

        getStreamStatus(streamId: string): SrtRelayStreamStatus {
            const exact = streamStates.get(streamId);
            if (exact) return exact;

            const wantedResource = extractStreamResource(streamId);
            if (wantedResource) {
                for (const [rawStreamId, status] of streamStates) {
                    if (extractStreamResource(rawStreamId) === wantedResource) return status;
                }
            }

            return {
                inputActive: false,
                outputConnected: false,
                retryFailures: 0,
                forwardedPackets: 0,
                forwardedBytes: 0,
                lastPacketAt: null,
                recvPacketsTotal: 0,
                recvUniquePacketsTotal: 0,
                recvLossTotal: 0,
                recvDropTotal: 0,
                retransTotal: 0,
                rttMs: null,
                lastErrorAt: null,
                lastError: null,
            };
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
            };
        },
    };
}
