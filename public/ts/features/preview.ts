import type { PipelineView } from '../types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const Hls: any;

let previewPipelineId: string | null = null;
let hlsInstance: { destroy(): void } | null = null;

function teardownHls(): void {
    if (hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
    }
    const video = document.getElementById('preview-video') as HTMLVideoElement | null;
    if (video) {
        video.pause();
        video.removeAttribute('src');
        video.load();
        video.classList.add('hidden');
    }
    document.getElementById('preview-play-btn')?.classList.remove('hidden');
    document.getElementById('preview-stop-btn')?.classList.add('hidden');
}

export function stopCurrentPreview(): void {
    const pid = previewPipelineId;
    if (!pid) return;
    previewPipelineId = null;
    teardownHls();
    void import('../core/api.js').then(({ stopPreview }) => stopPreview(pid));
}

export function attachHls(pipelineId: string, hlsUrl: string): void {
    previewPipelineId = pipelineId;
    const video = document.getElementById('preview-video') as HTMLVideoElement | null;
    if (!video) return;
    video.classList.remove('hidden');
    document.getElementById('preview-play-btn')?.classList.add('hidden');
    document.getElementById('preview-stop-btn')?.classList.remove('hidden');

    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
        const hls = new Hls({
            liveSyncDurationCount: 5,
            fragLoadingMaxRetry: 10,
            fragLoadingRetryDelay: 500,
            manifestLoadingMaxRetry: 6,
            manifestLoadingRetryDelay: 500,
        }) as {
            destroy(): void;
            loadSource(u: string): void;
            attachMedia(v: HTMLVideoElement): void;
            on(e: string, cb: (...args: unknown[]) => void): void;
            Events: { MANIFEST_PARSED: string; ERROR: string };
        };
        hls.loadSource(hlsUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED as string, () => void video.play());
        hls.on(Hls.Events.ERROR as string, (...args: unknown[]) => {
            const data = args[1] as { fatal?: boolean };
            if (data?.fatal) setTimeout(() => stopCurrentPreview(), 0);
        });
        hlsInstance = hls;
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = hlsUrl;
        void video.play();
    }
}

export function selectedPreviewTrack(): number | null {
    const sel = document.getElementById('preview-audio-select') as HTMLSelectElement | null;
    if (!sel || sel.value === '') return null;
    const n = parseInt(sel.value);
    return Number.isNaN(n) ? null : n;
}

// Restart the running preview with the newly selected audio track. No-op while
// the preview is stopped — the choice is applied when the user hits Play.
export function previewTrackChange(): void {
    const pid = previewPipelineId;
    if (!pid) return;
    const track = selectedPreviewTrack();
    void (async () => {
        const { stopPreview, startPreview } = await import('../core/api.js');
        teardownHls();
        await stopPreview(pid);
        const result = await startPreview(pid, track);
        if (result?.hlsUrl) attachHls(pid, result.hlsUrl);
    })();
}

export function getPreviewPipelineId(): string | null {
    return previewPipelineId;
}

export function populatePreviewTrackSelect(pipeline: PipelineView): void {
    const sel = document.getElementById('preview-audio-select') as HTMLSelectElement | null;
    if (!sel) return;
    const tracks = pipeline.input.audioTracks;
    if (tracks.length <= 1) {
        sel.classList.add('hidden');
        sel.innerHTML = '';
        return;
    }
    const prev = sel.value;
    const opts = ['<option value="">Audio: default</option>'];
    for (const t of tracks) {
        const label = [t.language, t.title].filter(Boolean).join(' ');
        opts.push(
            `<option value="${t.index}">Track ${t.index + 1}${label ? ` (${label})` : ''}</option>`,
        );
    }
    sel.innerHTML = opts.join('');
    // Preserve the user's selection across re-renders.
    if (prev && tracks.some((t) => String(t.index) === prev)) sel.value = prev;
    sel.classList.remove('hidden');
}
