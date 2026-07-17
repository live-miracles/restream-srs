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

// 'aac' is the explicit opt-in for a real audio transcode — the only reason to
// ever pick it is SRT-origin jitter (raw MPEG-TS PCR rounding / packet-loss
// gaps): aresample=async=1 tracks the real clock by adding/dropping samples to
// absorb that drift without inventing new PTS, which needs a real decode. A
// native RTMP origin has well-behaved timestamps (srt_to_rtmp is disabled —
// see srs.conf — so RTMP-origin pulls never pass through its jittery remux),
// so 'aac' on an RTMP origin just normalizes the codec/format with no filter.
function encodeAudioArgs(isSrtOrigin: boolean): string[] {
    const filterArgs = isSrtOrigin ? ['-af', 'aresample=async=1:first_pts=0'] : [];
    return [...filterArgs, '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000'];
}

// Explicit map for FLV: ffmpeg's default picks the highest-channel stream, which
// can be an unwanted program mix. 'copy'/'aac' both mean "default track" (0);
// only an explicit numeric selection picks a specific one.
function buildSinkMapArgs(audioTrack: string, isSrt: boolean): string[] {
    if (isSrt) return buildAudioMapArgs(audioTrack);
    const idx =
        audioTrack === 'copy' || audioTrack === 'aac' ? '0' : audioTrack.split(',')[0].trim();
    return ['-map', '0:v:0?', '-map', `0:a:${idx}?`];
}

function buildAudioMapArgs(audioTrack: string): string[] {
    if (audioTrack === 'copy' || audioTrack === 'aac') return [];
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

// Abort the pull if no input data is read for this long (microseconds, ffmpeg's
// -rw_timeout unit). SRS holds publisher-less pulls open indefinitely, so without
// this an output whose input never returns (or sits on a stale half-open socket)
// would hang "running" forever. On timeout ffmpeg exits, the retry loop takes
// over, and the output is restarted once the input is live again. Exported so
// the preview's ffmpeg pull uses the same bound.
export const INPUT_TIMEOUT_US = 10 * 60 * 1_000_000; // 10 minutes

// Build a single ffmpeg command that pulls the input once and pushes it to one
// destination. The destination's audio track(s) are selected via -map; SRT
// destinations use mpegts, everything else uses flv.
export function buildFfmpegArgs(
    inputUrl: string,
    url: string,
    audioEncoding: string,
    videoEncoding = 'copy',
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

    const isSrt = url.startsWith('srt://');
    const isSrtOrigin = inputUrl.startsWith('srt://');
    const mapArgs = buildSinkMapArgs(audioEncoding, isSrt);
    // 'copy' always means a literal stream copy, regardless of origin/destination
    // protocol. Anything else (the 'aac' opt-in, or an explicit track index/list)
    // forces a real transcode — see encodeAudioArgs for when that adds a filter.
    const audioArgs =
        audioEncoding === 'copy' ? (['-c:a', 'copy'] as const) : encodeAudioArgs(isSrtOrigin);
    const fmt = isSrt ? ['-f', 'mpegts'] : ['-f', 'flv'];
    args.push(...mapArgs, ...encArgs, ...audioArgs, ...fmt, url);
    return args;
}

export function validateOutputUrl(url: string): boolean {
    return url.startsWith('rtmp://') || url.startsWith('rtmps://') || url.startsWith('srt://');
}

export function validateAudioEncoding(value: unknown): string | null {
    if (!value || value === 'copy') return 'copy';
    if (value === 'aac') return 'aac';
    if (typeof value !== 'string') return null;
    const parts = value.split(',').map((s) => s.trim());
    if (!parts.every((p) => /^\d+$/.test(p))) return null;
    return parts.join(',');
}
