import type {
    PipelineView,
    ConfigData,
    HealthData,
    SystemMetrics,
    StreamKey,
    OutputLog,
} from '../types.js';

export interface AppState {
    config: Partial<ConfigData>;
    health: Partial<HealthData>;
    pipelines: PipelineView[];
    metrics: Partial<SystemMetrics>;
    streamKeys: StreamKey[];
    outputLogs: OutputLog[];
}

export const state: AppState = {
    config: {},
    health: {},
    pipelines: [],
    metrics: {},
    streamKeys: [],
    outputLogs: [],
};
