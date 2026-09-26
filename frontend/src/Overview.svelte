<script lang="ts">
    import { afterUpdate, onMount } from 'svelte';
    import type { PipelineView } from './dashboard/types.js';
    import { state } from './dashboard/core/state.js';
    import { drawOverviewCharts, renderOverviewMarkup } from './dashboard/features/render.js';

    export let pipelines: PipelineView[] = [];
    export let onSelect: (id: string) => void;

    let revision = 0;
    $: markup = buildMarkup(pipelines, revision);

    function buildMarkup(_pipelines: PipelineView[], _revision: number): string {
        return renderOverviewMarkup();
    }

    function maxChartOffset(): number {
        const oldest = state.metricsHistory[0];
        return oldest ? Math.max(0, Date.now() - oldest.ts - 15 * 60 * 1000) : 0;
    }

    function handleClick(event: MouseEvent): void {
        const target = event.target as Element;
        const selected = target.closest<HTMLElement>('.js-select-pipeline')?.dataset.id;
        if (selected) {
            onSelect(selected);
            return;
        }
        const filter =
            target.closest<HTMLElement>('[data-overview-filter]')?.dataset.overviewFilter;
        if (filter === 'all' || filter === 'active' || filter === 'problems') {
            state.overviewFilter = filter;
            revision += 1;
            return;
        }
        if (target.closest('#chart-back')) {
            state.chartOffsetMs = Math.min(state.chartOffsetMs + 10 * 60 * 1000, maxChartOffset());
            revision += 1;
        } else if (target.closest('#chart-fwd')) {
            state.chartOffsetMs = Math.max(0, state.chartOffsetMs - 10 * 60 * 1000);
            revision += 1;
        }
    }

    onMount(drawOverviewCharts);
    afterUpdate(drawOverviewCharts);
</script>

<div
    class="bg-base-200 col-span-2 mt-4 overflow-y-auto rounded-xl p-4 shadow"
    role="region"
    aria-label="Pipeline overview"
    on:click={handleClick}>
    {@html markup}
</div>
