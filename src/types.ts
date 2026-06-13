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

export interface Output {
    id: string;
    pipelineId: number;
    seq: number;
    name: string;
    url: string;
    desiredState: 'running' | 'stopped';
    videoEncoding: string;
    audioEncoding: string;
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
        url: string;
        videoEncoding?: string;
        audioEncoding?: string;
    }): Output;
    getOutput(id: string): Output | undefined;
    listOutputs(): Output[];
    listOutputsForPipeline(pipelineId: number): Output[];
    updateOutput(
        id: string,
        params: { name: string; url: string; videoEncoding: string; audioEncoding: string },
    ): Output | null;
    setOutputDesiredState(id: string, desiredState: 'running' | 'stopped'): Output | null;
    deleteOutput(id: string): boolean;
}
