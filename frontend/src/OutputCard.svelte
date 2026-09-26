<script lang="ts">
    import type { InputHealth, OutputView } from './dashboard/types.js';
    import {
        formatOutputMemory,
        formatUptime,
        outputEncodingWarnings,
        outputMemoryPercent,
        outStatus,
        restreamSinkLabel,
    } from './dashboard/features/render.js';
    import {
        formatBitrate,
        STATUS_COLOR_ERROR,
        STATUS_COLOR_GOOD,
        STATUS_COLOR_OFF,
        STATUS_COLOR_WARN,
    } from './dashboard/core/utils.js';

    export let output: OutputView;
    export let input: InputHealth;
    export let duplicateRefs: { pipelineName: string; outputName?: string }[] | undefined =
        undefined;
    export let pending = false;
    export let onStart: () => void;
    export let onStop: () => void;
    export let onEdit: () => void;
    export let onDelete: () => void;
    export let onErrorInfo: () => void;

    $: stopped = output.desiredState === 'stopped';
    $: running = output.status === 'running';
    $: status = outStatus(output, input);
    $: statusColor =
        status === 'good'
            ? STATUS_COLOR_GOOD
            : status === 'warn'
              ? STATUS_COLOR_WARN
              : status === 'error'
                ? STATUS_COLOR_ERROR
                : STATUS_COLOR_OFF;
    $: warnings = outputEncodingWarnings(output, input);
    $: memoryPercent = outputMemoryPercent(output);
    $: uptime = output.startedAtMs === null ? null : Date.now() - output.startedAtMs;
    $: lastErrorLine =
        output.lastError && output.lastErrorAt
            ? (output.lastError
                  .split('\n')
                  .filter((line) => line.trim())
                  .slice(-1)[0] ?? '')
            : '';
    $: lastErrorTime = output.lastErrorAt
        ? new Date(output.lastErrorAt).toLocaleTimeString(undefined, { hour12: false })
        : '';
    $: stats = [
        output.bitrateKbps !== null ? formatBitrate(output.bitrateKbps) : null,
        output.cpuPercent !== null ? `${output.cpuPercent}%` : null,
        output.memoryUsageBytes !== null ? formatOutputMemory(output) : null,
    ].filter((value): value is string => value !== null);

    function displayUrl(url: string): string {
        return url.length > 27 ? `${url.slice(0, 25)}...${url.slice(-2)}` : url;
    }
</script>

<div
    class="bg-base-100 w-full min-w-0 space-y-0.5 rounded-xl border border-base-content/10 px-3 py-2"
    style:background={warnings.length > 0
        ? 'color-mix(in oklch, var(--color-warning) 15%, transparent)'
        : undefined}
    data-output-card={output.id}>
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <div class="flex shrink-0 items-center gap-2 font-semibold">
            <div aria-label="status" class="status status-lg mx-1" style:background={statusColor}>
            </div>
            <button
                class={`btn btn-xs ${stopped ? 'btn-accent' : 'btn-accent btn-outline'}`}
                disabled={pending}
                onclick={stopped ? onStart : onStop}>{stopped ? 'Start' : 'Stop'}</button>
            <span class="js-output-drag-handle cursor-grab" draggable="true" title="Drag to reorder"
                >{output.name}</span>
        </div>
        {#if output.videoEncoding !== 'copy'}<span
                class="badge badge-sm badge-accent badge-soft whitespace-nowrap"
                >{output.videoEncoding}</span
            >{/if}
        {#if output.audioEncoding !== 'copy'}<span
                class="badge badge-xs badge-accent badge-soft whitespace-nowrap"
                >{output.audioEncoding
                    .split(',')
                    .map((track) => `T${parseInt(track) + 1}`)
                    .join('+')}</span
            >{/if}
        {#if output.translation}<span
                class="badge badge-sm badge-secondary badge-soft whitespace-nowrap"
                >translation</span
            >{/if}
        {#if uptime !== null}<span class="font-mono text-xs whitespace-nowrap opacity-60"
                >{formatUptime(uptime)}</span
            >{/if}
        {#if running && stats.length > 0}
            <span
                class={`badge badge-sm whitespace-nowrap ${memoryPercent !== null && memoryPercent >= 90 ? 'badge-error' : memoryPercent !== null && memoryPercent >= 70 ? 'badge-warning' : ''}`}
                title="Bitrate / ffmpeg CPU (% of one core) / ffmpeg RSS">{stats.join(' | ')}</span>
        {/if}
        {#if output.url}
            <code
                class={`text-xs font-normal whitespace-nowrap ${duplicateRefs ? 'text-warning' : 'opacity-60'}`}
                title={output.url}>{restreamSinkLabel(output.url) ?? displayUrl(output.url)}</code>
            {#if duplicateRefs}
                <span
                    class="js-tooltip inline-flex shrink-0 text-warning"
                    title="Duplicate destination"
                    ><svg
                        xmlns="http://www.w3.org/2000/svg"
                        class="h-4 w-4"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        aria-hidden="true"
                        ><path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg
                    ></span>
            {/if}
        {/if}
        <div class="ml-auto flex shrink-0 items-center gap-1">
            {#if output.hasErrorHistory}<button
                    class="btn btn-xs btn-ghost text-error"
                    title="Error history"
                    onclick={onErrorInfo}
                    ><svg
                        xmlns="http://www.w3.org/2000/svg"
                        class="h-3.5 w-3.5"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                        ><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path
                            d="M3 3v5h5" /><path d="M12 7v5l4 2" /></svg
                    ></button
                >{/if}
            <button class="btn btn-xs btn-ghost" title="Edit output" onclick={onEdit}
                ><svg
                    xmlns="http://www.w3.org/2000/svg"
                    class="h-3.5 w-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                    ><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /><path
                        d="m15 5 4 4" /></svg
                ></button>
            <button
                class:btn-disabled={!stopped}
                class="btn btn-xs btn-ghost text-error"
                title="Delete output"
                disabled={!stopped}
                onclick={onDelete}
                ><svg
                    xmlns="http://www.w3.org/2000/svg"
                    class="h-3.5 w-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                    ><path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path
                        d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /><line
                        x1="10"
                        x2="10"
                        y1="11"
                        y2="17" /><line x1="14" x2="14" y1="11" y2="17" /></svg
                ></button>
        </div>
    </div>
    {#if output.warningReason}<div class="mt-0.5 flex min-w-0 items-center gap-2 pl-2">
            <span class="text-warning"
                ><svg
                    xmlns="http://www.w3.org/2000/svg"
                    class="h-4 w-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    aria-hidden="true"
                    ><path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg
                ></span
            ><span class="truncate text-xs text-warning">{output.warningReason}</span>
        </div>{/if}
    {#each warnings as warning}<div class="mt-0.5 flex min-w-0 items-center gap-2 pl-2">
            <span class="text-warning"
                ><svg
                    xmlns="http://www.w3.org/2000/svg"
                    class="h-4 w-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    aria-hidden="true"
                    ><path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg
                ></span
            ><span class="truncate text-xs text-warning" title={warning}>{warning}</span>
        </div>{/each}
    {#if lastErrorLine && !stopped}
        <div class="mt-0.5 flex min-w-0 items-center gap-2 pl-2">
            <span class="badge badge-sm badge-error">{output.failures}</span><span
                class="shrink-0 text-xs text-error">{lastErrorTime}</span
            ><span class="truncate text-xs text-error">{lastErrorLine}</span>
        </div>
    {/if}
</div>
