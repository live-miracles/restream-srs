<script lang="ts">
    import type { InputHealth } from './dashboard/types.js';
    import { displayInputBitrateKbps, fmtFieldOrder } from './dashboard/features/render.js';
    import { formatBitrate } from './dashboard/core/utils.js';

    export let input: InputHealth | null = null;

    function mediaProbeStatus(current: InputHealth): string | null {
        if (current.mediaCheckedAt)
            return `checked ${new Date(current.mediaCheckedAt).toLocaleTimeString(undefined, { hour12: false })}`;
        if (current.mediaProbeStartedAt)
            return `ffprobe started ${new Date(current.mediaProbeStartedAt).toLocaleTimeString(undefined, { hour12: false })}`;
        if (current.connected && !current.live) return 'ffprobe not run yet';
        return null;
    }

    function probeMessage(current: InputHealth): string {
        if (current.mediaError) return current.mediaError;
        if (current.mediaOk === null)
            return 'Waiting for ffprobe to finish and return the input encoding.';
        return 'Input connected, waiting for valid media.';
    }

    function compactValue(value: string | number | null | undefined): string {
        return value == null || value === '' ? '—' : String(value);
    }
</script>

{#if input?.connected}
    {#if !input.live || input.mediaError || input.mediaOk === null}
        <p
            class="mt-2 text-xs"
            class:text-error={!!input.mediaError}
            class:text-warning={!input.mediaError && !input.live}>
            {probeMessage(input)}
            {#if mediaProbeStatus(input)}<span class="opacity-60">
                    {mediaProbeStatus(input)}</span
                >{/if}
        </p>
    {:else}
        {#if input.video}
            <div class="input-meta-row input-meta-row-sm my-0.5">
                <span class="input-meta-item"
                    ><span class="input-meta-label">IP</span><span class="input-meta-value"
                        >{compactValue(input.publisherIp)}</span
                    ></span>
                <span class="input-meta-item"
                    ><span class="input-meta-label">In</span><span class="input-meta-value"
                        >{formatBitrate(displayInputBitrateKbps(input))}</span
                    ></span>
                <span class="input-meta-item"
                    ><span class="input-meta-label">Codec</span><span class="input-meta-value"
                        >{compactValue(input.video.codec)}</span
                    ></span>
                <span class="input-meta-item"
                    ><span class="input-meta-label">Size</span><span class="input-meta-value"
                        >{input.video.width && input.video.height
                            ? `${input.video.width}×${input.video.height}`
                            : '—'}</span
                    ></span>
                <span class="input-meta-item"
                    ><span class="input-meta-label">FPS</span><span class="input-meta-value"
                        >{compactValue(input.video.fps)}</span
                    ></span>
                <span class="input-meta-item"
                    ><span class="input-meta-label">Scan</span><span class="input-meta-value"
                        >{compactValue(fmtFieldOrder(input.video.fieldOrder))}</span
                    ></span>
                <span class="input-meta-item"
                    ><span class="input-meta-label">Prof</span><span class="input-meta-value"
                        >{compactValue(input.video.profile)}</span
                    ></span>
                <span class="input-meta-item"
                    ><span class="input-meta-label">Lvl</span><span class="input-meta-value"
                        >{compactValue(input.video.level)}</span
                    ></span>
            </div>
        {:else}
            <p class="mt-2 text-xs opacity-50">Input media information is unavailable.</p>
        {/if}

        {#if input.audioTracks.length > 0}
            <h3 class="mt-3 text-sm font-semibold opacity-60">
                Audio <span class="font-normal"
                    >({input.audioTracks.length} track{input.audioTracks.length > 1
                        ? 's'
                        : ''})</span>
            </h3>
            {@const hasPid = input.audioTracks.some((track) => track.pid != null)}
            {@const hasLabel = input.audioTracks.some((track) => track.language || track.title)}
            <table class="table table-xs mt-1">
                <thead
                    ><tr
                        ><th>#</th>{#if hasPid}<th>PID</th>{/if}<th>Codec</th><th>Profile</th><th
                            >Ch</th
                        ><th>Freq</th>{#if hasLabel}<th>Label</th>{/if}</tr
                    ></thead>
                <tbody>
                    {#each input.audioTracks as track}
                        <tr>
                            <td class="font-mono">{track.index + 1}</td>
                            {#if hasPid}<td class="font-mono">{track.pid ?? '—'}</td>{/if}
                            <td>{track.codec || '—'}</td>
                            <td>{track.profile || '—'}</td>
                            <td>{track.channels || '—'}</td>
                            <td
                                >{track.sampleRate
                                    ? `${(track.sampleRate / 1000).toFixed(1)} kHz`
                                    : '—'}</td>
                            {#if hasLabel}<td class="opacity-60"
                                    >{[track.language, track.title].filter(Boolean).join(' — ')}</td
                                >{/if}
                        </tr>
                    {/each}
                </tbody>
            </table>
        {:else if input.audio}
            <h3 class="mt-3 text-sm font-semibold opacity-60">Audio</h3>
            <div class="input-meta-row mt-1">
                <span class="input-meta-item"
                    ><span class="input-meta-label">Codec</span><span class="input-meta-value"
                        >{compactValue(input.audio.codec)}</span
                    ></span>
                <span class="input-meta-item"
                    ><span class="input-meta-label">Profile</span><span class="input-meta-value"
                        >{compactValue(input.audio.profile)}</span
                    ></span>
                <span class="input-meta-item"
                    ><span class="input-meta-label">Sample Rate</span><span class="input-meta-value"
                        >{input.audio.sample_rate
                            ? `${(input.audio.sample_rate / 1000).toFixed(1)} kHz`
                            : '—'}</span
                    ></span>
                <span class="input-meta-item"
                    ><span class="input-meta-label">Channels</span><span class="input-meta-value"
                        >{compactValue(input.audio.channel)}</span
                    ></span>
            </div>
        {/if}
    {/if}
{/if}
