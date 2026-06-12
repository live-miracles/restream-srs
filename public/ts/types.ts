export interface StreamKey {
    id: number;
    slot: number;
    key: string;
}

export interface Pipeline {
    id: string;
    name: string;
    streamKey: string;
    streamKeyId: number;
    rtmpPublishUrl: string;
    srtPublishUrl: string;
}

export interface Output {
    id: string;
    pipelineId: string;
    seq: number;
    name: string;
    url: string;
    desiredState: 'running' | 'stopped';
    encoding: string;
}

export interface VideoInfo {
    codec: string;
    profile: string;
    level: string;
    width: number;
    height: number;
    fps?: number | null;
}

export interface AudioInfo {
    codec: string;
    sample_rate: number;
    channel: number;
    profile: string;
}

export interface OutputStatus {
    status: 'running' | 'stopped' | 'failed';
    pid: number | null;
    bitrateKbps: number | null;
    retries: number;
}

export interface InputHealth {
    live: boolean;
    isSrt: boolean;
    recvBitrateKbps: number | null;
    sendBitrateKbps: number | null;
    readers: number;
    uptimeMs: number | null;
    video: VideoInfo | null;
    audio: AudioInfo | null;
}

export interface PipelineHealth {
    input: InputHealth;
    outputs: Record<string, OutputStatus>;
}

export interface HealthData {
    generatedAt: string;
    srsReachable: boolean;
    pipelines: Record<string, PipelineHealth>;
}

export interface ConfigData {
    pipelines: Pipeline[];
    outputs: Output[];
    encodings: string[];
    streamKeys: StreamKey[];
    serverName: string;
    srtLatency: number | null;
    srtPassphrase: string | null;
    srtLatencyPending: boolean;
}

export interface SystemMetrics {
    cpu: { cores: number; percent: number };
    ram: { usedBytes: number; totalBytes: number };
    disk: { totalBytes: number; usedBytes: number } | null;
    net: { rxBytesPerSec: number; txBytesPerSec: number };
}

export interface PipelineView {
    id: string;
    name: string;
    streamKey: string;
    streamKeyId: number;
    rtmpPublishUrl: string;
    srtPublishUrl: string;
    input: InputHealth & { live: boolean };
    outs: OutputView[];
}

export interface OutputView extends Output {
    status: 'running' | 'stopped' | 'failed';
    pid: number | null;
    bitrateKbps: number | null;
    retries: number;
}
