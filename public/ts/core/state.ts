import type {
    PipelineView,
    ConfigData,
    HealthData,
    HostProbeOverview,
    SystemMetrics,
    MetricSample,
    StreamKey,
} from '../types.js';

export interface AppState {
    config: Partial<ConfigData>;
    health: Partial<HealthData>;
    pipelines: PipelineView[];
    metrics: Partial<SystemMetrics>;
    metricsHistory: MetricSample[];
    hostProbes: Partial<HostProbeOverview>;
    streamKeys: StreamKey[];
    chartOffsetMs: number;
    hostChartOffsetMs: number;
}

export const state: AppState = {
    config: {},
    health: {},
    pipelines: [],
    metrics: {},
    metricsHistory: [],
    hostProbes: {},
    streamKeys: [],
    chartOffsetMs: 0,
    hostChartOffsetMs: 0,
};
