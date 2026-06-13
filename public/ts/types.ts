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

export type PullMethod = 'rtmp' | 'srt';

export interface OutputSink {
    seq: number;
    url: string;
    audioEncoding: string;
}

export interface Output {
    id: string;
    pipelineId: string;
    seq: number;
    name: string;
    desiredState: 'running' | 'stopped';
    videoEncoding: string;
    pullMethod: PullMethod;
    sinks: OutputSink[];
}

export interface SinkPayload {
    url: string;
    audioEncoding: string;
}

export interface OutputPayload {
    name: string;
    videoEncoding: string;
    pullMethod: PullMethod;
    sinks: SinkPayload[];
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

export interface AudioTrackInfo {
    index: number;
    codec: string;
    sampleRate: number;
    channels: number;
    profile: string;
    language: string | null;
    title: string | null;
}

export interface OutputStatus {
    status: 'running' | 'stopped' | 'failed';
    pid: number | null;
    bitrateKbps: number | null;
    retries: number;
    startedAtMs: number | null;
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
    audioTracks: AudioTrackInfo[];
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
    srtPassphrase: string | null;
    publicHost: string;
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
    startedAtMs: number | null;
}
