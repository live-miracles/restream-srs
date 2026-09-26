<script lang="ts">
    import type { ConfigData, PipelineView } from './dashboard/types.js';
    import { updatePipeline } from './dashboard/core/api.js';
    import { refreshAfterMutation } from './dashboard/features/dashboard.js';
    import { maskStreamKey } from './dashboard/core/utils.js';

    export let pipeline: PipelineView | null = null;
    export let config: ConfigData | null = null;
    export let visible = false;
    export let onClose: () => void;

    let name = '';
    let streamKeyId = '';
    let saving = false;
    let initializedFor: string | null = null;

    $: if (visible && pipeline && initializedFor !== pipeline.id) {
        name = pipeline.name;
        streamKeyId = String(pipeline.streamKeyId);
        initializedFor = pipeline.id;
    }

    $: hasActiveOutputs =
        pipeline?.outs.some((output) => output.desiredState !== 'stopped') ?? false;

    async function save(): Promise<void> {
        const trimmed = name.trim();
        if (!trimmed || !pipeline) return;
        saving = true;
        try {
            const result = await updatePipeline(pipeline.id, trimmed, Number(streamKeyId));
            if (result) {
                initializedFor = null;
                onClose();
                await refreshAfterMutation();
            }
        } finally {
            saving = false;
        }
    }
</script>

{#if visible && pipeline}
    <dialog class="modal" open>
        <div class="modal-box w-fit">
            <div class="mx-auto mt-2 px-4">
                <h2 class="mb-3 text-xl font-bold">Edit Pipeline</h2>
                <div class="flex items-end gap-3">
                    <fieldset class="fieldset">
                        <legend class="fieldset-legend">Pipeline Name</legend>
                        <input class="input w-48" placeholder="My Stream" bind:value={name} />
                    </fieldset>
                    <fieldset class="fieldset">
                        <legend class="fieldset-legend">Stream Key</legend>
                        <select
                            class="select w-44 font-mono text-sm"
                            bind:value={streamKeyId}
                            disabled={hasActiveOutputs}
                            title={hasActiveOutputs
                                ? 'Stop all outputs before changing stream key'
                                : ''}>
                            {#each config?.streamKeys ?? [] as key}
                                <option value={key.id}>{maskStreamKey(key.key)}</option>
                            {/each}
                        </select>
                    </fieldset>
                </div>
            </div>
            <div class="modal-action">
                <button
                    class="btn mx-2"
                    type="button"
                    onclick={() => {
                        initializedFor = null;
                        onClose();
                    }}>Cancel</button>
                <button
                    class="btn btn-accent"
                    type="button"
                    disabled={saving || !name.trim()}
                    onclick={() => void save()}>Save</button>
            </div>
        </div>
    </dialog>
{/if}
