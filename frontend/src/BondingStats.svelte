<script lang="ts">
    import type { PipelineView, SrtBondingLeg } from './dashboard/types.js';
    import {
        fmtMbpsValue,
        fmtMs,
        STATUS_COLOR_ERROR,
        STATUS_COLOR_GOOD,
        STATUS_COLOR_WARN,
    } from './dashboard/core/utils.js';

    export let pipeline: PipelineView | null = null;
    export let relayRunning = false;

    function count(value: number | null | undefined): string {
        if (value == null) return '—';
        if (value >= 1_000_000)
            return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
        if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
        return String(Math.round(value));
    }

    function lossRexmitDrop(
        loss: number | null | undefined,
        rexmit: number | null | undefined,
        drop: number | null | undefined,
    ): string {
        return `${count(loss)} / ${count(rexmit)} / ${count(drop)}`;
    }

    function legColor(leg: SrtBondingLeg): string {
        if (leg.health === 'error') return STATUS_COLOR_ERROR;
        if (leg.health === 'warn') return STATUS_COLOR_WARN;
        return STATUS_COLOR_GOOD;
    }

    function legLabel(leg: SrtBondingLeg): string {
        return (leg.health ?? (leg.state === 'running' ? 'ok' : 'warn')).toUpperCase();
    }

    $: bonding = pipeline?.srtBonding;
    $: inputStatsAreDropOnly = bonding
        ? bonding.input.recvLossTotal === null && bonding.input.retransTotal === null
        : false;
    $: hasSessionStats =
        !!bonding &&
        relayRunning &&
        (bonding.inputActive ||
            (bonding.input.recvUniquePacketsTotal || bonding.input.recvPacketsTotal || 0) > 0 ||
            (bonding.input.retransTotal ?? 0) > 0);
    $: hasOutputStats =
        !!bonding &&
        relayRunning &&
        (bonding.outputConnected || bonding.output.sentPacketsTotal > 0);
</script>

{#if bonding && (hasSessionStats || hasOutputStats)}
    <div class="input-meta-row input-meta-row-sm">
        {#if hasSessionStats}
            <span
                class="input-meta-item"
                title="Unique data packets received from the upstream bonded SRT input"
                ><span class="input-meta-label">Rx</span><span class="input-meta-value"
                    >{count(
                        bonding.input.recvUniquePacketsTotal || bonding.input.recvPacketsTotal || 0,
                    )}</span
                ></span>
            <span class="input-meta-item" title="Negotiated SRT buffering latency"
                ><span class="input-meta-label">Latency</span><span class="input-meta-value"
                    >{fmtMs(bonding.input.latencyMs)}</span
                ></span>
            <span class="input-meta-item" title="Loss / Rexmit / Drop"
                ><span class="input-meta-label">{inputStatsAreDropOnly ? 'Drop' : 'L / R / D'}</span
                ><span class="input-meta-value"
                    >{inputStatsAreDropOnly
                        ? count(bonding.input.recvDropTotal)
                        : lossRexmitDrop(
                              bonding.input.recvLossTotal,
                              bonding.input.retransTotal,
                              bonding.input.recvDropTotal,
                          )}</span
                ></span>
        {/if}
        {#if hasOutputStats}<span
                class="input-meta-item"
                title="Loss / Rexmit / Drop on downstream output"
                ><span class="input-meta-label">Out L / R / D</span><span class="input-meta-value"
                    >{lossRexmitDrop(
                        bonding.output.sendLossTotal,
                        bonding.output.retransTotal,
                        bonding.output.sendDropTotal,
                    )}</span
                ></span
            >{/if}
    </div>
{/if}

{#if bonding && bonding.input.legs.length > 0}
    <div class="mb-1 mt-2 text-xs font-semibold opacity-60">
        Bonded legs ({bonding.input.legs.length})
    </div>
    <div class="overflow-x-auto">
        <table class="table table-xs">
            <thead
                ><tr
                    ><th>State</th><th>Leg IP</th><th>RTT</th><th>Rate</th><th>Buffer</th><th
                        ><span title="Loss / Rexmit / Drop">L / R / D</span></th
                    ></tr
                ></thead>
            <tbody>
                {#each bonding.input.legs as leg}
                    <tr>
                        <td title={leg.healthReason ?? `Transport state: ${leg.state}`}
                            ><span class="inline-flex items-center gap-1"
                                ><span
                                    class="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                                    style:background={legColor(leg)}></span
                                >{legLabel(leg)} <span class="opacity-60">({leg.state})</span></span
                            ></td>
                        <td class="font-mono text-xs">{leg.ip}</td>
                        <td class="font-mono text-xs">{fmtMs(leg.rttMs)}</td>
                        <td class="font-mono text-xs">{fmtMbpsValue(leg.recvRateMbps)}</td>
                        <td class="font-mono text-xs">{fmtMs(leg.rcvBufMs)}</td>
                        <td class="font-mono text-xs"
                            >{lossRexmitDrop(
                                leg.recvLossTotal,
                                leg.retransTotal,
                                leg.recvDropTotal,
                            )}</td>
                    </tr>
                {/each}
            </tbody>
        </table>
    </div>
{/if}
