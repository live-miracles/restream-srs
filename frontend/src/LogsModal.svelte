<script lang="ts">
    import { afterUpdate } from 'svelte';
    import type {
        LogRequest,
        PipelineLog,
        OutputErrorRecord,
        PipelineView,
    } from './dashboard/types.js';
    import * as api from './dashboard/core/api.js';
    import { refreshAfterMutation } from './dashboard/features/dashboard.js';

    export let request: LogRequest | null = null;
    export let pipelines: PipelineView[] = [];
    export let visible = false;
    export let onClose: () => void;

    let dialog: HTMLDialogElement;
    let loading = false;
    let errorHistory: OutputErrorRecord[] = [];
    let pipelineLogs: PipelineLog[] = [];
    let relayMessage: string | null = null;
    let relayTimestamp: number | null = null;
    let loadedKey = '';

    $: requestKey = request ? JSON.stringify(request) : '';
    $: title = request
        ? request.kind === 'pipeline'
            ? `History — ${pipelines.find((pipeline) => pipeline.id === request.pipelineId)?.name ?? request.pipelineId}`
            : request.kind === 'output'
              ? `Error History — ${pipelines.find((pipeline) => pipeline.id === request.pipelineId)?.outs.find((output) => output.id === request.outputId)?.name ?? request.outputId}`
              : `SRT Bonding Relay Error — ${pipelines.find((pipeline) => pipeline.id === request.pipelineId)?.name ?? request.pipelineId}`
        : 'Logs';
    $: if (visible && dialog && !dialog.open) dialog.showModal();
    $: if (!visible && dialog?.open) dialog.close();
    $: if (visible && requestKey && requestKey !== loadedKey) void load(requestKey);

    afterUpdate(() => {
        if (visible && dialog && !dialog.open) dialog.showModal();
    });

    async function load(key: string): Promise<void> {
        if (!request) return;
        loadedKey = key;
        loading = true;
        errorHistory = [];
        pipelineLogs = [];
        relayMessage = null;
        const current = request;
        if (current.kind === 'pipeline') {
            pipelineLogs = (await api.getPipelineLogs(current.pipelineId)) ?? [];
        } else if (current.kind === 'output') {
            errorHistory =
                (await api.getOutputErrorHistory(current.pipelineId, current.outputId)) ?? [];
        } else {
            const pipeline = pipelines.find((candidate) => candidate.id === current.pipelineId);
            relayMessage = pipeline?.srtBonding.lastError ?? null;
            relayTimestamp = pipeline?.srtBonding.lastErrorAt ?? null;
        }
        loading = false;
    }

    async function clearErrors(): Promise<void> {
        if (!request || request.kind !== 'output') return;
        await api.clearOutputErrorHistory(request.pipelineId, request.outputId);
        errorHistory = [];
        await refreshAfterMutation();
    }

    function close(): void {
        dialog.close();
    }

    function handleDialogClose(): void {
        loadedKey = '';
        onClose();
    }
</script>

<dialog bind:this={dialog} class="modal" onclose={handleDialogClose}>
    <div class="modal-box flex h-[90vh] w-full max-w-[1400px] flex-col">
        <div class="flex shrink-0 items-center justify-between gap-2">
            <h2 class="text-xl font-bold">{title}</h2>
        </div>
        <div class="mt-4 min-h-0 flex-1 space-y-1 overflow-y-auto font-mono text-xs">
            {#if loading}
                <p class="opacity-50">Loading…</p>
            {:else if request?.kind === 'pipeline'}
                {#if pipelineLogs.length === 0}<p class="opacity-50">
                        No history recorded yet.
                    </p>{/if}
                {#each pipelineLogs as log}
                    <div
                        class="flex items-center gap-3 border-b border-base-200 py-1.5 last:border-0">
                        <span
                            class={`badge badge-xs leading-none uppercase ${log.event === 'online' ? 'badge-success' : 'badge-neutral'}`}
                            >{log.event}</span>
                        <span class="shrink-0 text-xs opacity-70"
                            >{new Date(log.ts).toLocaleString()}</span>
                        <span class="text-xs opacity-80">{log.message}</span>
                    </div>
                {/each}
            {:else if request?.kind === 'output'}
                {#if errorHistory.length === 0}<p class="opacity-50">No error recorded.</p>{/if}
                {#each [...errorHistory].reverse() as entry, index}
                    <div
                        class:mt-4={index > 0}
                        class:pt-4={index > 0}
                        class:border-t={index > 0}
                        class="font-sans">
                        <div class="mb-2 flex items-center gap-2">
                            <span
                                class={`badge badge-xs uppercase ${entry.kind === 'stopped' ? 'badge-neutral' : 'badge-error'}`}
                                >{entry.kind === 'stopped'
                                    ? 'stopped'
                                    : index === 0
                                      ? 'latest crash'
                                      : 'crash'}</span>
                            <span class="text-xs opacity-50"
                                >{entry.ts ? new Date(entry.ts).toLocaleString() : ''}</span>
                        </div>
                        {#if entry.message}<pre
                                class={`break-all whitespace-pre-wrap overflow-x-auto text-xs ${entry.kind === 'stopped' ? 'opacity-60' : 'text-error opacity-80'}`}>{entry.message}</pre>{/if}
                    </div>
                {/each}
            {:else}
                {#if relayMessage}<div class="text-xs opacity-50">
                        {relayTimestamp ? new Date(relayTimestamp).toLocaleString() : ''}
                    </div>
                    <pre
                        class="break-all whitespace-pre-wrap overflow-x-auto text-xs text-error opacity-80">{relayMessage}</pre>{:else}<p
                        class="opacity-50">
                        No error recorded.
                    </p>{/if}
            {/if}
        </div>
        <div class="modal-action shrink-0">
            <button class="btn" onclick={close}>Close</button>
            {#if request?.kind === 'output' && errorHistory.length > 0}<button
                    class="btn btn-accent"
                    onclick={() => void clearErrors()}>Clear All Errors</button
                >{/if}
        </div>
    </div>
    <form method="dialog" class="modal-backdrop"><button>close</button></form>
</dialog>
