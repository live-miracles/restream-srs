<script lang="ts">
    import type { OutputView, PipelineView } from './dashboard/types.js';
    import { updateLayoutOrder } from './dashboard/core/api.js';
    import { refreshAfterMutation } from './dashboard/features/dashboard.js';
    import {
        confirmDeleteOutput,
        startOutput,
        stopOutput,
    } from './dashboard/core/output-actions.js';
    import OutputCard from './OutputCard.svelte';

    export let pipeline: PipelineView | null = null;
    export let allPipelines: PipelineView[] = [];
    export let onEditOutput: (output: OutputView) => void;
    export let onOutputError: (output: OutputView) => void;

    let list: HTMLDivElement;
    let draggingId: string | null = null;
    let pendingIds = new Set<string>();

    $: if (pipeline) {
        pendingIds = new Set(
            [...pendingIds].filter((id) => {
                const output = pipeline?.outs.find((candidate) => candidate.id === id);
                return (
                    output &&
                    !(
                        (output.desiredState === 'running' && output.status === 'running') ||
                        (output.desiredState === 'stopped' && output.status === 'stopped')
                    )
                );
            }),
        );
    }
    $: duplicateUrls = buildDuplicateUrlMap(allPipelines);

    function buildDuplicateUrlMap(
        pipelines: PipelineView[],
    ): Map<string, { pipelineName: string; outputName: string }[]> {
        const refs = new Map<string, { pipelineName: string; outputName: string }[]>();
        for (const current of pipelines) {
            for (const output of current.outs) {
                if (!output.url) continue;
                const values = refs.get(output.url) ?? [];
                values.push({ pipelineName: current.name, outputName: output.name });
                refs.set(output.url, values);
            }
        }
        return new Map([...refs].filter(([, values]) => values.length > 1));
    }

    function start(outputId: string): void {
        if (!pipeline) return;
        pendingIds = new Set([...pendingIds, outputId]);
        void startOutput(pipeline.id, outputId);
    }

    function stop(outputId: string): void {
        if (!pipeline) return;
        pendingIds = new Set([...pendingIds, outputId]);
        void stopOutput(pipeline.id, outputId);
    }

    function handleDragStart(event: DragEvent): void {
        const target = event.target as Element;
        const card = target.closest<HTMLElement>('[data-output-card]');
        if (!card || !target.closest('.js-output-drag-handle')) {
            event.preventDefault();
            return;
        }
        draggingId = card.dataset.outputCard ?? null;
        card.classList.add('opacity-40');
        event.dataTransfer?.setData('text/plain', draggingId ?? '');
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    }

    function handleDragOver(event: DragEvent): void {
        if (!draggingId) return;
        event.preventDefault();
        const target = (event.target as Element).closest<HTMLElement>('[data-output-card]');
        const dragged = list.querySelector<HTMLElement>(`[data-output-card="${draggingId}"]`);
        if (!target || !dragged || target === dragged) return;
        const before = event.clientY < target.getBoundingClientRect().top + target.offsetHeight / 2;
        list.insertBefore(dragged, before ? target : target.nextElementSibling);
    }

    function handleDragEnd(): void {
        if (!draggingId || !pipeline) return;
        list.querySelector<HTMLElement>(`[data-output-card="${draggingId}"]`)?.classList.remove(
            'opacity-40',
        );
        draggingId = null;
        const order = [...list.querySelectorAll<HTMLElement>('[data-output-card]')]
            .map((element) => element.dataset.outputCard)
            .filter((id): id is string => Boolean(id));
        const layout = allPipelines.map((current) => ({
            id: Number(current.id),
            outs: current.id === pipeline.id ? order : current.outs.map((output) => output.id),
        }));
        void updateLayoutOrder(layout).then(refreshAfterMutation);
    }
</script>

<div
    bind:this={list}
    class="flex flex-col gap-2 pb-4"
    on:dragstart={handleDragStart}
    on:dragover={handleDragOver}
    on:dragend={handleDragEnd}
    role="list"
    aria-live="polite">
    {#if pipeline && pipeline.outs.length > 0}
        {#each pipeline.outs as output (output.id)}
            <OutputCard
                {output}
                input={pipeline.input}
                duplicateRefs={duplicateUrls.get(output.url)}
                pending={pendingIds.has(output.id)}
                onStart={() => start(output.id)}
                onStop={() => stop(output.id)}
                onEdit={() => onEditOutput(output)}
                onDelete={() => void confirmDeleteOutput(pipeline!.id, output.id)}
                onErrorInfo={() => onOutputError(output)} />
        {/each}
    {:else if pipeline}
        <p class="text-sm opacity-50">No outputs yet.</p>
    {/if}
</div>
