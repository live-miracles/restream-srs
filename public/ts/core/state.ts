import type {
    PipelineView,
    ConfigData,
    HealthData,
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
    streamKeys: StreamKey[];
}

export const state: AppState = {
    config: {},
    health: {},
    pipelines: [],
    metrics: {},
    metricsHistory: [],
    streamKeys: [],
};
