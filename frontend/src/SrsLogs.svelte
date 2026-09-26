<script lang="ts">
    import { onMount } from 'svelte';
    import { getSrsLogs } from './dashboard/core/api.js';
    import type { ServerLogTail, SrsLogsData } from './dashboard/types.js';

    let data: SrsLogsData | null = null;
    let loading = false;

    const terminals: { label: string; key: 'dashboard' | 'srs' | 'relay' }[] = [
        { label: 'Dashboard', key: 'dashboard' },
        { label: 'SRS', key: 'srs' },
        { label: 'Relay', key: 'relay' },
    ];
    const ansiClasses: Record<string, string> = {
        '31': 'text-error',
        '91': 'text-error',
        '33': 'text-warning',
        '93': 'text-warning',
        '32': 'text-success',
        '92': 'text-success',
        '34': 'text-info',
        '94': 'text-info',
        '36': 'text-info',
        '96': 'text-info',
        '35': 'text-secondary',
        '95': 'text-secondary',
    };

    function escape(value: string): string {
        return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function ansiLine(line: string): string {
        const regex = /\x1b\[([0-9;]*)m/g;
        let html = '';
        let last = 0;
        let open = false;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(line))) {
            html += escape(line.slice(last, match.index));
            last = regex.lastIndex;
            if (open) html += '</span>';
            const cls = match[1]
                .split(';')
                .map((code) => ansiClasses[code])
                .find(Boolean);
            html += cls ? `<span class="${cls}">` : '';
            open = !!cls;
        }
        html += escape(line.slice(last));
        return open ? `${html}</span>` : html;
    }

    async function load(): Promise<void> {
        loading = true;
        try {
            data = await getSrsLogs();
        } finally {
            loading = false;
        }
    }

    function renderTail(label: string, tail: ServerLogTail): string {
        if (tail.lines.length === 0) {
            const message =
                tail.source === 'none'
                    ? `No ${label} log output found — it may not have started yet.`
                    : `${label} log output is empty — no log output yet.`;
            return `<p class="mb-4 text-sm opacity-50">${message}</p>`;
        }
        return `<div class="mb-4 h-72 overflow-y-auto rounded-xl border border-white/10 bg-black p-3"><pre class="whitespace-pre-wrap break-all text-gray-300">${tail.lines.map(ansiLine).join('\n')}</pre></div>`;
    }

    onMount(() => void load());
</script>

<div class="bg-base-200 col-span-2 mt-4 overflow-y-auto rounded-xl p-4 shadow">
    <div class="flex items-center justify-between gap-3">
        <h2 class="text-xl font-bold">Server Logs</h2>
        <button
            class="btn btn-sm btn-ghost btn-square"
            disabled={loading}
            onclick={() => void load()}
            title="Refresh server logs"
            aria-label="Refresh server logs">↻</button>
    </div>
    {#if loading && !data}<p class="mt-4 text-sm opacity-60">Loading…</p>{/if}
    {#if data}
        {#each terminals as terminal}
            <p class="mb-2 mt-4 text-xs font-semibold uppercase opacity-50">
                {terminal.label} (last 200 lines)
            </p>
            {@html renderTail(terminal.label, data[terminal.key])}
        {/each}
        <p class="mb-2 mt-4 text-xs font-semibold uppercase opacity-50">Connectivity</p>
        {#if data.events.length === 0}
            <p class="mb-4 text-sm opacity-50">No events recorded yet.</p>
        {:else}
            <div class="mb-4">
                {#each [...data.events].reverse() as event}
                    <div
                        class="flex items-center gap-3 border-b border-base-200 py-1.5 last:border-0">
                        <span
                            class={`badge badge-xs leading-none uppercase ${event.type === 'up' ? 'badge-success' : 'badge-error'}`}
                            >{event.type}</span>
                        <span class="badge badge-xs badge-outline"
                            >{event.source === 'srs' ? 'SRS' : 'SRT Bonding Relay'}</span>
                        <span class="shrink-0 opacity-70"
                            >{new Date(event.ts).toLocaleString()}</span>
                        <span class="opacity-80">{event.message}</span>
                    </div>
                {/each}
            </div>
        {/if}
    {/if}
</div>
