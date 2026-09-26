<script lang="ts">
    import type { ConfigData, PipelineView } from './dashboard/types.js';
    import { copyText, maskSecret, maskStreamKey } from './dashboard/core/utils.js';
    import BondingStats from './BondingStats.svelte';

    export let pipeline: PipelineView | null = null;
    export let config: ConfigData | null = null;
    export let relayRunning = false;
    export let relayPort = 10081;
    export let onErrorInfo: () => void;

    $: streamId = pipeline ? `#!::r=live/${pipeline.streamKey},m=publish` : '';
    $: bondingUrl =
        pipeline && config
            ? `srt://${config.publicHost || 'localhost'}:${relayPort}?mode=caller&grouptype=broadcast&streamid=${streamId}${config.srtPassphrase ? `&passphrase=${encodeURIComponent(config.srtPassphrase)}&pbkeylen=16` : ''}`
            : '';
    $: displayedUrl =
        bondingUrl && pipeline
            ? bondingUrl
                  .replace(pipeline.streamKey, maskStreamKey(pipeline.streamKey))
                  .replace(
                      config?.srtPassphrase ? encodeURIComponent(config.srtPassphrase) : '',
                      config?.srtPassphrase ? maskSecret(config.srtPassphrase) : '',
                  )
            : '';
    $: hasError = Boolean(pipeline?.srtBonding.lastError);
    $: inputColor = pipeline?.srtBonding.inputActive ? '#22c55e' : '#6b7280';
    $: outputColor = relayRunning && pipeline?.srtBonding.outputConnected ? '#22c55e' : '#6b7280';
</script>

<div class="border-base-content/10 bg-base-100/50 order-last rounded-xl border p-3">
    <div class="mb-1 flex items-center justify-between gap-2">
        <div class="flex items-center gap-2">
            <div
                aria-label="SRT bonding status"
                class="h-5 w-5 shrink-0 overflow-hidden rounded-full border border-base-content/15"
                style={`background:linear-gradient(90deg,${inputColor} 0 45%,#242933 45% 55%,${outputColor} 55% 100%)`}>
            </div>
            <span class="text-xs font-semibold opacity-60">SRT Bonding</span>
        </div>
        <div class="flex gap-1">
            <button
                class="btn btn-xs btn-ghost btn-outline"
                title="Copy SRT bonding port"
                onclick={() => void copyText(String(relayPort))}
                ><svg
                    xmlns="http://www.w3.org/2000/svg"
                    class="h-3 w-3"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    aria-hidden="true"
                    ><rect width="14" height="14" x="8" y="8" rx="2" /><path
                        d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></svg
                >Port</button>
            <button
                class="btn btn-xs btn-accent btn-outline"
                title="Copy SRT bonding URL"
                onclick={() => void copyText(bondingUrl)}
                ><svg
                    xmlns="http://www.w3.org/2000/svg"
                    class="h-3 w-3"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    aria-hidden="true"
                    ><rect width="14" height="14" x="8" y="8" rx="2" /><path
                        d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></svg
                ></button>
        </div>
    </div>
    <code class="font-mono text-xs break-all opacity-80">{displayedUrl}</code>
    <BondingStats {pipeline} {relayRunning} />
    {#if hasError}
        <div class="mt-2 flex min-w-0 items-center gap-2">
            <span class="shrink-0 text-xs text-error"
                >{pipeline?.srtBonding.lastErrorAt
                    ? new Date(pipeline.srtBonding.lastErrorAt).toLocaleTimeString(undefined, {
                          hour12: false,
                      })
                    : ''}</span>
            <span class="truncate text-xs text-error">{pipeline?.srtBonding.lastError}</span>
            <button
                class="btn btn-xs btn-ghost shrink-0 p-0 leading-none text-error"
                title="View full error"
                onclick={onErrorInfo}>ⓘ</button>
        </div>
    {/if}
</div>
