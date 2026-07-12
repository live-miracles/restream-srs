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
    historySampleCount: number;
    historyFailureCount: number;
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

// 'crash' covers anything that forced ffmpeg to stop unexpectedly (unhandled
// exit, or the app's own watchdogs killing a stalled/stuck/OOM process) —
// these are genuine failures and drive retry/error-status logic. 'stopped' is
// diagnostic only: whatever ffmpeg had printed to stderr at the moment of a
// deliberate stop, kept so a stall that never crashed (just sat there doing
// nothing until someone stopped it) still leaves a trace.
export type OutputErrorKind = 'crash' | 'stopped';

export interface OutputErrorRecord {
    ts: number;
    message: string;
    kind: OutputErrorKind;
}

export interface Output {
    id: string;
    pipelineId: number;
    seq: number;
    name: string;
    desiredState: 'running' | 'stopped';
    videoEncoding: string;
    sinks: OutputSink[];
    srtLatencyMs: number | null;
    lastError: string | null;
    hasErrorHistory: boolean;
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
        srtLatencyMs?: number | null;
    }): Output;
    // All-or-nothing batch create (single transaction, single configRev bump).
    createOutputs(
        paramsList: {
            pipelineId: number;
            name: string;
            videoEncoding?: string;
            sinks: SinkInput[];
            srtLatencyMs?: number | null;
        }[],
    ): Output[];
    getOutput(id: string): Output | null;
    listOutputs(): Output[];
    listOutputIds(): {
        id: string;
        pipelineId: number;
        lastError: string | null;
        hasErrorHistory: boolean;
    }[];
    listOutputsForPipeline(pipelineId: number): Output[];
    updateOutput(
        id: string,
        params: {
            name: string;
            videoEncoding: string;
            sinks: SinkInput[];
            srtLatencyMs?: number | null;
        },
    ): Output | null;
    setOutputDesiredState(id: string, desiredState: 'running' | 'stopped'): Output | null;
    deleteOutput(id: string): boolean;
    deleteOutputsForPipeline(pipelineId: number): void;
    setDesiredStateForPipeline(pipelineId: number, state: 'running' | 'stopped'): void;
    clearLastErrorsForPipeline(pipelineId: number): void;

    setOutputLastError(id: string, message: string, kind: OutputErrorKind): void;
    clearOutputLastError(id: string): void;
    getOutputErrorHistory(id: string): OutputErrorRecord[];

    appendPipelineLog(pipelineId: number, event: string, message: string): void;
    getPipelineLogs(pipelineId: number, limit?: number): PipelineLog[];

    createSession(token: string): void;
    deleteSession(token: string): void;
    listSessions(): string[];
    pruneExpiredSessions(maxAgeMs: number): void;
}
