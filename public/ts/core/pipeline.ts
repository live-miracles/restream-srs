import type { ConfigData, HealthData, InputHealth, PipelineView, OutputView } from '../types.js';

const EMPTY_INPUT: InputHealth = {
    live: false,
    recvBitrateKbps: null,
    sendBitrateKbps: null,
    readers: 0,
    uptimeMs: null,
    video: null,
    audio: null,
};

export function parsePipelines(
    config: Partial<ConfigData>,
    health: Partial<HealthData>,
): PipelineView[] {
    const pipelines = config.pipelines ?? [];
    const outputs = config.outputs ?? [];
    const pipelinesHealth = health.pipelines ?? {};

    return pipelines.map((p) => {
        const ph = pipelinesHealth[String(p.id)];
        const input: InputHealth = ph?.input ?? EMPTY_INPUT;

        const pipelineOutputs = outputs.filter((o) => String(o.pipelineId) === String(p.id));
        const outs: OutputView[] = pipelineOutputs.map((o) => {
            const oh = ph?.outputs?.[o.id];
            return {
                ...o,
                status: oh?.status ?? 'stopped',
                pid: oh?.pid ?? null,
                bitrateKbps: oh?.bitrateKbps ?? null,
            };
        });

        return { ...p, id: String(p.id), input, outs };
    });
}
