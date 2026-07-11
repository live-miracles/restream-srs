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
    rtmpPublishUrlLocal: string;
    srtPublishUrlLocal: string;
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

export interface HostProbeOverviewTarget {
    target: HostProbeTarget;
    latestSample: HostProbeSample | null;
    historySampleCount: number;
    historyFailureCount: number;
    averageLatencyMs: number | null;
    history: HostProbeSample[];
}

export interface HostProbeOverview {
    generatedAt: string;
    intervalMs: number;
    targets: HostProbeOverviewTarget[];
}

export interface Output {
    id: string;
    pipelineId: string;
    seq: number;
    name: string;
    desiredState: 'running' | 'stopped';
    videoEncoding: string;
    sinks: OutputSink[];
    srtLatencyMs: number | null;
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
    srtLatencyMs: number | null;
}

export interface VideoInfo {
    codec: string;
    profile: string;
    level: string;
    width: number;
    height: number;
    fps?: number | null;
    fieldOrder?: string | null;
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
    warningReason: string | null;
    lastError: string | null;
    memoryUsageBytes: number | null;
    memoryLimitBytes: number | null;
}

export interface SrtRelayStatus {
    status: 'running' | 'stopping' | 'stopped' | 'failed';
    pid: number | null;
    startedAtMs: number | null;
    lastError: string | null;
    port: number;
}

export type SrtBondingLegState = 'pending' | 'idle' | 'running' | 'broken' | 'unknown';

export interface SrtBondingLeg {
    ip: string;
    port: number;
    state: SrtBondingLegState;
    rttMs: number | null;
    recvPacketsTotal: number | null;
    recvUniquePacketsTotal: number | null;
    recvLossTotal: number | null;
    recvDropTotal: number | null;
    retransTotal: number | null;
}

export interface SrtBondingStatus {
    inputActive: boolean;
    outputConnected: boolean;
    acceptedBySrs?: boolean;
    publishConflict?: boolean;
    srsPublisher?: {
        id: string;
        ip: string | null;
        type: string | null;
    } | null;
    localSrtPublisherConflict?: boolean;
    retryFailures: number;
    forwardedPackets: number;
    forwardedBytes: number;
    lastPacketAt: number | null;
    lastInputPacketAt: number | null;
    recvPacketsTotal: number;
    recvUniquePacketsTotal: number;
    recvLossTotal: number;
    recvDropTotal: number;
    retransTotal: number;
    inputRttMs: number | null;
    outputRttMs: number | null;
    outputSentPacketsTotal: number;
    outputSendLossTotal: number;
    outputSendDropTotal: number;
    outputRetransTotal: number;
    legs: SrtBondingLeg[];
    lastErrorAt: number | null;
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

export interface Fail2banBan {
    ip: string;
    jail: string;
    bannedAt: number | null;
    unbanAt: number | null;
    reason: string | null;
}

export interface Fail2banBansData {
    ok: boolean;
    bans: Fail2banBan[];
    error?: string;
}

export interface PipelineLog {
    id: number;
    pipelineId: number;
    ts: number;
    event: string;
    message: string;
}

export interface OutputErrorRecord {
    ts: number;
    message: string;
}

export interface InputHealth {
    connected: boolean;
    live: boolean;
    isSrt: boolean;
    mediaOk: boolean | null;
    mediaProbeStartedAt: number | null;
    mediaCheckedAt: number | null;
    mediaError: string | null;
    recvBitrateKbps: number | null;
    sendBitrateKbps: number | null;
    readers: number;
    uptimeMs: number | null;
    publisherIp: string | null;
    publisherType: string | null;
    video: VideoInfo | null;
    audio: AudioInfo | null;
    audioTracks: AudioTrackInfo[];
}

export interface PipelineHealth {
    input: InputHealth;
    outputs: Record<string, OutputStatus>;
    srtBonding: SrtBondingStatus;
}

export interface HealthData {
    generatedAt: string;
    srsReachable: boolean;
    srtRelay: SrtRelayStatus;
    configRev: number;
    pipelines: Record<string, PipelineHealth>;
}

export interface ConfigData {
    configRev: number;
    pipelines: Pipeline[];
    outputs: Output[];
    hostProbeTargets: HostProbeTarget[];
    whitelistIps: string[];
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
    srtBonding: SrtBondingStatus;
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
    warningReason: string | null;
    lastError: string | null;
    lastErrorAt: number | null;
    memoryUsageBytes: number | null;
    memoryLimitBytes: number | null;
}
