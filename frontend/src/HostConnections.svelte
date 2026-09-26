<script lang="ts">
    import { afterUpdate, onMount } from 'svelte';
    import type { HostProbeOverview, HostProbeTarget } from './dashboard/types.js';
    import { state } from './dashboard/core/state.js';
    import { refreshHostProbes } from './dashboard/features/dashboard.js';
    import { drawHostProbeCharts } from './dashboard/features/render.js';

    export let hostProbes: Partial<HostProbeOverview> = {};
    export let configuredTargets: HostProbeTarget[] = [];

    $: targets = hostProbes.targets ?? [];
    $: allHistory = targets.flatMap((target) => target.history);
    $: oldest = allHistory.length > 0 ? Math.min(...allHistory.map((sample) => sample.ts)) : null;
    $: maxOffset = oldest == null ? 0 : Math.max(0, Date.now() - oldest - 15 * 60 * 1000);
    $: windowEnd = Date.now() - state.hostChartOffsetMs;
    $: windowStart = windowEnd - 15 * 60 * 1000;
    $: atLive = state.hostChartOffsetMs === 0;
    $: atStart = state.hostChartOffsetMs >= maxOffset && maxOffset > 0;

    function formatTime(ts: number): string {
        return new Date(ts).toLocaleTimeString(undefined, { hour12: false });
    }
    function maxLatency(entry: HostProbeOverview['targets'][number]): number | null {
        return entry.history.reduce<number | null>((max, sample) => {
            if (sample.ts < windowStart || sample.ts > windowEnd || sample.latencyMs == null)
                return max;
            return max == null ? sample.latencyMs : Math.max(max, sample.latencyMs);
        }, null);
    }
    function failureSummary(entry: HostProbeOverview['targets'][number]): {
        text: string;
        tone: string;
    } {
        const failures = entry.history.filter(
            (sample) => sample.ts >= windowStart && sample.ts <= windowEnd && !sample.ok,
        );
        const latest = entry.latestSample;
        if (latest && !latest.ok)
            return { text: latest.error ?? 'probe failed', tone: 'text-error' };
        if (failures.length > 0)
            return {
                text: `${failures.length} failure${failures.length === 1 ? '' : 's'} in this window, last at ${formatTime(failures[failures.length - 1].ts)}`,
                tone: 'text-warning',
            };
        return { text: 'no recent failures', tone: 'opacity-60' };
    }
    function moveChart(delta: number): void {
        state.hostChartOffsetMs = Math.max(0, Math.min(maxOffset, state.hostChartOffsetMs + delta));
    }

    onMount(drawHostProbeCharts);
    afterUpdate(drawHostProbeCharts);
</script>

<div
    class="bg-base-200 col-span-2 mt-4 overflow-y-auto rounded-xl p-4 shadow"
    role="region"
    aria-label="Host connections">
    {#if configuredTargets.length === 0}
        <div class="rounded-xl border border-dashed border-base-content/15 p-8 text-center">
            <h2 class="text-lg font-semibold">No Host Probes Configured</h2>
            <p class="mt-2 text-sm opacity-60">
                Open Settings and add up to 10 host targets to monitor connectivity.
            </p>
        </div>
    {:else}
        <div class="mb-4 flex items-center justify-between gap-3">
            <div class="min-w-0 text-sm">
                <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span class="badge badge-outline badge-sm font-mono"
                        >Updated {hostProbes.generatedAt
                            ? formatTime(new Date(hostProbes.generatedAt).getTime())
                            : '—'}</span>
                    <h2 class="text-base font-bold">Host Connections</h2>
                    <span class="opacity-60"
                        >TCP probe history for configured platform hosts. Probe interval {hostProbes.intervalMs !=
                        null
                            ? `${Math.round(hostProbes.intervalMs / 1000)}s`
                            : 'unknown'}.</span>
                </div>
            </div>
            <button
                type="button"
                class="btn btn-sm btn-ghost btn-square"
                title="Refresh host connections"
                onclick={() => void refreshHostProbes()}
                ><svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 20 20"
                    class="block h-4 w-4 shrink-0 fill-current"
                    aria-hidden="true"
                    ><path
                        d="M10 3a7 7 0 0 1 6.56 4.57.75.75 0 1 1-1.4.53A5.5 5.5 0 1 0 14.5 13H12a.75.75 0 0 1 0-1.5h4.25A.75.75 0 0 1 17 12.25v4.25a.75.75 0 0 1-1.5 0v-1.77A7 7 0 1 1 10 3Z" /></svg
                ></button>
        </div>
        <div class="bg-base-300 mb-4 rounded-xl p-4 text-sm leading-6 opacity-85">
            Use this view to correlate output failures with basic reachability to the configured
            ingest hosts. A healthy line means the server could open a TCP connection to that host
            and port at that time; red markers mean the connect probe failed or timed out. This is
            useful for ruling in or out broad network-path problems from the server to YouTube,
            Facebook, or other destinations.<br /><br />Limitations: these probes do not perform a
            full RTMP or RTMPS publish handshake, and they do not prove the destination will accept
            or keep a live stream session open. A host can look healthy here while the platform
            still rejects, resets, or drops an actual publish connection.
        </div>
        <div class="mb-2 flex items-center justify-center gap-2 px-1">
            <button
                class="btn btn-xs btn-ghost"
                disabled={atStart || maxOffset === 0}
                onclick={() => moveChart(10 * 60 * 1000)}>← 10 min</button
            ><span class="inline-flex w-28 justify-center"
                >{#if atLive}<span class="badge badge-success badge-xs gap-1">LIVE</span
                    >{:else}<span class="font-mono text-xs opacity-60"
                        >{formatTime(windowStart)} – {formatTime(windowEnd)}</span
                    >{/if}</span
            ><button
                class="btn btn-xs btn-ghost"
                disabled={atLive}
                onclick={() => moveChart(-10 * 60 * 1000)}>10 min →</button>
        </div>
        <div class="overflow-x-auto">
            <table class="table table-sm">
                <thead
                    ><tr
                        ><th>Label</th><th>Host</th><th>Status</th><th>Latest</th><th
                            >15min Higherst</th
                        ><th>Avg</th><th>6h Fail</th><th>Last Sample</th><th>Resolved IP</th></tr
                    ></thead
                ><tbody>
                    {#if targets.length === 0}<tr
                            ><td colspan="9" class="py-4 text-center opacity-50"
                                >No probe history loaded yet — click refresh.</td
                            ></tr
                        >{/if}
                    {#each targets as entry}
                        {@const latest = entry.latestSample}
                        <tr
                            ><td class="font-semibold">{entry.target.label}</td><td
                                class="font-mono text-xs"
                                >{entry.target.host}:{entry.target.port}</td
                            ><td
                                >{#if !latest}<span class="badge badge-sm badge-neutral"
                                        >No Data</span
                                    >{:else if latest.ok}<span class="badge badge-sm badge-success"
                                        >Healthy</span
                                    >{:else}<span class="badge badge-sm badge-error">Down</span
                                    >{/if}</td
                            ><td class="font-mono text-xs"
                                >{latest?.latencyMs != null
                                    ? `${Math.round(latest.latencyMs)} ms`
                                    : '—'}</td
                            ><td class="font-mono text-xs"
                                >{maxLatency(entry) != null
                                    ? `${Math.round(maxLatency(entry)!)} ms`
                                    : '—'}</td
                            ><td class="font-mono text-xs"
                                >{entry.averageLatencyMs != null
                                    ? `${Math.round(entry.averageLatencyMs)} ms`
                                    : '—'}</td
                            ><td class="font-mono text-xs">{entry.historyFailureCount}</td><td
                                class="font-mono text-xs">{latest ? formatTime(latest.ts) : '—'}</td
                            ><td class="font-mono text-xs">{latest?.resolvedAddress ?? '—'}</td
                            ></tr>
                    {/each}
                </tbody>
            </table>
        </div>
        <div class="mt-6 grid grid-cols-1 gap-4">
            {#each targets as entry}{@const latest = entry.latestSample}{@const summary =
                    failureSummary(entry)}
                <div class="bg-base-300 rounded-xl p-4">
                    <div class="mb-3 flex items-start justify-between gap-3">
                        <div>
                            <h3 class="font-semibold">{entry.target.label}</h3>
                            <p class="font-mono text-xs opacity-60">
                                {entry.target.host}:{entry.target.port}
                            </p>
                        </div>
                        <div class="text-right">
                            <div class="font-mono text-sm">
                                {latest?.latencyMs != null
                                    ? `${Math.round(latest.latencyMs)} ms`
                                    : '—'}
                            </div>
                            <div class={`text-xs ${summary.tone}`}>{summary.text}</div>
                        </div>
                    </div>
                    <canvas
                        id={`host-probe-chart-${entry.target.slot}`}
                        style="width:100%;height:110px;display:block"></canvas>
                </div>{/each}
        </div>
    {/if}
</div>
