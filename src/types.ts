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

export interface OutputLog {
    id: number;
    outputId: string;
    ts: number;
    event: string;
    message: string;
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
    getOutput(id: string): Output | undefined;
    listOutputs(): Output[];
    listOutputMeta(): { id: string; pipelineId: number }[];
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

    appendOutputLog(outputId: string, event: string, message: string): void;
    getOutputLogs(outputId: string, limit?: number): OutputLog[];

    appendPipelineLog(pipelineId: number, event: string, message: string): void;
    getPipelineLogs(pipelineId: number, limit?: number): PipelineLog[];
}
