interface VideoEncodingPreset {
    args: string[];
}

export const ENCODINGS: Record<string, VideoEncodingPreset> = {
    copy: {
        args: ['-c:v', 'copy'],
    },
    '720p': {
        args: ['-vf', 'scale=1280:720', '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '3000k'],
    },
    '1080p': {
        args: ['-vf', 'scale=1920:1080', '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '5000k'],
    },
    vertical_rotate: {
        args: [
            '-vf',
            'scale=720:-2:flags=fast_bilinear,transpose=1',
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
        ],
    },
};

// SRT input is raw MPEG-TS whose audio timestamps jitter (PCR rounding, SRT
// packet-loss gaps); aresample=async=1 tracks the real clock by adding/dropping
// samples to absorb drift without inventing new PTS. A native RTMP input has
// well-behaved timestamps, so asetpts simply recomputes a contiguous PTS from the
// decoded sample count — a near no-op that keeps the FLV audio clean.
function flvAudioArgs(inputUrl: string): string[] {
    const af = inputUrl.startsWith('srt://')
        ? 'aresample=async=1:first_pts=0'
        : 'asetpts=STARTPTS+N/SR/TB';
    return ['-af', af, '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000'];
}

// Explicit map for FLV: ffmpeg's default picks the highest-channel stream, which
// can be an unwanted program mix. 'copy' defaults to track 0.
function buildSinkMapArgs(audioTrack: string, isSrt: boolean): string[] {
    if (isSrt) return buildAudioMapArgs(audioTrack);
    const idx = audioTrack === 'copy' ? '0' : audioTrack.split(',')[0].trim();
    return ['-map', '0:v:0?', '-map', `0:a:${idx}?`];
}

function buildAudioMapArgs(audioTrack: string): string[] {
    if (audioTrack === 'copy') return [];
    const indices = audioTrack
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const args: string[] = ['-map', '0:v:0'];
    for (const idx of indices) {
        args.push('-map', `0:a:${idx}`);
    }
    return args;
}

export interface SinkSpec {
    url: string;
    audioEncoding: string;
}

// Output-level SRT receiver latency (shared by all of an output's sinks). Has
// no effect on non-SRT sinks. ms is what the UI collects; SRT's own 'latency'
// URL option is in microseconds (see srtPullUrl's 200ms -> latency=200000).
function withSrtLatency(url: string, srtLatencyMs: number | null | undefined): string {
    if (!srtLatencyMs || !url.startsWith('srt://')) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}latency=${srtLatencyMs * 1000}`;
}

// Abort the pull if no input data is read for this long (microseconds, ffmpeg's
// -rw_timeout unit). SRS holds publisher-less pulls open indefinitely, so without
// this an output whose input never returns (or sits on a stale half-open socket)
// would hang "running" forever. On timeout ffmpeg exits, the retry loop takes
// over, and the output is restarted once the input is live again. Exported so
// the preview's ffmpeg pull uses the same bound.
export const INPUT_TIMEOUT_US = 10 * 60 * 1_000_000; // 10 minutes

// Build a single ffmpeg command that pulls the input once and fans it out to
// every sink. The shared video encoding is applied per sink; each sink picks its
// own audio track(s) via -map. SRT sinks use mpegts, everything else uses flv.
//
// When encoding video (non-copy) with multiple sinks that share the same audio
// encoding, the tee muxer is used so ffmpeg encodes once and fans out — avoids
// paying N× CPU for N sinks. Falls back to per-output args when sinks have
// different audio encodings (mixed-track SRT layouts), where tee select mapping
// would be complex and the configuration is rare.
export function buildFfmpegArgs(
    inputUrl: string,
    sinks: SinkSpec[],
    videoEncoding = 'copy',
    srtLatencyMs: number | null = null,
): string[] {
    const encArgs = (ENCODINGS[videoEncoding] ?? ENCODINGS.copy).args;
    const args: string[] = [
        // Keep stderr quiet: '-nostats' drops the ~2/s "frame=…bitrate=…" line and
        // '-loglevel warning' the one-time info banner. With hundreds of outputs
        // those stderr writes are pure GC/event-loop pressure on the parent, and we
        // already read live bitrate from '-progress pipe:1'. Warnings/errors are
        // still emitted so the stderr tail explains failures.
        '-nostats',
        '-loglevel',
        'warning',
        // Emit '-progress pipe:1' every 3s instead of the default ~1s. The only
        // consumer (live bitrate) is sampled at the 5s health-poll cadence, so a
        // sub-5s update rate is invisible — at hundreds of outputs the extra
        // stdout writes are pure event-loop/GC churn on the parent. 3s keeps each
        // poll's bitrate at most ~3s stale while cutting the write rate ~3x.
        // (Progress on stdout is also the SIGPIPE keepalive that lets ffmpeg
        // self-exit when the parent dies; at 3s that detection is still prompt.)
        '-stats_period',
        '3',
        // Drop packets the demuxer/decoder already knows are broken (bad CRC,
        // desynced bitstream) before they reach the AAC decoder. Without this, a
        // glitchy input can hand the decoder a corrupt frame it misparses as a
        // bogus channel layout (seen as "Full-on remixing from 22.2" in the
        // 2026-07-10 incident), which is what triggered the swresample memory
        // blow-up — see fail-reports/2026-07-10-pipeline1-output-oom-cascade.md.
        '-fflags',
        '+discardcorrupt',
        '-err_detect',
        'crccheck+bitstream',
        '-rw_timeout',
        String(INPUT_TIMEOUT_US),
        '-i',
        inputUrl,
        '-progress',
        'pipe:1',
    ];

    const firstSinkIsSrt = sinks[0].url.startsWith('srt://');
    const useTee =
        videoEncoding !== 'copy' &&
        sinks.length > 1 &&
        sinks.every((s) => s.url.startsWith('srt://') === firstSinkIsSrt) &&
        sinks.every((s) => s.audioEncoding === sinks[0].audioEncoding);

    if (useTee) {
        const mapArgs = buildSinkMapArgs(sinks[0].audioEncoding, firstSinkIsSrt);
        const audioArgs = firstSinkIsSrt ? (['-c:a', 'copy'] as const) : flvAudioArgs(inputUrl);
        const fmt = firstSinkIsSrt ? 'mpegts' : 'flv';
        const teeSpec = sinks
            .map((s) => `[f=${fmt}]${withSrtLatency(s.url, srtLatencyMs)}`)
            .join('|');
        args.push(...mapArgs, ...encArgs, ...audioArgs, '-f', 'tee', teeSpec);
        return args;
    }

    for (const sink of sinks) {
        const isSrt = sink.url.startsWith('srt://');
        const mapArgs = buildSinkMapArgs(sink.audioEncoding, isSrt);
        const audioArgs = isSrt ? (['-c:a', 'copy'] as const) : flvAudioArgs(inputUrl);
        const fmt = isSrt ? ['-f', 'mpegts'] : ['-f', 'flv'];
        args.push(...mapArgs, ...encArgs, ...audioArgs, ...fmt, withSrtLatency(sink.url, srtLatencyMs));
    }
    return args;
}

export function validateOutputUrl(url: string): boolean {
    return url.startsWith('rtmp://') || url.startsWith('rtmps://') || url.startsWith('srt://');
}

export function validateAudioEncoding(value: unknown): string | null {
    if (!value || value === 'copy') return 'copy';
    if (typeof value !== 'string') return null;
    const parts = value.split(',').map((s) => s.trim());
    if (!parts.every((p) => /^\d+$/.test(p))) return null;
    return parts.join(',');
}

// Empty/missing means "unconfigured" (no latency param added); anything else
// must be a positive integer number of milliseconds.
export function parseSrtLatencyMs(raw: unknown): { value: number | null } | { error: string } {
    if (raw === undefined || raw === null || raw === '') return { value: null };
    const num = Number(raw);
    if (!Number.isInteger(num) || num <= 0) {
        return { error: 'srtLatencyMs must be a positive integer (milliseconds)' };
    }
    return { value: num };
}
