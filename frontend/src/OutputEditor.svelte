<script lang="ts">
    import type { ConfigData, OutputView, PipelineView, OutputPayload } from './dashboard/types.js';
    import { createOutput, updateOutput } from './dashboard/core/api.js';
    import { refreshAfterMutation } from './dashboard/features/dashboard.js';
    import {
        buildSrtOutputUrl,
        isSrtHostRequired,
        type SrtOutputSettings,
    } from './dashboard/core/srt.js';

    export let pipeline: PipelineView | null = null;
    export let output: OutputView | null = null;
    export let config: ConfigData | null = null;
    export let visible = false;
    export let onClose: () => void;

    type SrtFields = Omit<SrtOutputSettings, 'port'> & { port: number | null };
    const servers = [
        { label: 'Custom RTMP', prefix: '', keyLabel: 'RTMP URL', placeholder: 'rtmp://...' },
        { label: 'Custom SRT', prefix: '', keyLabel: 'SRT Settings', placeholder: '' },
        {
            label: 'YT RTMP',
            prefix: 'rtmp://a.rtmp.youtube.com/live2/',
            keyLabel: 'Stream Key',
            placeholder: 'xxxx-xxxx-xxxx-xxxx',
        },
        {
            label: 'YT RTMP (Backup)',
            prefix: 'rtmp://b.rtmp.youtube.com/live2?backup=1/',
            keyLabel: 'Stream Key',
            placeholder: 'xxxx-xxxx-xxxx-xxxx',
        },
        {
            label: 'Facebook RTMP',
            prefix: 'rtmps://live-api-s.facebook.com:443/rtmp/',
            keyLabel: 'Stream Key',
            placeholder: 'xxxx-xxxx-xxxx-xxxx',
        },
        {
            label: 'Instagram RTMPS',
            prefix: '',
            keyLabel: 'Stream Key',
            placeholder: '1234567890?s_bl=1&s_prp=xxx-1&...',
        },
        { label: 'Restream RTMP', prefix: '', keyLabel: 'Pipeline', placeholder: '' },
        { label: 'Restream SRT', prefix: '', keyLabel: 'Pipeline', placeholder: '' },
    ];
    const defaultSrt: SrtFields = {
        mode: 'caller',
        host: '',
        port: null,
        latencyMs: null,
        passphrase: '',
        pbKeyLen: null,
        streamId: '',
    };
    const maxTracks = 50;

    let name = '';
    let videoEncoding = 'copy';
    let audioEncoding = 'copy';
    let serverIndex = 0;
    let destinationKey = '';
    let srt: SrtFields = { ...defaultSrt };
    let translation = {
        translatorPipelineId: '',
        translationDelayMs: 800,
        voiceThresholdDb: -20,
        duckVolumePercent: 6,
        duckDurationMs: 900,
        restoreSilenceMs: 2000,
        restoreVolumePercent: 32,
        restoreDurationMs: 1000,
        restoreSilence2Ms: 4000,
        restoreVolume2Percent: 52,
        restoreDuration2Ms: 2000,
    };
    let saving = false;
    let initializedFor: string | null = null;

    $: pipelineTracks = pipeline?.input.audioTracks ?? [];
    $: running = output?.desiredState === 'running';
    $: hasTranslation = audioEncoding === 'translation';
    $: if (visible && pipeline && initializedFor !== `${pipeline.id}:${output?.id ?? 'new'}`) {
        initialize();
        initializedFor = `${pipeline.id}:${output?.id ?? 'new'}`;
    }

    function initialize(): void {
        name = output?.name ?? `Output ${(pipeline?.outs.length ?? 0) + 1}`;
        videoEncoding = output?.videoEncoding ?? config?.encodings?.[0] ?? 'copy';
        audioEncoding = output?.audioEncoding ?? 'copy';
        const detected = detectDestination(output?.url ?? '');
        serverIndex = detected.index;
        destinationKey = detected.key;
        srt = detected.srt;
        if (output?.translation) {
            translation = {
                translatorPipelineId: String(output.translation.translatorPipelineId),
                translationDelayMs: output.translation.translationDelayMs,
                voiceThresholdDb: output.translation.voiceThresholdDb,
                duckVolumePercent: output.translation.duckVolumePercent,
                duckDurationMs: output.translation.duckDurationMs,
                restoreSilenceMs: output.translation.restoreSilenceMs,
                restoreVolumePercent: output.translation.restoreVolumePercent,
                restoreDurationMs: output.translation.restoreDurationMs,
                restoreSilence2Ms: output.translation.restoreSilence2Ms,
                restoreVolume2Percent: output.translation.restoreVolume2Percent,
                restoreDuration2Ms: output.translation.restoreDuration2Ms,
            };
        } else {
            translation = { ...translation, translatorPipelineId: '' };
        }
    }

    function decode(value: string): string {
        try {
            return decodeURIComponent(value.replace(/\+/g, '%20'));
        } catch {
            return value;
        }
    }

    function parseSrt(url: string): SrtFields {
        if (!url.startsWith('srt://')) return { ...defaultSrt };
        try {
            const queryIndex = url.indexOf('?');
            const parsed = new URL(queryIndex < 0 ? url : url.slice(0, queryIndex));
            const params = new Map(
                (queryIndex < 0 ? '' : url.slice(queryIndex + 1))
                    .split('&')
                    .filter(Boolean)
                    .map((part) => {
                        const equal = part.indexOf('=');
                        return [
                            decode(equal < 0 ? part : part.slice(0, equal)),
                            decode(equal < 0 ? '' : part.slice(equal + 1)),
                        ];
                    }),
            );
            const latency = Number(params.get('latency'));
            const port = Number(parsed.port);
            const keyLength = Number(params.get('pbkeylen'));
            return {
                mode: params.get('mode') === 'listener' ? 'listener' : 'caller',
                host: parsed.hostname,
                port: Number.isInteger(port) && port > 0 ? port : null,
                latencyMs:
                    Number.isInteger(latency) && latency > 0 ? Math.round(latency / 1000) : null,
                passphrase: params.get('passphrase') ?? '',
                pbKeyLen:
                    keyLength === 16 || keyLength === 24 || keyLength === 32 ? keyLength : null,
                streamId: params.get('streamid') ?? '',
            };
        } catch {
            return { ...defaultSrt };
        }
    }

    function detectDestination(url: string): { index: number; key: string; srt: SrtFields } {
        const instagram = url.match(
            /^rtmps:\/\/edgetee-upload-[^.]+\.xx\.fbcdn\.net:443\/rtmp\/(.+)$/,
        );
        if (instagram) return { index: 5, key: instagram[1], srt: { ...defaultSrt } };
        for (const [index, server] of servers.entries()) {
            if (server.prefix && url.startsWith(server.prefix))
                return { index, key: url.slice(server.prefix.length), srt: { ...defaultSrt } };
        }
        const restream = (config?.pipelines ?? []).find(
            (candidate) =>
                url === candidate.rtmpPublishUrlLocal || url === candidate.srtPublishUrlLocal,
        );
        if (restream)
            return {
                index: url === restream.srtPublishUrlLocal ? 7 : 6,
                key: String(restream.id),
                srt: { ...defaultSrt },
            };
        if (url.startsWith('srt://')) return { index: 1, key: '', srt: parseSrt(url) };
        return { index: 0, key: url, srt: { ...defaultSrt } };
    }

    function updateServer(index: number): void {
        serverIndex = index;
        destinationKey = '';
        if (index === 1) srt = { ...defaultSrt };
    }

    function audioLabel(index: number): string {
        const track = pipelineTracks.find((candidate) => candidate.index === index);
        return track
            ? `Track ${index + 1}${track.language ? ` (${track.language})` : ''}${track.title ? ` — ${track.title}` : ''} · ${track.codec} ${track.channels}ch`
            : `Track ${index + 1}`;
    }

    function buildInstagramUrl(key: string): string {
        const match = key.match(/[?&]s_prp=([^&]+)/);
        return `rtmps://edgetee-upload-${match?.[1] ?? ''}.xx.fbcdn.net:443/rtmp/${key}`;
    }

    function destinationUrl(): string {
        if (serverIndex === 1)
            return buildSrtOutputUrl({
                ...srt,
                port: Number(srt.port),
                latencyMs: srt.latencyMs == null ? null : Number(srt.latencyMs),
                pbKeyLen: srt.pbKeyLen == null ? null : (Number(srt.pbKeyLen) as 16 | 24 | 32),
            } as SrtOutputSettings);
        if (serverIndex === 5) return buildInstagramUrl(destinationKey.trim());
        if (serverIndex === 6 || serverIndex === 7) {
            const target = (config?.pipelines ?? []).find(
                (candidate) => String(candidate.id) === destinationKey,
            );
            return serverIndex === 6
                ? (target?.rtmpPublishUrlLocal ?? '')
                : (target?.srtPublishUrlLocal ?? '');
        }
        return servers[serverIndex].prefix + destinationKey.trim();
    }

    function validDestination(): boolean {
        if (serverIndex === 1) {
            const hostValid = !isSrtHostRequired(srt.mode) || !!srt.host.trim();
            const port = srt.port ?? 0;
            const portValid = Number.isInteger(port) && port >= 1 && port <= 65535;
            const passphraseValid =
                !srt.passphrase || (srt.passphrase.length >= 10 && srt.passphrase.length <= 79);
            return (
                hostValid &&
                portValid &&
                (srt.latencyMs == null ||
                    (Number.isInteger(Number(srt.latencyMs)) && Number(srt.latencyMs) > 0)) &&
                passphraseValid &&
                (!srt.passphrase || srt.pbKeyLen !== null)
            );
        }
        return !!destinationKey.trim() && !!destinationUrl();
    }

    async function save(): Promise<void> {
        if (
            !pipeline ||
            !name.trim() ||
            !validDestination() ||
            (hasTranslation &&
                (!translation.translatorPipelineId ||
                    translation.restoreSilence2Ms < translation.restoreSilenceMs))
        )
            return;
        const payload: OutputPayload = {
            name: name.trim(),
            videoEncoding,
            url: destinationUrl(),
            audioEncoding,
            translation:
                hasTranslation && translation.translatorPipelineId
                    ? {
                          translatorPipelineId: Number(translation.translatorPipelineId),
                          translationDelayMs: translation.translationDelayMs,
                          voiceThresholdDb: translation.voiceThresholdDb,
                          duckVolumePercent: translation.duckVolumePercent,
                          duckDurationMs: translation.duckDurationMs,
                          restoreSilenceMs: translation.restoreSilenceMs,
                          restoreVolumePercent: translation.restoreVolumePercent,
                          restoreDurationMs: translation.restoreDurationMs,
                          restoreSilence2Ms: translation.restoreSilence2Ms,
                          restoreVolume2Percent: translation.restoreVolume2Percent,
                          restoreDuration2Ms: translation.restoreDuration2Ms,
                      }
                    : null,
        };
        saving = true;
        try {
            const result = output
                ? await updateOutput(pipeline.id, output.id, payload)
                : await createOutput(pipeline.id, payload);
            if (result) {
                initializedFor = null;
                onClose();
                await refreshAfterMutation();
            }
        } finally {
            saving = false;
        }
    }

    async function copyOutput(): Promise<void> {
        await navigator.clipboard.writeText(
            JSON.stringify(
                {
                    name,
                    videoEncoding,
                    url: destinationUrl(),
                    audioEncoding,
                    translation: hasTranslation ? translation : null,
                },
                null,
                2,
            ),
        );
    }

    async function pasteOutput(): Promise<void> {
        try {
            const parsed: unknown = JSON.parse(await navigator.clipboard.readText());
            if (!parsed || typeof parsed !== 'object')
                throw new Error('Invalid output format in clipboard.');
            const value = parsed as Record<string, unknown>;
            if (
                typeof value.name !== 'string' ||
                typeof value.videoEncoding !== 'string' ||
                typeof value.url !== 'string' ||
                typeof value.audioEncoding !== 'string'
            )
                throw new Error('Output clipboard data is incomplete.');
            name = value.name;
            videoEncoding = value.videoEncoding;
            audioEncoding = value.audioEncoding;
            const detected = detectDestination(value.url);
            serverIndex = detected.index;
            destinationKey = detected.key;
            srt = detected.srt;
        } catch (error) {
            console.error(error);
        }
    }
</script>

{#if visible && pipeline}
    <dialog class="modal" open>
        <div class="modal-box w-[92vw] max-w-3xl">
            <div class="mx-auto mt-2 space-y-3 px-4">
                <div class="flex items-center gap-1">
                    <h2 class="text-xl font-bold">{output ? 'Edit Output' : 'Add Output'}</h2>
                    <button
                        class="btn btn-xs btn-ghost"
                        type="button"
                        title="Copy output"
                        onclick={() => void copyOutput()}>⧉</button
                    ><button
                        class="btn btn-xs btn-ghost"
                        type="button"
                        title="Paste output"
                        onclick={() => void pasteOutput()}>▣</button>
                </div>
                <div class="flex flex-wrap items-end gap-3">
                    <fieldset class="fieldset flex-1">
                        <legend class="fieldset-legend">Output Name</legend><input
                            class="input w-full"
                            bind:value={name}
                            placeholder="YouTube" />
                    </fieldset>
                    <fieldset class="fieldset">
                        <legend class="fieldset-legend">Video Encoding</legend><select
                            class="select w-40"
                            bind:value={videoEncoding}
                            >{#each config?.encodings ?? ['copy', '720p', '1080p'] as encoding}<option
                                    value={encoding}>{encoding}</option
                                >{/each}</select>
                    </fieldset>
                    <fieldset class="fieldset">
                        <legend class="fieldset-legend">Audio Encoding</legend><select
                            class="select w-40"
                            bind:value={audioEncoding}
                            >{#each ['copy', 'translation', ...Array.from( { length: maxTracks }, (_, index) => String(index), )] as encoding, index}<option
                                    value={encoding}
                                    >{encoding === 'copy' || encoding === 'translation'
                                        ? encoding
                                        : audioLabel(Number(encoding))}</option
                                >{/each}</select>
                    </fieldset>
                </div>
                {#if hasTranslation}
                    <div class="rounded-box flex flex-wrap items-end gap-2 bg-base-200 px-2 py-2">
                        <fieldset class="fieldset min-w-56 flex-1">
                            <legend class="fieldset-legend">Translator Pipeline</legend><select
                                class="select select-sm w-full"
                                bind:value={translation.translatorPipelineId}
                                ><option value="">Select translator pipeline</option
                                >{#each (config?.pipelines ?? []).filter((candidate) => candidate.id !== pipeline?.id) as candidate}<option
                                        value={candidate.id}>{candidate.name}</option
                                    >{/each}</select>
                        </fieldset>
                        <fieldset class="fieldset min-w-40 flex-1">
                            <legend class="fieldset-legend">Translation Delay (ms)</legend><input
                                class="input input-sm w-full"
                                type="number"
                                bind:value={translation.translationDelayMs} />
                        </fieldset>
                        <fieldset class="fieldset min-w-40 flex-1">
                            <legend class="fieldset-legend">Voice Threshold (dB)</legend><input
                                class="input input-sm w-full"
                                type="number"
                                bind:value={translation.voiceThresholdDb} />
                        </fieldset>
                        <fieldset class="fieldset min-w-40 flex-1">
                            <legend class="fieldset-legend">Source While Speaking (%)</legend><input
                                class="input input-sm w-full"
                                type="number"
                                bind:value={translation.duckVolumePercent} />
                        </fieldset>
                        <fieldset class="fieldset min-w-40 flex-1">
                            <legend class="fieldset-legend">Duck Fade (ms)</legend><input
                                class="input input-sm w-full"
                                type="number"
                                bind:value={translation.duckDurationMs} />
                        </fieldset>
                        <fieldset class="fieldset min-w-40 flex-1">
                            <legend class="fieldset-legend">Restore 1 After (ms)</legend><input
                                class="input input-sm w-full"
                                type="number"
                                bind:value={translation.restoreSilenceMs} />
                        </fieldset>
                        <fieldset class="fieldset min-w-40 flex-1">
                            <legend class="fieldset-legend">Restore 1 Volume (%)</legend><input
                                class="input input-sm w-full"
                                type="number"
                                bind:value={translation.restoreVolumePercent} />
                        </fieldset>
                        <fieldset class="fieldset min-w-40 flex-1">
                            <legend class="fieldset-legend">Restore 1 Fade (ms)</legend><input
                                class="input input-sm w-full"
                                type="number"
                                bind:value={translation.restoreDurationMs} />
                        </fieldset>
                        <fieldset class="fieldset min-w-40 flex-1">
                            <legend class="fieldset-legend">Restore 2 After (ms)</legend><input
                                class="input input-sm w-full"
                                type="number"
                                bind:value={translation.restoreSilence2Ms} />
                        </fieldset>
                        <fieldset class="fieldset min-w-40 flex-1">
                            <legend class="fieldset-legend">Restore 2 Volume (%)</legend><input
                                class="input input-sm w-full"
                                type="number"
                                bind:value={translation.restoreVolume2Percent} />
                        </fieldset>
                        <fieldset class="fieldset min-w-40 flex-1">
                            <legend class="fieldset-legend">Restore 2 Fade (ms)</legend><input
                                class="input input-sm w-full"
                                type="number"
                                bind:value={translation.restoreDuration2Ms} />
                        </fieldset>
                    </div>
                {/if}
                <div class="flex flex-wrap items-end gap-2 rounded-box bg-base-200 px-2 py-2">
                    <fieldset class="fieldset">
                        <legend class="fieldset-legend">Server</legend><select
                            class="select select-sm w-40"
                            bind:value={serverIndex}
                            onchange={(event) =>
                                updateServer(
                                    Number((event.currentTarget as HTMLSelectElement).value),
                                )}
                            >{#each servers as server, index}<option value={index}
                                    >{server.label}</option
                                >{/each}</select>
                    </fieldset>
                    {#if serverIndex === 1}
                        <fieldset class="fieldset">
                            <legend class="fieldset-legend">Type</legend><select
                                class="select select-sm w-28"
                                bind:value={srt.mode}
                                ><option value="caller">Caller</option><option value="listener"
                                    >Listener</option
                                ></select>
                        </fieldset>
                        {#if srt.mode === 'caller'}<fieldset class="fieldset">
                                <legend class="fieldset-legend">Hostname</legend><input
                                    class="input input-sm w-40 font-mono text-xs"
                                    bind:value={srt.host} />
                            </fieldset>{/if}
                        <fieldset class="fieldset">
                            <legend class="fieldset-legend">Port</legend><input
                                class="input input-sm w-20"
                                type="number"
                                bind:value={srt.port} />
                        </fieldset>
                        <fieldset class="fieldset">
                            <legend class="fieldset-legend">Latency (ms)</legend><input
                                class="input input-sm w-28"
                                type="number"
                                bind:value={srt.latencyMs} />
                        </fieldset>
                        <fieldset class="fieldset">
                            <legend class="fieldset-legend">Passphrase</legend><input
                                class="input input-sm w-56 font-mono text-xs"
                                bind:value={srt.passphrase} />
                        </fieldset>
                        <fieldset class="fieldset">
                            <legend class="fieldset-legend">Key Length</legend><select
                                class="select select-sm w-24"
                                bind:value={srt.pbKeyLen}
                                ><option value={null}>—</option><option value={16}>16</option
                                ><option value={24}>24</option><option value={32}>32</option
                                ></select>
                        </fieldset>
                        <fieldset class="fieldset">
                            <legend class="fieldset-legend">Stream ID</legend><input
                                class="input input-sm w-80 font-mono text-xs"
                                bind:value={srt.streamId} />
                        </fieldset>
                    {:else if serverIndex === 6 || serverIndex === 7}
                        <fieldset class="fieldset flex-1">
                            <legend class="fieldset-legend">Pipeline</legend><select
                                class="select select-sm w-full"
                                bind:value={destinationKey}
                                ><option value="">Pipeline</option
                                >{#each (config?.pipelines ?? []).filter((candidate) => candidate.id !== pipeline.id) as candidate}<option
                                        value={candidate.id}>{candidate.name}</option
                                    >{/each}</select>
                        </fieldset>
                    {:else}
                        <fieldset class="fieldset flex-1">
                            <legend class="fieldset-legend">{servers[serverIndex].keyLabel}</legend
                            ><input
                                class="input input-sm w-full font-mono text-xs"
                                bind:value={destinationKey}
                                placeholder={servers[serverIndex].placeholder} />
                        </fieldset>
                    {/if}
                </div>
            </div>
            <div class="modal-action">
                <button
                    class="btn"
                    type="button"
                    onclick={() => {
                        initializedFor = null;
                        onClose();
                    }}>Cancel</button
                ><button
                    class="btn btn-accent"
                    type="button"
                    disabled={saving || running}
                    onclick={() => void save()}>Save</button>
            </div>
            {#if running}<p class="px-4 text-right text-xs text-warning">
                    Stop the output before editing.
                </p>{/if}
        </div>
    </dialog>
{/if}
