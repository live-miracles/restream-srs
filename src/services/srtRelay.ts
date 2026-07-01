import fs from 'fs';
import path from 'path';

const SRT_BONDING_PORT = parseInt(process.env.SRT_BONDING_PORT || '10081');
const SRT_BONDING_STATE_PATH =
    process.env.SRT_BONDING_STATE_PATH ||
    path.join(process.cwd(), 'objs', 'srt-bonding-relay.state');
const SRT_BONDING_STATE_STALE_MS = 15000;

export interface SrtRelayStats {
    status: 'running' | 'stopping' | 'stopped' | 'failed';
    pid: number | null;
    startedAtMs: number | null;
    lastError: string | null;
}

export interface SrtRelayService {
    getPort(): number;
    getStats(): SrtRelayStats;
    isStreamActive(streamId: string): boolean;
    shutdown(): void;
}

interface RelayStateFile {
    pid?: number;
    startedAtMs?: number;
    updatedAtMs?: number;
    activeStreamIds?: string[];
}

function readRelayState(): RelayStateFile | null {
    try {
        const raw = fs.readFileSync(SRT_BONDING_STATE_PATH, 'utf8');
        return JSON.parse(raw) as RelayStateFile;
    } catch {
        return null;
    }
}

export function createSrtRelayService(): SrtRelayService {
    function activeStreamIds(state: RelayStateFile | null): Set<string> {
        return new Set(
            (state?.activeStreamIds ?? []).filter((s): s is string => typeof s === 'string'),
        );
    }

    function currentState(): RelayStateFile | null {
        const state = readRelayState();
        if (!state?.updatedAtMs || Date.now() - state.updatedAtMs > SRT_BONDING_STATE_STALE_MS) {
            return null;
        }
        return state;
    }

    return {
        getPort(): number {
            return SRT_BONDING_PORT;
        },

        getStats(): SrtRelayStats {
            const state = currentState();
            const pid = typeof state?.pid === 'number' ? state.pid : null;
            return {
                status: state ? 'running' : 'stopped',
                pid,
                startedAtMs: typeof state?.startedAtMs === 'number' ? state.startedAtMs : null,
                lastError: null,
            };
        },

        isStreamActive(streamId: string): boolean {
            return activeStreamIds(currentState()).has(streamId);
        },

        shutdown(): void {
            // systemd owns srt-bonding-relay.service; the Node app never stops it.
        },
    };
}
