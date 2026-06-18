import type {
    ConfigData,
    HealthData,
    InputHealth,
    OutputLog,
    PipelineView,
    OutputView,
} from '../types.js';

const EMPTY_INPUT: InputHealth = {
    live: false,
    isSrt: false,
    recvBitrateKbps: null,
    sendBitrateKbps: null,
    readers: 0,
    uptimeMs: null,
    video: null,
    audio: null,
    audioTracks: [],
};

// Scan recent logs newest-first to find the current error state for an output.
// 'stop' clears the error; 'error' sets it; 'start'/'reconnect' are skipped so
// a restart with a wrong key keeps showing the previous failure until it stops.
function deriveLastError(
    logs: OutputLog[],
    outputId: string,
): { message: string; ts: number } | null {
    for (const log of logs) {
        if (log.outputId !== outputId) continue;
        if (log.event === 'stop') return null;
        if (log.event === 'error') return { message: log.message, ts: log.ts };
    }
    return null;
}

export function parsePipelines(
    config: Partial<ConfigData>,
    health: Partial<HealthData>,
    outputLogs?: OutputLog[],
): PipelineView[] {
    const pipelines = config.pipelines ?? [];
    const outputs = config.outputs ?? [];
    const pipelinesHealth = health.pipelines ?? {};
    const logs = outputLogs ?? [];

    return pipelines.map((p) => {
        const ph = pipelinesHealth[String(p.id)];
        const input: InputHealth = ph?.input ?? EMPTY_INPUT;

        const pipelineOutputs = outputs.filter((o) => String(o.pipelineId) === String(p.id));
        const outs: OutputView[] = pipelineOutputs.map((o) => {
            const oh = ph?.outputs?.[o.id];
            const err = deriveLastError(logs, o.id);
            return {
                ...o,
                status: oh?.status ?? 'stopped',
                pid: oh?.pid ?? null,
                bitrateKbps: oh?.bitrateKbps ?? null,
                startedAtMs: oh?.startedAtMs ?? null,
                lastError: err?.message ?? null,
                lastErrorAt: err?.ts ?? null,
            };
        });

        return { ...p, id: String(p.id), input, outs };
    });
}
