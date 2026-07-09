import type {
    PipelineView,
    ConfigData,
    HealthData,
    HostProbeOverview,
    SystemMetrics,
    MetricSample,
    StreamKey,
} from '../types.js';

export type OverviewFilter = 'all' | 'active' | 'problems';

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
    // Overview table filter: 'active' hides rows that are offline/stopped,
    // 'problems' hides rows that are neither warning nor error, so a failing
    // input/output is findable at a glance at the 50-input / 500-output scale.
    overviewFilter: OverviewFilter;
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
    overviewFilter: 'all',
};
