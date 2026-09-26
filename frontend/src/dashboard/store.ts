import { writable } from 'svelte/store';
import type { ConfigData, HostProbeOverview, PipelineView, SystemMetrics } from './types.js';

export interface DashboardSnapshot {
    serverName: string;
    config: ConfigData | null;
    metrics: Partial<SystemMetrics>;
    pipelines: PipelineView[];
    hostProbes: Partial<HostProbeOverview>;
}

export const dashboardSnapshot = writable<DashboardSnapshot>({
    serverName: 'Restream SRS',
    config: null,
    metrics: {},
    pipelines: [],
    hostProbes: {},
});

export function publishDashboardSnapshot(
    config: ConfigData | null,
    metrics: Partial<SystemMetrics>,
    pipelines: PipelineView[] = [],
    hostProbes: Partial<HostProbeOverview> = {},
): void {
    dashboardSnapshot.set({
        serverName: config?.serverName || 'Restream SRS',
        config,
        metrics,
        pipelines,
        hostProbes,
    });
}
