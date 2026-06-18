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

export type PullMethod = 'rtmp' | 'srt';

export interface OutputSink {
    seq: number;
    url: string;
    audioEncoding: string;
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
    pullMethod: PullMethod;
    sinks: OutputSink[];
    lastError: string | null;
}

export interface Db {
    getSetting(key: string): string | null;
    setSetting(key: string, value: string): void;

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
        pullMethod?: PullMethod;
        sinks: SinkInput[];
    }): Output;
    getOutput(id: string): Output | null;
    listOutputs(): Output[];
    listOutputIds(): { id: string; pipelineId: number; lastError: string | null }[];
    listOutputsForPipeline(pipelineId: number): Output[];
    updateOutput(
        id: string,
        params: {
            name: string;
            videoEncoding: string;
            pullMethod: PullMethod;
            sinks: SinkInput[];
        },
    ): Output | null;
    setOutputDesiredState(id: string, desiredState: 'running' | 'stopped'): Output | null;
    deleteOutput(id: string): boolean;

    setOutputLastError(id: string, message: string): void;
    clearOutputLastError(id: string): void;

    appendPipelineLog(pipelineId: number, event: string, message: string): void;
    getPipelineLogs(pipelineId: number, limit?: number): PipelineLog[];

    createSession(token: string): void;
    deleteSession(token: string): void;
    listSessions(): string[];
    pruneExpiredSessions(maxAgeMs: number): void;
}
