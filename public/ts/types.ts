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
    sinks: OutputSink[];
    lastError: string | null;
}

export interface SinkPayload {
    url: string;
    audioEncoding: string;
}

export interface OutputPayload {
    name: string;
    videoEncoding: string;
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
    startedAtMs: number | null;
    failures: number;
    lastError: string | null;
}

export interface SrsLogEvent {
    ts: number;
    type: 'up' | 'down';
    message: string;
}

export interface SrsLogsData {
    events: SrsLogEvent[];
    logTail: string[];
    logFileExists?: boolean;
}

export interface PipelineLog {
    id: number;
    pipelineId: number;
    ts: number;
    event: string;
    message: string;
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
    configRev: number;
    pipelines: Record<string, PipelineHealth>;
}

export interface ConfigData {
    configRev: number;
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
    uptimeSeconds?: number;
}

export interface MetricSample {
    ts: number;
    cpu: number;
    ramUsed: number;
    ramTotal: number;
    rxBps: number;
    txBps: number;
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
    startedAtMs: number | null;
    failures: number;
    lastError: string | null;
    lastErrorAt: number | null;
}
