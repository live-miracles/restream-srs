import type { PipelineView, ConfigData, HealthData, SystemMetrics, StreamKey } from '../types.js';

export interface AppState {
    config: Partial<ConfigData>;
    health: Partial<HealthData>;
    pipelines: PipelineView[];
    metrics: Partial<SystemMetrics>;
    streamKeys: StreamKey[];
}

export const state: AppState = {
    config: {},
    health: {},
    pipelines: [],
    metrics: {},
    streamKeys: [],
};
