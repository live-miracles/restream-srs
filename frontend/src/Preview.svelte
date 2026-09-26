<script lang="ts">
    import { onDestroy } from 'svelte';
    import type { PipelineView } from './dashboard/types.js';
    import { stopCurrentPreview } from './dashboard/features/preview.js';

    export let onToggle: () => void;
    export let onTrackChange: (trackIndex: number) => void;
    export let onMute: () => void;
    export let onReload: () => void;
    export let onMaximize: () => void;
    export let pipeline: PipelineView | null = null;

    onDestroy(() => stopCurrentPreview());
    $: if (!pipeline?.input.live) stopCurrentPreview();
</script>

<div id="preview-section" class:hidden={!pipeline?.input.live} class="mb-4">
    <div id="preview-card" class="border-base-content/10 bg-base-100/50 rounded-xl border p-3">
        <div class="mb-2 flex items-center justify-between">
            <span class="text-xs font-semibold opacity-60">PREVIEW</span>
            <div class="flex items-center gap-2">
                <select
                    id="preview-audio-select"
                    class:hidden={(pipeline?.input.audioTracks?.length ?? 0) <= 1}
                    class="select select-xs max-w-44"
                    onchange={(event) =>
                        onTrackChange(Number((event.currentTarget as HTMLSelectElement).value))}>
                    {#each pipeline?.input.audioTracks ?? [] as track}
                        <option value={track.index}
                            >Track {track.index + 1}{track.language || track.title
                                ? ` (${[track.language, track.title].filter(Boolean).join(' ')})`
                                : ''}</option>
                    {/each}
                </select>
                <button id="preview-stop-btn" class="btn btn-xs btn-ghost" onclick={onToggle}>
                    <svg
                        id="preview-btn-play-icon"
                        xmlns="http://www.w3.org/2000/svg"
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
                    <svg
                        id="preview-btn-stop-icon"
                        xmlns="http://www.w3.org/2000/svg"
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        class="hidden"><rect width="14" height="14" x="5" y="5" rx="2" /></svg>
                    <span id="preview-btn-spinner" class="loading loading-spinner loading-xs hidden"
                    ></span>
                    <span id="preview-btn-label">Preview</span>
                </button>
                <button
                    id="preview-mute-btn"
                    title="Unmute"
                    onclick={onMute}
                    class="btn btn-square btn-ghost btn-xs"
                    disabled>
                    <svg
                        id="preview-icon-muted"
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        ><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><line
                            x1="23"
                            y1="9"
                            x2="17"
                            y2="15" /><line x1="17" y1="9" x2="23" y2="15" /></svg>
                    <svg
                        id="preview-icon-unmuted"
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        class="hidden"
                        ><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path
                            d="M15.54 8.46a5 5 0 0 1 0 7.07" /><path
                            d="M19.07 4.93a10 10 0 0 1 0 14.14" /></svg>
                </button>
                <button
                    id="preview-reload-btn"
                    title="Reload"
                    onclick={onReload}
                    class="btn btn-square btn-ghost btn-xs"
                    disabled>
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        ><polyline points="23 4 23 10 17 10" /><polyline
                            points="1 20 1 14 7 14" /><path
                            d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>
                </button>
                <button
                    id="preview-maximize-btn"
                    title="Maximize"
                    onclick={onMaximize}
                    class="btn btn-square btn-ghost btn-xs"
                    disabled>
                    <svg
                        id="preview-icon-expand"
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        ><polyline points="15 3 21 3 21 9" /><polyline
                            points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line
                            x1="3"
                            y1="21"
                            x2="10"
                            y2="14" /></svg>
                    <svg
                        id="preview-icon-compress"
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        class="hidden"
                        ><polyline points="4 14 10 14 10 20" /><polyline
                            points="20 10 14 10 14 4" /><line x1="10" y1="14" x2="3" y2="21" /><line
                            x1="21"
                            y1="3"
                            x2="14"
                            y2="10" /></svg>
                </button>
            </div>
        </div>
        <div id="preview-stage-host" class="hidden w-full">
            <div id="preview-stage" class="flex items-stretch gap-1">
                <div id="preview-player" class="hidden aspect-video w-full min-w-0 overflow-hidden">
                    <video
                        id="preview-video"
                        class="h-full w-full rounded-lg bg-black object-contain"
                        muted
                        playsinline></video>
                </div>
                <canvas
                    id="preview-meter"
                    class="hidden h-full rounded-sm"
                    style="width: 10px; flex-shrink: 0; background: rgba(0, 0, 0, 0.3)"></canvas>
            </div>
        </div>
    </div>
</div>
