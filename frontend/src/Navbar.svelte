<script lang="ts">
    import { formatBitrate, formatBytesCompact } from './dashboard/core/utils.js';
    import type { SystemMetrics } from './dashboard/types.js';

    export let serverName = 'Restream SRS';
    export let activeView: 'overview' | 'pipeline' | 'hosts' | 'logs' | 'settings' = 'overview';
    export let metrics: Partial<SystemMetrics> = {};
    export let saving = false;
    export let onHome: () => void;
    export let onHosts: () => void;
    export let onLogs: () => void;
    export let onSettings: () => void;
    export let onLogout: () => void;

    function formatUptime(seconds: number | undefined): string {
        if (seconds === undefined || !Number.isFinite(seconds)) return 'Up —';
        const total = Math.max(0, Math.floor(seconds));
        const days = Math.floor(total / 86400);
        const hours = Math.floor((total % 86400) / 3600);
        const minutes = Math.floor((total % 3600) / 60);
        const secs = total % 60;
        if (days > 0) return 'Up ' + days + 'd ' + hours + 'h';
        if (hours > 0) return 'Up ' + hours + 'h ' + minutes + 'm';
        if (minutes > 0) return 'Up ' + minutes + 'm ' + secs + 's';
        return 'Up ' + secs + 's';
    }

    function percent(used: number, total: number): number {
        return total > 0 ? Math.round((used / total) * 100) : 0;
    }

    $: metricText = {
        uptime: formatUptime(metrics.uptimeSeconds),
        cpu: metrics.cpu ? metrics.cpu.cores + 'c CPU: ' + metrics.cpu.percent + '%' : 'CPU —',
        ram: metrics.ram
            ? formatBytesCompact(metrics.ram.totalBytes) +
              ' RAM: ' +
              percent(metrics.ram.usedBytes, metrics.ram.totalBytes) +
              '%'
            : 'RAM —',
        disk: metrics.disk
            ? formatBytesCompact(metrics.disk.totalBytes) +
              ' Disk: ' +
              percent(metrics.disk.usedBytes, metrics.disk.totalBytes) +
              '%'
            : 'Disk —',
        rx: metrics.net ? '↓ ' + formatBitrate((metrics.net.rxBytesPerSec * 8) / 1000) : '↓ —',
        tx: metrics.net ? '↑ ' + formatBitrate((metrics.net.txBytesPerSec * 8) / 1000) : '↑ —',
    };
</script>

<div class="navbar bg-base-100 border-base-content/10 shrink-0 border-b">
    <div class="flex flex-1 items-center gap-3">
        <button
            class="btn btn-ghost px-2 text-xl font-bold"
            id="server-name-display"
            onclick={onHome}>{serverName}</button>
        <button
            id="host-connections-nav-btn"
            class="btn btn-square btn-sm btn-ghost opacity-70"
            class:btn-active={activeView === 'hosts'}
            type="button"
            onclick={onHosts}
            title="Host Connections"
            aria-label="Host Connections">
            <svg
                xmlns="http://www.w3.org/2000/svg"
                class="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M8 16a4 4 0 1 1 0-8" />
                <path stroke-linecap="round" stroke-linejoin="round" d="M16 8a4 4 0 1 1 0 8" />
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 12h.01" />
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 8h.01" />
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 16h.01" />
            </svg>
        </button>
        <button
            id="srs-logs-nav-btn"
            class="btn btn-square btn-sm btn-ghost opacity-70"
            class:btn-active={activeView === 'logs'}
            onclick={onLogs}
            title="Server Logs"
            aria-label="Server Logs">
            <svg
                xmlns="http://www.w3.org/2000/svg"
                class="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
                <path d="M12 7v5l4 2" />
            </svg>
        </button>
        <button
            id="settings-nav-btn"
            class="btn btn-square btn-sm btn-ghost opacity-70"
            class:btn-active={activeView === 'settings'}
            onclick={onSettings}
            title="Settings"
            aria-label="Settings">
            <svg
                xmlns="http://www.w3.org/2000/svg"
                class="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2">
                <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
                <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1A2 2 0 1 1 4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7A2 2 0 1 1 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 1 1 19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.1a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1.6 1Z" />
            </svg>
        </button>
        <a
            class="btn btn-square btn-sm btn-ghost opacity-70"
            href="https://github.com/live-miracles/restream-srs"
            target="_blank"
            rel="noopener noreferrer"
            title="GitHub"
            aria-label="GitHub repository">
            <svg
                xmlns="http://www.w3.org/2000/svg"
                class="h-4 w-4"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true">
                <path
                    fill-rule="evenodd"
                    clip-rule="evenodd"
                    d="M12 .5C5.65.5.5 5.65.5 12c0 5.09 3.29 9.39 7.86 10.92.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.69-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.18-3.08-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.16 1.18.92-.25 1.9-.38 2.88-.38.98 0 1.96.13 2.88.38 2.19-1.49 3.15-1.18 3.15-1.18.63 1.58.23 2.75.12 3.04.74.8 1.18 1.83 1.18 3.08 0 4.42-2.69 5.39-5.25 5.67.42.36.78 1.07.78 2.16 0 1.56-.01 2.82-.01 3.2 0 .31.21.68.79.56A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
            </svg>
        </a>
        <div
            id="saving-badge"
            class="items-center gap-2 text-sm opacity-60"
            class:hidden={!saving}
            class:flex={saving}>
            <span class="loading loading-infinity loading-xs"></span>
            Saving
        </div>
    </div>
    <div class="flex-none">
        <div class="divide-base-content/15 flex items-center divide-x">
            <span class="px-3 font-mono text-sm tabular-nums" id="navbar-uptime"
                >{metricText.uptime}</span>
            <span class="px-3 font-mono text-sm tabular-nums" id="navbar-cpu-value"
                >{metricText.cpu}</span>
            <span class="px-3 font-mono text-sm tabular-nums" id="navbar-ram-value"
                >{metricText.ram}</span>
            <span class="px-3 font-mono text-sm tabular-nums" id="navbar-disk-value"
                >{metricText.disk}</span>
            <span class="px-3 font-mono text-sm tabular-nums" id="navbar-net-rx"
                >{metricText.rx}</span>
            <span class="px-3 font-mono text-sm tabular-nums" id="navbar-net-tx"
                >{metricText.tx}</span>
        </div>
    </div>
    <button
        class="btn btn-square btn-sm btn-ghost text-error/80 hover:text-error ml-2"
        onclick={onLogout}
        title="Logout"
        aria-label="Logout">
        <svg
            xmlns="http://www.w3.org/2000/svg"
            class="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2">
            <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <path stroke-linecap="round" stroke-linejoin="round" d="M16 17l5-5-5-5" />
            <path stroke-linecap="round" stroke-linejoin="round" d="M21 12H9" />
        </svg>
    </button>
</div>
