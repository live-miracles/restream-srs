<script lang="ts">
    import { onMount } from 'svelte';
    import * as api from './dashboard/core/api.js';
    import { refreshAfterMutation } from './dashboard/features/dashboard.js';
    import type { ConfigData, HostProbeTarget } from './dashboard/types.js';

    type VersionInfo = {
        app: string;
        commit: string;
        srs: string;
        srtRelay: string;
        ffmpeg: string;
        node: string;
        os: string;
        kernel: string;
    };

    export let config: ConfigData | null = null;
    export let pipelineCount = 0;
    export let visible = false;

    let serverName = '';
    let publicHost = '';
    let currentPassword = '';
    let newPassword = '';
    let confirmPassword = '';
    let probes: HostProbeTarget[] = [];
    let version: VersionInfo | null = null;
    let loadedRev: number | null = null;
    let generalSaved = false;
    let passwordSaved = false;
    let probesSaved = false;
    let showCurrentPassword = false;
    let showNewPassword = false;
    let showConfirmPassword = false;

    $: if (config && config.configRev !== loadedRev) {
        loadedRev = config.configRev;
        serverName = config.serverName;
        publicHost = config.publicHost;
        probes = config.hostProbeTargets.length
            ? config.hostProbeTargets.map((probe) => ({ ...probe }))
            : [{ slot: 1, label: '', host: '', port: 1935 }];
    }

    onMount(async () => {
        version = await api.getVersion();
    });

    function flash(kind: 'general' | 'password' | 'probes'): void {
        if (kind === 'general') generalSaved = true;
        if (kind === 'password') passwordSaved = true;
        if (kind === 'probes') probesSaved = true;
        setTimeout(() => {
            if (kind === 'general') generalSaved = false;
            if (kind === 'password') passwordSaved = false;
            if (kind === 'probes') probesSaved = false;
        }, 1500);
    }

    async function saveGeneral(): Promise<void> {
        const name = serverName.trim();
        if (!name) return;
        if (await api.updateGeneralSettings(name, publicHost.trim())) {
            await refreshAfterMutation();
            flash('general');
        }
    }

    async function savePassword(): Promise<void> {
        if (!currentPassword || !newPassword || newPassword !== confirmPassword) return;
        if (await api.changePassword(currentPassword, newPassword)) {
            currentPassword = '';
            newPassword = '';
            confirmPassword = '';
            flash('password');
        }
    }

    async function saveProbes(): Promise<void> {
        const normalized = probes
            .filter((probe) => probe.label.trim() || probe.host.trim())
            .map((probe) => ({
                ...probe,
                label: probe.label.trim(),
                host: probe.host.trim(),
                port: Number(probe.port) || 1935,
            }));
        if (
            normalized.some(
                (probe) => !probe.label || !probe.host || probe.port < 1 || probe.port > 65535,
            )
        )
            return;
        if (await api.updateHostProbes(normalized)) {
            await refreshAfterMutation();
            flash('probes');
        }
    }

    function addProbe(): void {
        const used = new Set(probes.map((probe) => probe.slot));
        for (let slot = 1; slot <= 10; slot++) {
            if (!used.has(slot)) {
                probes = [...probes, { slot, label: '', host: '', port: 1935 }];
                return;
            }
        }
    }

    function removeProbe(slot: number): void {
        probes = probes.filter((probe) => probe.slot !== slot);
    }

    async function regenerate(): Promise<void> {
        if (
            !confirm(
                'Regenerate all stream keys? All existing stream key values will be replaced with new ones.',
            )
        )
            return;
        if (await api.regenerateStreamKeys()) await refreshAfterMutation();
    }
</script>

<div
    class="bg-base-200 col-span-2 mt-4 overflow-y-auto rounded-xl p-4 shadow"
    id="settings-col"
    class:hidden={!visible}>
    <div class="mx-auto max-w-4xl space-y-3">
        <h2 class="text-xl font-bold">Settings</h2>

        <!-- Version info -->
        <div
            id="settings-version"
            class="bg-base-300 grid grid-cols-[5rem_1fr] gap-x-3 gap-y-0.5 rounded-lg px-3 py-2 font-mono text-xs opacity-70">
            <span class="opacity-60">Commit</span><span id="v-commit"
                >{version?.commit ?? '—'}</span> <span class="opacity-60">Restream</span><span
                id="v-app">{version ? 'v' + version.app : '—'}</span>
            <span class="opacity-60">SRS</span><span id="v-srs">{version?.srs ?? '—'}</span>
            <span class="opacity-60">Relay</span><span id="v-relay"
                >{version?.srtRelay ?? '—'}</span>
            <span class="opacity-60">FFmpeg</span><span id="v-ffmpeg"
                >{version?.ffmpeg ?? '—'}</span> <span class="opacity-60">Node</span><span
                id="v-node">{version?.node ?? '—'}</span>
            <span class="opacity-60">OS</span><span id="v-os">{version?.os ?? '—'}</span>
            <span class="opacity-60">Kernel</span><span id="v-kernel"
                >{version?.kernel ?? '—'}</span>
        </div>

        <!-- Server Name + Public Host -->
        <div class="space-y-2">
            <div class="flex gap-3">
                <fieldset class="fieldset min-w-0 flex-1">
                    <legend class="fieldset-legend">Server Name</legend>
                    <input
                        type="text"
                        id="settings-server-name-input"
                        class="input w-full"
                        placeholder="Restream SRS"
                        bind:value={serverName} />
                </fieldset>
                <fieldset class="fieldset min-w-0 flex-1">
                    <legend class="fieldset-legend">Public Host</legend>
                    <input
                        type="text"
                        id="settings-public-host-input"
                        class="input w-full font-mono text-sm"
                        placeholder="localhost"
                        bind:value={publicHost} />
                </fieldset>
            </div>
            <div class="flex items-center justify-end gap-2">
                <span
                    id="settings-general-save-success"
                    class="text-success"
                    class:hidden={!generalSaved}
                    aria-hidden="true">
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="3"
                        stroke-linecap="round"
                        stroke-linejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                    </svg>
                </span>
                <button
                    type="button"
                    class="btn btn-sm btn-accent"
                    onclick={() => void saveGeneral()}>Save</button>
            </div>
        </div>

        <!-- Change Password -->
        <div class="space-y-2">
            <div class="flex gap-3">
                <fieldset class="fieldset min-w-0 flex-1">
                    <legend class="fieldset-legend">Current Password</legend>
                    <div class="relative">
                        <input
                            type={showCurrentPassword ? 'text' : 'password'}
                            id="current-password-input"
                            bind:value={currentPassword}
                            class="input w-full pr-10"
                            placeholder="Current"
                            autocomplete="current-password" />
                        <button
                            type="button"
                            class="absolute top-1/2 right-2 -translate-y-1/2 opacity-50 hover:opacity-100"
                            onclick={() => (showCurrentPassword = !showCurrentPassword)}
                            tabindex="-1"
                            aria-label="Toggle password visibility">
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                width="18"
                                height="18"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2"
                                stroke-linecap="round"
                                stroke-linejoin="round">
                                <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                                <circle cx="12" cy="12" r="3" />
                            </svg>
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                width="18"
                                height="18"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                class:hidden={!showCurrentPassword}>
                                <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                                <path
                                    d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
                                <path
                                    d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                                <line x1="2" x2="22" y1="2" y2="22" />
                            </svg>
                        </button>
                    </div>
                </fieldset>
                <fieldset class="fieldset min-w-0 flex-1">
                    <legend class="fieldset-legend">New Password</legend>
                    <div class="relative">
                        <input
                            type={showNewPassword ? 'text' : 'password'}
                            id="new-password-input"
                            bind:value={newPassword}
                            class="input w-full pr-10"
                            placeholder="New"
                            autocomplete="new-password"
                            oninput={(event) => {
                                document
                                    .getElementById('confirm-password-input')
                                    ?.classList.remove('input-error');
                            }} />
                        <button
                            type="button"
                            class="absolute top-1/2 right-2 -translate-y-1/2 opacity-50 hover:opacity-100"
                            onclick={() => (showNewPassword = !showNewPassword)}
                            tabindex="-1"
                            aria-label="Toggle password visibility">
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                width="18"
                                height="18"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2"
                                stroke-linecap="round"
                                stroke-linejoin="round">
                                <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                                <circle cx="12" cy="12" r="3" />
                            </svg>
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                width="18"
                                height="18"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                class:hidden={!showNewPassword}>
                                <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                                <path
                                    d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
                                <path
                                    d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                                <line x1="2" x2="22" y1="2" y2="22" />
                            </svg>
                        </button>
                    </div>
                </fieldset>
                <fieldset class="fieldset min-w-0 flex-1">
                    <legend class="fieldset-legend">Confirm</legend>
                    <div class="relative">
                        <input
                            type={showConfirmPassword ? 'text' : 'password'}
                            id="confirm-password-input"
                            bind:value={confirmPassword}
                            class="input w-full pr-10"
                            placeholder="Confirm"
                            autocomplete="new-password"
                            oninput={(event) => {
                                (event.currentTarget as HTMLElement).classList.remove(
                                    'input-error',
                                );
                            }} />
                        <button
                            type="button"
                            class="absolute top-1/2 right-2 -translate-y-1/2 opacity-50 hover:opacity-100"
                            onclick={() => (showConfirmPassword = !showConfirmPassword)}
                            tabindex="-1"
                            aria-label="Toggle password visibility">
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                width="18"
                                height="18"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2"
                                stroke-linecap="round"
                                stroke-linejoin="round">
                                <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                                <circle cx="12" cy="12" r="3" />
                            </svg>
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                width="18"
                                height="18"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                class:hidden={!showConfirmPassword}>
                                <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                                <path
                                    d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
                                <path
                                    d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                                <line x1="2" x2="22" y1="2" y2="22" />
                            </svg>
                        </button>
                    </div>
                </fieldset>
            </div>
            <div class="flex items-center justify-between gap-3">
                <p class="text-xs opacity-70">
                    Leave password fields blank to keep current password.
                </p>
                <div class="flex shrink-0 items-center gap-2">
                    <span
                        id="settings-password-save-success"
                        class="text-success"
                        class:hidden={!passwordSaved}
                        aria-hidden="true">
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="3"
                            stroke-linecap="round"
                            stroke-linejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                        </svg>
                    </span>
                    <button
                        type="button"
                        class="btn btn-sm btn-accent"
                        onclick={() => void savePassword()}>Save</button>
                </div>
            </div>
        </div>

        <!-- Regenerate Stream Keys -->
        <div class="flex items-center justify-between gap-3">
            <div>
                <p class="text-sm font-medium">Stream Keys</p>
                <p
                    id="regen-stream-keys-hint"
                    class="text-xs opacity-70"
                    class:hidden={pipelineCount === 0}>
                    Remove all pipelines before regenerating.
                </p>
            </div>
            <button
                id="regen-stream-keys-btn"
                type="button"
                disabled={pipelineCount > 0}
                class="btn btn-sm btn-warning shrink-0"
                onclick={() => void regenerate()}>
                Regenerate All
            </button>
        </div>

        <div class="space-y-2">
            <div class="flex items-center justify-between pt-1">
                <span class="fieldset-legend">Host Connectivity Probes</span>
                <button
                    id="settings-add-host-probe-btn"
                    type="button"
                    class="btn btn-xs btn-ghost"
                    onclick={addProbe}>+ Add host</button>
            </div>
            <div class="border-base-content/10 overflow-x-auto rounded-lg border">
                <table class="table-sm table">
                    <thead>
                        <tr>
                            <th>Label</th>
                            <th>Domain / IP</th>
                            <th class="w-28">Port</th>
                            <th class="w-16"></th>
                        </tr>
                    </thead>
                    <tbody id="settings-host-probe-rows">
                        {#each probes as probe (probe.slot)}
                            <tr data-host-probe-row={probe.slot}>
                                <td
                                    ><input
                                        type="text"
                                        class="input input-sm w-full"
                                        bind:value={probe.label} /></td>
                                <td
                                    ><input
                                        type="text"
                                        class="input input-sm w-full font-mono text-sm"
                                        bind:value={probe.host} /></td>
                                <td
                                    ><input
                                        type="number"
                                        min="1"
                                        max="65535"
                                        class="input input-sm w-full font-mono text-sm"
                                        bind:value={probe.port} /></td>
                                <td class="text-right">
                                    <button
                                        type="button"
                                        class="btn btn-xs btn-error btn-outline"
                                        onclick={() => removeProbe(probe.slot)}
                                        aria-label="Remove host probe"
                                        title="Remove host probe">
                                        <svg
                                            xmlns="http://www.w3.org/2000/svg"
                                            width="14"
                                            height="14"
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="currentColor"
                                            stroke-width="2"
                                            ><path d="M3 6h18" /><path
                                                d="M19 6v14c0 1-2 2-2 2H7c-1 0-2-2-2-2V6" /><path
                                                d="M8 6V4c0-1 2-2 2-2h4c1 0 2 1 2 2v2" /><line
                                                x1="10"
                                                x2="10"
                                                y1="11"
                                                y2="17" /><line
                                                x1="14"
                                                x2="14"
                                                y1="11"
                                                y2="17" /></svg>
                                    </button>
                                </td>
                            </tr>
                        {/each}
                    </tbody>
                </table>
            </div>
            <div class="flex items-center justify-end gap-2">
                <span
                    id="settings-host-probes-save-success"
                    class="text-success"
                    class:hidden={!probesSaved}
                    aria-hidden="true">
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="3"
                        stroke-linecap="round"
                        stroke-linejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                    </svg>
                </span>
                <button
                    type="button"
                    class="btn btn-sm btn-accent"
                    onclick={() => void saveProbes()}>Save</button>
            </div>
        </div>
    </div>
</div>
