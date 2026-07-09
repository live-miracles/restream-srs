export interface StreamKey {
    id: number;
    slot: number;
    key: string;
}

export interface Pipeline {
    id: number;
    name: string;
    streamKey: string;
    streamKeyId: number;
}

export interface OutputSink {
    url: string;
    audioEncoding: string;
}

export interface HostProbeTarget {
    slot: number;
    label: string;
    host: string;
    port: number;
}

export interface HostProbeSample {
    ts: number;
    ok: boolean;
    latencyMs: number | null;
    error: string | null;
    resolvedAddress: string | null;
}

export interface HostProbeSummary {
    target: HostProbeTarget;
    latestSample: HostProbeSample | null;
    last24hSampleCount: number;
    last24hFailureCount: number;
    averageLatencyMs: number | null;
}

export interface SinkInput {
    url: string;
    audioEncoding?: string;
}

export interface PipelineLog {
    id: number;
    pipelineId: number;
    ts: number;
    event: string;
    message: string;
}

export interface Output {
    id: string;
    pipelineId: number;
    seq: number;
    name: string;
    desiredState: 'running' | 'stopped';
    videoEncoding: string;
    sinks: OutputSink[];
    lastError: string | null;
}

export interface Db {
    getConfigRev(): number;

    getSetting(key: string): string | null;
    setSetting(key: string, value: string): void;
    listHostProbeTargets(): HostProbeTarget[];
    replaceHostProbeTargets(targets: HostProbeTarget[]): void;
    listWhitelistIps(): string[];
    replaceWhitelistIps(ips: string[]): void;

    listStreamKeys(): StreamKey[];
    regenerateStreamKeys(): StreamKey[];

    createPipeline(): Pipeline;
    getPipeline(id: number): Pipeline | undefined;
    listPipelines(): Pipeline[];
    updatePipeline(id: number, name: string, streamKeyId?: number): Pipeline | null;
    deletePipeline(id: number): boolean;

    createOutput(params: {
        pipelineId: number;
        name: string;
        videoEncoding?: string;
        sinks: SinkInput[];
    }): Output;
    // All-or-nothing batch create (single transaction, single configRev bump).
    createOutputs(
        paramsList: {
            pipelineId: number;
            name: string;
            videoEncoding?: string;
            sinks: SinkInput[];
        }[],
    ): Output[];
    getOutput(id: string): Output | null;
    listOutputs(): Output[];
    listOutputIds(): { id: string; pipelineId: number; lastError: string | null }[];
    listOutputsForPipeline(pipelineId: number): Output[];
    updateOutput(
        id: string,
        params: {
            name: string;
            videoEncoding: string;
            sinks: SinkInput[];
        },
    ): Output | null;
    setOutputDesiredState(id: string, desiredState: 'running' | 'stopped'): Output | null;
    deleteOutput(id: string): boolean;
    deleteOutputsForPipeline(pipelineId: number): void;
    setDesiredStateForPipeline(pipelineId: number, state: 'running' | 'stopped'): void;
    clearLastErrorsForPipeline(pipelineId: number): void;

    setOutputLastError(id: string, message: string): void;
    clearOutputLastError(id: string): void;

    appendPipelineLog(pipelineId: number, event: string, message: string): void;
    getPipelineLogs(pipelineId: number, limit?: number): PipelineLog[];

    createSession(token: string): void;
    deleteSession(token: string): void;
    listSessions(): string[];
    pruneExpiredSessions(maxAgeMs: number): void;
}
