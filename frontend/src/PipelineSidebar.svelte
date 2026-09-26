<script lang="ts">
    import { updateLayoutOrder } from './dashboard/core/api.js';
    import type { PipelineView } from './dashboard/types.js';

    export let pipelines: PipelineView[] = [];
    export let selectedId: string | null = null;
    export let onAdd: () => void;
    export let onSelect: (id: string | null) => void;
    export let onProblems: () => void;

    let draggingId: string | null = null;

    $: totalOutputs = pipelines.reduce((total, pipeline) => total + pipeline.outs.length, 0);
    $: liveInputs = pipelines.filter((pipeline) => pipeline.input.live).length;
    $: warningInputs = pipelines.filter(
        (pipeline) => pipeline.input.connected && !pipeline.input.live,
    ).length;
    $: offlineInputs = pipelines.length - liveInputs - warningInputs;
    $: runningOutputs = pipelines.reduce(
        (total, pipeline) =>
            total + pipeline.outs.filter((output) => output.status === 'running').length,
        0,
    );
    $: warningOutputs = pipelines.reduce(
        (total, pipeline) =>
            total +
            pipeline.outs.filter((output) => output.status === 'running' && !!output.warningReason)
                .length,
        0,
    );
    $: failedOutputs = pipelines.reduce(
        (total, pipeline) =>
            total + pipeline.outs.filter((output) => output.status === 'failed').length,
        0,
    );
    $: stoppedOutputs = totalOutputs - runningOutputs;

    function formatUptime(ms: number | null): string {
        if (ms === null) return '';
        const total = Math.max(0, Math.floor(ms / 1000));
        const hours = Math.floor(total / 3600);
        const minutes = Math.floor((total % 3600) / 60);
        const seconds = total % 60;
        if (hours > 0) return `${hours}h ${minutes}m`;
        if (minutes > 0) return `${minutes}m ${seconds}s`;
        return `${seconds}s`;
    }

    function inputColor(pipeline: PipelineView): string {
        if (pipeline.input.live) return '#22c55e';
        if (pipeline.input.connected) return '#f59e0b';
        return '#6b7280';
    }

    function outputColor(pipeline: PipelineView): string {
        if (pipeline.outs.some((output) => output.status === 'failed')) return '#ef4444';
        if (pipeline.outs.some((output) => output.status === 'running' && !!output.warningReason))
            return '#f59e0b';
        if (pipeline.outs.some((output) => output.status === 'running')) return '#22c55e';
        return '#6b7280';
    }

    async function persistOrder(): Promise<void> {
        await updateLayoutOrder(
            pipelines.map((pipeline) => ({
                id: Number(pipeline.id),
                outs: pipeline.outs.map((output) => output.id),
            })),
        );
    }

    function handleDragStart(event: DragEvent, id: string): void {
        draggingId = id;
        event.dataTransfer?.setData('text/plain', id);
        event.dataTransfer?.setDragImage(event.currentTarget as Element, 12, 12);
    }

    function handleDrop(event: DragEvent, targetId: string): void {
        event.preventDefault();
        if (!draggingId || draggingId === targetId) return;
        const from = pipelines.findIndex((pipeline) => pipeline.id === draggingId);
        const to = pipelines.findIndex((pipeline) => pipeline.id === targetId);
        if (from < 0 || to < 0) return;
        const next = [...pipelines];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        pipelines = next;
        void persistOrder();
        draggingId = null;
    }
</script>

<div class="bg-base-300 rounded-box mt-4 overflow-y-auto">
    <div class="bg-base-300 sticky top-0 z-10 flex items-start justify-between gap-2 p-4">
        <div class="min-w-0 flex-1 space-y-2">
            <div class="grid grid-cols-[5rem_auto] items-center gap-x-3 text-sm">
                <span><span id="pipe-cnt">{pipelines.length}</span> Inputs</span>
                <div class="flex gap-1">
                    {#if liveInputs}<div class="badge badge-sm badge-success px-2">
                            {liveInputs}
                        </div>{/if}
                    {#if warningInputs}
                        <button
                            class="badge badge-sm badge-warning cursor-pointer px-2"
                            onclick={onProblems}
                            title="Warnings — click to view problems">{warningInputs}</button>
                    {/if}
                    {#if offlineInputs}<div class="badge badge-sm badge-neutral px-2">
                            {offlineInputs}
                        </div>{/if}
                </div>
            </div>
            <div class="grid grid-cols-[5rem_auto] items-center gap-x-3 text-sm">
                <span><span id="out-cnt">{totalOutputs}</span> Outputs</span>
                <div class="flex gap-1">
                    {#if runningOutputs - warningOutputs > 0}<div
                            class="badge badge-sm badge-success px-2">
                            {runningOutputs - warningOutputs}
                        </div>{/if}
                    {#if warningOutputs}
                        <button
                            class="badge badge-sm badge-warning cursor-pointer px-2"
                            onclick={onProblems}
                            title="Low bitrate — click to view problems">{warningOutputs}</button>
                    {/if}
                    {#if failedOutputs}
                        <button
                            class="badge badge-sm badge-error cursor-pointer px-2"
                            onclick={onProblems}
                            title="Failed — click to view problems">{failedOutputs}</button>
                    {/if}
                    {#if stoppedOutputs > 0}<div class="badge badge-sm badge-neutral px-2">
                            {stoppedOutputs}
                        </div>{/if}
                </div>
            </div>
        </div>
        <button
            class="btn btn-xs btn-square btn-accent shrink-0"
            onclick={onAdd}
            title="Add Pipeline"
            aria-label="Add Pipeline">
            <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 5v14M5 12h14" />
            </svg>
        </button>
    </div>

    <ul class="menu rounded-box w-full pb-4" id="pipelines">
        {#each pipelines as pipeline (pipeline.id)}
            <li
                data-pipeline-id={pipeline.id}
                class:opacity-40={draggingId === pipeline.id}
                ondragover={(event) => event.preventDefault()}
                ondrop={(event) => handleDrop(event, pipeline.id)}>
                <div
                    class:bg-base-100={selectedId === pipeline.id}
                    class="flex cursor-pointer items-center gap-2"
                    data-id={pipeline.id}
                    onclick={() => onSelect(pipeline.id)}>
                    <div class="shrink-0" title={pipeline.input.live ? 'Live' : 'Offline'}>
                        <div
                            class="rounded-box h-5 w-5"
                            style={`background:linear-gradient(90deg,${inputColor(pipeline)},${inputColor(pipeline)} 45%,#242933 45%,#242933 55%,${outputColor(pipeline)} 55%)`}>
                        </div>
                    </div>
                    {#if pipeline.outs.filter((output) => output.status === 'running' && !output.warningReason).length > 0}
                        <div class="badge badge-sm badge-success px-2">
                            {pipeline.outs.filter(
                                (output) => output.status === 'running' && !output.warningReason,
                            ).length}
                        </div>
                    {/if}
                    {#if pipeline.outs.filter((output) => output.status === 'running' && !!output.warningReason).length > 0}
                        <div class="badge badge-sm badge-warning px-2">
                            {pipeline.outs.filter(
                                (output) => output.status === 'running' && !!output.warningReason,
                            ).length}
                        </div>
                    {/if}
                    {#if pipeline.outs.filter((output) => output.status === 'failed').length > 0}
                        <div class="badge badge-sm badge-error px-2">
                            {pipeline.outs.filter((output) => output.status === 'failed').length}
                        </div>
                    {/if}
                    <button
                        class="js-pipeline-drag-handle min-w-0 flex-1 cursor-grab truncate text-left"
                        draggable="true"
                        title="Drag to reorder"
                        onclick={(event) => event.stopPropagation()}
                        ondragstart={(event) => handleDragStart(event, pipeline.id)}
                        >{pipeline.name}</button>
                    {#if pipeline.input.live && pipeline.input.uptimeMs !== null}
                        <span class="shrink-0 font-mono text-xs opacity-60"
                            >{formatUptime(pipeline.input.uptimeMs)}</span>
                    {/if}
                    {#if pipeline.input.connected}
                        <span class="badge badge-sm badge-outline shrink-0"
                            >{pipeline.srtBonding.acceptedBySrs
                                ? 'Relay'
                                : pipeline.input.isSrt
                                  ? 'SRT'
                                  : 'RTMP'}</span>
                    {/if}
                </div>
            </li>
        {/each}
    </ul>
</div>
