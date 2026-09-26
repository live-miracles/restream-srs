<script lang="ts">
    import { onMount } from 'svelte';
    import Navbar from './Navbar.svelte';
    import PipelineSidebar from './PipelineSidebar.svelte';
    import Settings from './Settings.svelte';
    import OutputList from './OutputList.svelte';
    import InputStats from './InputStats.svelte';
    import Overview from './Overview.svelte';
    import HostConnections from './HostConnections.svelte';
    import SrsLogs from './SrsLogs.svelte';
    import PipelineEditor from './PipelineEditor.svelte';
    import BondingStats from './BondingStats.svelte';
    import OutputEditor from './OutputEditor.svelte';
    import Preview from './Preview.svelte';
    import SrtBondingPanel from './SrtBondingPanel.svelte';
    import LogsModal from './LogsModal.svelte';
    import type { LogRequest } from './dashboard/types.js';
    import { createPipeline } from './dashboard/core/api.js';
    import { dashboardSnapshot } from './dashboard/store.js';
    import { dashboardUi } from './dashboard/ui.js';
    import { startDashboardPolling } from './dashboard/features/dashboard';
    import { refreshDashboard } from './dashboard/features/dashboard.js';
    import { createOutput, deletePipeline, logout } from './dashboard/core/api.js';
    import { startOutput, stopOutput } from './dashboard/core/output-actions.js';
    import { copyText, maskSecret, maskStreamKey, setUrlParam } from './dashboard/core/utils.js';
    import { state } from './dashboard/core/state.js';
    import {
        attachHls,
        getPreviewPipelineId,
        previewTrackChange,
        reloadPreview,
        setPreviewStarting,
        stopCurrentPreview,
        syncPreviewControls,
        togglePreviewMaximize,
        togglePreviewMute,
    } from './dashboard/features/preview.js';

    let activeView: 'overview' | 'pipeline' | 'hosts' | 'logs' | 'settings' =
        (new URLSearchParams(window.location.search).get('view') as
            | 'overview'
            | 'hosts'
            | 'logs'
            | 'settings'
            | null) ?? 'overview';
    let selectedPipelineId: string | null = new URLSearchParams(window.location.search).get('p');
    let pipelineEditorVisible = false;
    let outputEditorVisible = false;
    let outputEditorOutput: import('./dashboard/types.js').OutputView | null = null;
    let logRequest: LogRequest | null = null;
    $: selectedPipeline =
        $dashboardSnapshot.pipelines.find((pipeline) => pipeline.id === selectedPipelineId) ?? null;

    function publishUrlValue(kind: 'srt' | 'rtmp', part: string): string | undefined {
        const pipeline = selectedPipeline;
        if (!pipeline) return undefined;
        if (kind === 'rtmp') {
            const lastSlash = pipeline.rtmpPublishUrl.lastIndexOf('/');
            if (part === 'server') return pipeline.rtmpPublishUrl.slice(0, lastSlash);
            if (part === 'key') return pipeline.streamKey;
            return pipeline.rtmpPublishUrl;
        }
        const url = pipeline.srtPublishUrl;
        const hostStart = 6;
        const colon = url.indexOf(':', hostStart);
        const query = url.indexOf('?', colon);
        if (part === 'ip') return url.slice(hostStart, colon);
        if (part === 'port') return url.slice(colon + 1, query > -1 ? query : undefined);
        if (part === 'streamId') return `#!::r=live/${pipeline.streamKey},m=publish`;
        if (part === 'passphrase') return $dashboardSnapshot.config?.srtPassphrase ?? '';
        return url;
    }

    function displayPublishUrl(kind: 'srt' | 'rtmp'): string {
        const value = publishUrlValue(kind, 'copy');
        if (!value || !selectedPipeline) return '';
        const maskedKey = maskStreamKey(selectedPipeline.streamKey);
        let display = value.replace(selectedPipeline.streamKey, maskedKey);
        const passphrase = $dashboardSnapshot.config?.srtPassphrase;
        if (kind === 'srt' && passphrase)
            display = display.replace(encodeURIComponent(passphrase), maskSecret(passphrase));
        return display;
    }

    function copyPublishUrl(kind: 'srt' | 'rtmp', part: string): void {
        const value = publishUrlValue(kind, part);
        if (value !== undefined) void copyText(value);
    }

    function outputClipboardPayload(): unknown[] {
        return (
            selectedPipeline?.outs.map((output) => ({
                name: output.name,
                videoEncoding: output.videoEncoding,
                url: output.url,
                audioEncoding: output.audioEncoding,
                translation: output.translation,
            })) ?? []
        );
    }

    async function copyOutputsNative(): Promise<void> {
        await copyText(JSON.stringify(outputClipboardPayload(), null, 2));
    }

    async function pasteOutputsNative(): Promise<void> {
        if (
            !selectedPipeline ||
            selectedPipeline.outs.some((output) => output.desiredState !== 'stopped')
        )
            return;
        try {
            const parsed: unknown = JSON.parse(await navigator.clipboard.readText());
            if (!Array.isArray(parsed)) throw new Error('Expected a JSON array of outputs.');
            for (const item of parsed) {
                if (!item || typeof item !== 'object')
                    throw new Error('Invalid output format in clipboard.');
                const value = item as Record<string, unknown>;
                if (
                    typeof value.name !== 'string' ||
                    typeof value.url !== 'string' ||
                    typeof value.videoEncoding !== 'string' ||
                    typeof value.audioEncoding !== 'string'
                )
                    throw new Error(
                        'Each output must include name, videoEncoding, url, and audioEncoding.',
                    );
                await createOutput(selectedPipeline.id, {
                    name: value.name,
                    videoEncoding: value.videoEncoding,
                    url: value.url,
                    audioEncoding: value.audioEncoding,
                    translation: value.translation as never,
                });
            }
            await refreshDashboard();
        } catch (error) {
            console.error(error);
        }
    }

    async function startAllNative(): Promise<void> {
        if (!selectedPipeline) return;
        for (const output of selectedPipeline.outs.filter(
            (candidate) => candidate.desiredState === 'stopped',
        ))
            await startOutput(selectedPipeline.id, output.id);
    }

    async function stopAllNative(): Promise<void> {
        if (!selectedPipeline) return;
        for (const output of selectedPipeline.outs.filter(
            (candidate) => candidate.desiredState !== 'stopped',
        ))
            await stopOutput(selectedPipeline.id, output.id);
    }

    function handleHome(): void {
        activeView = 'overview';
        selectedPipelineId = null;
        selectPipelineNative(null);
    }

    function handleHosts(): void {
        activeView = 'hosts';
        selectedPipelineId = null;
        setUrlParam('p', null);
        setUrlParam('view', 'hosts');
        void refreshDashboard();
    }

    function handleLogs(): void {
        activeView = 'logs';
        selectedPipelineId = null;
        setUrlParam('p', null);
        setUrlParam('view', 'logs');
        void refreshDashboard();
    }

    function handleSettings(): void {
        activeView = 'settings';
        selectedPipelineId = null;
        setUrlParam('p', null);
        setUrlParam('view', 'settings');
        void refreshDashboard();
    }

    async function handleLogout(): Promise<void> {
        await logout();
        window.location.href = '/login';
    }

    function handleAddPipeline(): void {
        void createPipeline().then(async (result) => {
            const created = result as { id?: string } | null;
            if (!created?.id) return;
            selectedPipelineId = String(created.id);
            setUrlParam('p', String(created.id));
            setUrlParam('view', null);
            await refreshDashboard();
        });
    }

    function selectPipelineNative(id: string | null): void {
        stopCurrentPreview();
        selectedPipelineId = id;
        setUrlParam('p', id);
        setUrlParam('view', null);
        void refreshDashboard();
    }

    function showProblemsOverview(): void {
        state.overviewFilter = 'problems';
        selectPipelineNative(null);
    }

    async function togglePreviewNative(): Promise<void> {
        if (getPreviewPipelineId()) {
            stopCurrentPreview();
            return;
        }
        if (!selectedPipeline) return;
        setPreviewStarting();
        const result = await (
            await import('./dashboard/core/api.js')
        ).startPreview(selectedPipeline.id, Math.max(1, selectedPipeline.input.audioTracks.length));
        if (result?.hlsUrl) attachHls(selectedPipeline.id, result.hlsUrl);
        else syncPreviewControls(false);
    }

    function openPipelineEditor(): void {
        if (selectedPipeline) pipelineEditorVisible = true;
    }

    function openOutputEditor(
        output: import('./dashboard/types.js').OutputView | null = null,
    ): void {
        if (!selectedPipeline) return;
        outputEditorOutput = output;
        outputEditorVisible = true;
    }

    function openPipelineLogs(): void {
        if (selectedPipeline) logRequest = { kind: 'pipeline', pipelineId: selectedPipeline.id };
    }

    function openOutputLogs(output: import('./dashboard/types.js').OutputView): void {
        if (selectedPipeline) {
            logRequest = { kind: 'output', pipelineId: selectedPipeline.id, outputId: output.id };
        }
    }

    function openRelayLogs(): void {
        if (selectedPipeline) logRequest = { kind: 'relay', pipelineId: selectedPipeline.id };
    }

    async function deleteSelectedPipeline(): Promise<void> {
        if (
            !selectedPipeline ||
            selectedPipeline.outs.some((output) => output.desiredState !== 'stopped')
        )
            return;
        if (!confirm(`Delete pipeline ${selectedPipeline.name} and all its outputs?`)) return;
        const result = await deletePipeline(selectedPipeline.id);
        if (result) {
            selectedPipelineId = null;
            setUrlParam('p', null);
            await refreshDashboard();
        }
    }

    function handleSelectPipeline(id: string | null): void {
        selectPipelineNative(id);
    }

    onMount(() => {
        const polling = startDashboardPolling();
        void polling.ready;
        return polling.stop;
    });
</script>

<Navbar
    serverName={$dashboardSnapshot.serverName}
    metrics={$dashboardSnapshot.metrics}
    saving={$dashboardUi.saving}
    {activeView}
    onHome={handleHome}
    onHosts={handleHosts}
    onLogs={handleLogs}
    onSettings={handleSettings}
    onLogout={handleLogout} />

<!-- Server connection banner -->
<div
    id="connection-banner"
    class="bg-error text-error-content hidden shrink-0 items-center justify-center gap-2 px-4 py-2 text-sm font-semibold">
    <svg
        xmlns="http://www.w3.org/2000/svg"
        class="h-4 w-4 shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        stroke-width="2">
        <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
    </svg>
    Cannot reach server — retrying…
</div>

<!-- SRS down banner -->
<div
    id="srs-banner"
    class="bg-error text-error-content hidden shrink-0 items-center justify-center gap-2 px-4 py-2 text-sm font-semibold">
    <svg
        xmlns="http://www.w3.org/2000/svg"
        class="h-4 w-4 shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        stroke-width="2">
        <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
    </svg>
    SRS media server is unreachable — streaming unavailable
</div>

<!-- SRT bonding relay down banner -->
<div
    id="srt-relay-banner"
    class="bg-error text-error-content hidden shrink-0 items-center justify-center gap-2 px-4 py-2 text-sm font-semibold">
    <svg
        xmlns="http://www.w3.org/2000/svg"
        class="h-4 w-4 shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        stroke-width="2">
        <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
    </svg>
    <span id="srt-relay-banner-text"
        >{$dashboardUi.srtRelay?.lastError && $dashboardUi.srtRelay.status !== 'running'
            ? `SRT bonding relay is not responding: ${$dashboardUi.srtRelay.lastError}`
            : 'SRT bonding relay is not running — bonded SRT input unavailable'}</span>
</div>

<!-- Error banner -->
<div class="fixed left-1/2 z-50 -translate-x-1/2" style="top: 0.5rem; pointer-events: none">
    <div
        role="alert"
        id="error-alert"
        class="alert alert-error max-w-xl opacity-90"
        class:hidden={!$dashboardUi.errorMessage}
        style="pointer-events: auto">
        <svg
            xmlns="http://www.w3.org/2000/svg"
            class="h-5 w-5 shrink-0 stroke-current"
            fill="none"
            viewBox="0 0 24 24">
            <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span id="error-msg">{$dashboardUi.errorMessage ?? ''}</span>
    </div>
</div>

<!-- Copy notification -->
<div
    id="copied-notification"
    role="alert"
    class="alert alert-success fixed bottom-3 left-1/2 z-50 hidden w-fit -translate-x-1/2">
    <span>Copied</span>
</div>

<!-- Main grid -->
<div
    class="grid h-screen min-h-0 flex-1 gap-4 p-4 pt-0"
    style="grid-template-columns: minmax(17rem, 23rem) minmax(500px, 3fr) minmax(24rem, 4fr)">
    <PipelineSidebar
        pipelines={$dashboardSnapshot.pipelines}
        selectedId={selectedPipelineId}
        onAdd={handleAddPipeline}
        onSelect={handleSelectPipeline}
        onProblems={showProblemsOverview} />

    <!-- Middle: Pipeline info -->
    <div
        class="bg-base-200 mt-4 flex flex-col gap-2 overflow-y-auto rounded-xl px-4 pb-4 shadow"
        class:hidden={activeView !== 'overview' || !selectedPipeline}
        id="pipe-info-col">
        <div
            class="bg-base-200 sticky top-0 z-10 -mx-4 flex items-center justify-between gap-3 rounded-t-xl px-4 pt-4 pb-3 text-xl font-bold">
            <div class="flex min-w-0 items-center gap-2">
                <span class="truncate" id="pipe-name">{selectedPipeline?.name ?? ''}</span>
                <span
                    class:hidden={!selectedPipeline?.input.connected}
                    class="badge badge-sm badge-outline shrink-0"
                    id="pipe-readers-badge">
                    {selectedPipeline
                        ? `${selectedPipeline.input.readers} reader${selectedPipeline.input.readers === 1 ? '' : 's'}`
                        : ''}
                </span>
            </div>
            <div class="flex shrink-0 items-center gap-2">
                <button
                    class="btn btn-xs btn-ghost"
                    onclick={(event) => {
                        openPipelineLogs();
                    }}
                    title="View pipeline history">
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
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
                    id="pipe-edit-btn"
                    class="btn btn-xs btn-ghost"
                    onclick={(event) => {
                        openPipelineEditor();
                    }}
                    title="Edit pipeline">
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round">
                        <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                        <path d="m15 5 4 4" />
                    </svg>
                </button>
                <button
                    id="pipe-delete-btn"
                    class="btn btn-xs btn-ghost text-error"
                    class:btn-disabled={selectedPipeline?.outs.some(
                        (output) => output.desiredState !== 'stopped',
                    )}
                    class:opacity-40={selectedPipeline?.outs.some(
                        (output) => output.desiredState !== 'stopped',
                    )}
                    disabled={selectedPipeline?.outs.some(
                        (output) => output.desiredState !== 'stopped',
                    )}
                    onclick={(event) => {
                        void deleteSelectedPipeline();
                    }}
                    title="Delete pipeline">
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round">
                        <path d="M3 6h18" />
                        <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                        <line x1="10" x2="10" y1="11" y2="17" />
                        <line x1="14" x2="14" y1="11" y2="17" />
                    </svg>
                </button>
            </div>
        </div>

        <Preview
            pipeline={selectedPipeline}
            onToggle={togglePreviewNative}
            onTrackChange={previewTrackChange}
            onMute={togglePreviewMute}
            onReload={reloadPreview}
            onMaximize={togglePreviewMaximize} />
        <!-- Input stats -->
        <div
            id="input-stats-container"
            class="border-base-content/10 bg-base-100/50 mb-4 rounded-xl border p-3"
            class:hidden={!selectedPipeline?.input.connected}>
            <div id="input-stats"><InputStats input={selectedPipeline?.input ?? null} /></div>
        </div>

        <SrtBondingPanel
            pipeline={selectedPipeline}
            config={$dashboardSnapshot.config}
            relayRunning={$dashboardUi.srtRelay?.status === 'running'}
            relayPort={$dashboardUi.srtRelay?.port ?? 10081}
            onErrorInfo={openRelayLogs} />
        <!-- Publish URLs -->
        <div class="flex flex-col gap-2">
            <div class="border-base-content/10 bg-base-100/50 order-2 rounded-xl border p-3">
                <div class="mb-1 flex items-center justify-between gap-2">
                    <span class="text-xs font-semibold opacity-60">SRT Publish URL</span>
                    <div class="flex gap-1">
                        <button
                            class="btn btn-xs btn-ghost btn-outline"
                            onclick={(event) => {
                                copyPublishUrl('srt', 'ip');
                            }}>
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2"
                                stroke-linecap="round"
                                stroke-linejoin="round">
                                <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                                <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                            </svg>
                            IP
                        </button>
                        <button
                            class="btn btn-xs btn-ghost btn-outline"
                            onclick={(event) => {
                                copyPublishUrl('srt', 'port');
                            }}>
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2"
                                stroke-linecap="round"
                                stroke-linejoin="round">
                                <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                                <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                            </svg>
                            Port
                        </button>
                        <button
                            class="btn btn-xs btn-ghost btn-outline"
                            onclick={(event) => {
                                copyPublishUrl('srt', 'streamId');
                            }}>
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2"
                                stroke-linecap="round"
                                stroke-linejoin="round">
                                <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                                <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                            </svg>
                            Stream ID
                        </button>
                        <button
                            class="btn btn-xs btn-ghost btn-outline"
                            onclick={(event) => {
                                copyPublishUrl('srt', 'passphrase');
                            }}>
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2"
                                stroke-linecap="round"
                                stroke-linejoin="round">
                                <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                                <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                            </svg>
                            Passphrase
                        </button>
                        <button
                            class="btn btn-xs btn-accent btn-outline"
                            title="Copy SRT passphrase"
                            onclick={(event) => {
                                copyPublishUrl('srt', 'copy');
                            }}>
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2"
                                stroke-linecap="round"
                                stroke-linejoin="round">
                                <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                                <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                            </svg>
                        </button>
                    </div>
                </div>
                <code class="font-mono text-xs break-all opacity-80" id="srt-publish-url"
                    >{displayPublishUrl('srt')}</code>
            </div>
            <div class="border-base-content/10 bg-base-100/50 order-1 rounded-xl border p-3">
                <div class="mb-1 flex items-center justify-between gap-2">
                    <span class="text-xs font-semibold opacity-60">RTMP Publish URL</span>
                    <div class="flex gap-1">
                        <button
                            class="btn btn-xs btn-ghost btn-outline"
                            onclick={(event) => {
                                copyPublishUrl('rtmp', 'server');
                            }}>
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2"
                                stroke-linecap="round"
                                stroke-linejoin="round">
                                <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                                <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                            </svg>
                            Server URL
                        </button>
                        <button
                            class="btn btn-xs btn-ghost btn-outline"
                            onclick={(event) => {
                                copyPublishUrl('rtmp', 'key');
                            }}>
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2"
                                stroke-linecap="round"
                                stroke-linejoin="round">
                                <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                                <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                            </svg>
                            Key
                        </button>
                        <button
                            class="btn btn-xs btn-accent btn-outline"
                            title="Copy stream key"
                            onclick={(event) => {
                                copyPublishUrl('rtmp', 'copy');
                            }}>
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2"
                                stroke-linecap="round"
                                stroke-linejoin="round">
                                <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                                <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                            </svg>
                        </button>
                    </div>
                </div>
                <code class="font-mono text-xs break-all opacity-80" id="rtmp-publish-url"
                    >{displayPublishUrl('rtmp')}</code>
            </div>
        </div>
    </div>

    <!-- Right: Outputs -->
    <div
        class="bg-base-200 mt-4 overflow-y-auto rounded-xl px-4 pb-4 shadow"
        class:hidden={activeView !== 'overview' || !selectedPipeline}
        id="outs-col">
        <div
            class="bg-base-200 sticky top-0 z-10 -mx-4 flex items-center justify-between rounded-t-xl px-4 pt-4 pb-3">
            <div class="flex items-center gap-2">
                <h2 class="text-xl font-bold">Outputs</h2>
                <button
                    class="btn btn-xs btn-square btn-accent"
                    onclick={(event) => {
                        openOutputEditor();
                    }}
                    title="Add Output"
                    aria-label="Add Output">
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
            <div class="flex items-center gap-1">
                <button
                    class="btn btn-xs btn-ghost"
                    onclick={(event) => {
                        void copyOutputsNative();
                    }}
                    title="Copy outputs to clipboard">
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round">
                        <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                        <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                    </svg>
                </button>
                <button
                    id="outputs-paste-btn"
                    class="btn btn-xs btn-ghost"
                    class:btn-disabled={selectedPipeline?.outs.some(
                        (output) => output.desiredState !== 'stopped',
                    )}
                    disabled={selectedPipeline?.outs.some(
                        (output) => output.desiredState !== 'stopped',
                    )}
                    onclick={(event) => {
                        void pasteOutputsNative();
                    }}
                    title="Paste outputs from clipboard">
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round">
                        <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
                        <path
                            d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
                        <path d="M12 11h4" />
                        <path d="M12 16h4" />
                        <path d="M8 11h.01" />
                        <path d="M8 16h.01" />
                    </svg>
                </button>
                <div class="bg-base-content mx-1 h-3 w-px opacity-20"></div>
                <button
                    id="outputs-start-all-btn"
                    class="btn btn-xs btn-ghost"
                    disabled={!selectedPipeline ||
                        selectedPipeline.outs.every((output) => output.desiredState !== 'stopped')}
                    onclick={(event) => {
                        void startAllNative();
                    }}
                    title="Start all outputs">
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round">
                        <polygon points="6 3 20 12 6 21 6 3" />
                    </svg>
                </button>
                <button
                    id="outputs-stop-all-btn"
                    class="btn btn-xs btn-ghost"
                    disabled={!selectedPipeline ||
                        selectedPipeline.outs.every((output) => output.desiredState === 'stopped')}
                    onclick={(event) => {
                        void stopAllNative();
                    }}
                    title="Stop all outputs">
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round">
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                    </svg>
                </button>
            </div>
        </div>
        <OutputList
            pipeline={selectedPipeline}
            allPipelines={$dashboardSnapshot.pipelines}
            onEditOutput={openOutputEditor}
            onOutputError={openOutputLogs} />
    </div>

    <!-- Overview: all pipelines table (spans middle + right columns) -->
    {#if activeView === 'overview' && !selectedPipeline}
        <Overview pipelines={$dashboardSnapshot.pipelines} onSelect={handleSelectPipeline} />
    {/if}
    {#if activeView === 'hosts'}
        <HostConnections
            hostProbes={$dashboardSnapshot.hostProbes}
            configuredTargets={$dashboardSnapshot.config?.hostProbeTargets ?? []} />
    {/if}

    {#if activeView === 'logs'}<SrsLogs />{/if}

    <Settings
        config={$dashboardSnapshot.config}
        pipelineCount={$dashboardSnapshot.pipelines.length}
        visible={activeView === 'settings'} />

    <PipelineEditor
        pipeline={selectedPipeline}
        config={$dashboardSnapshot.config}
        visible={pipelineEditorVisible}
        onClose={() => (pipelineEditorVisible = false)} />

    <OutputEditor
        pipeline={selectedPipeline}
        output={outputEditorOutput}
        config={$dashboardSnapshot.config}
        visible={outputEditorVisible}
        onClose={() => {
            outputEditorVisible = false;
            outputEditorOutput = null;
        }} />

    <LogsModal
        request={logRequest}
        pipelines={$dashboardSnapshot.pipelines}
        visible={logRequest !== null}
        onClose={() => (logRequest = null)} />

    <!-- Shared hover-tooltip popup. Positioned via JS and reparented outside the
         scrollable columns so it isn't clipped by their overflow-y-auto. -->
    <div
        id="hover-tooltip"
        class="bg-neutral text-neutral-content rounded-field fixed z-50 hidden max-w-[40rem] px-2 py-1 text-left shadow-lg"
        style="pointer-events: none">
    </div>
</div>
