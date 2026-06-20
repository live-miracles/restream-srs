// Video-only; audio is handled per-sink by buildAudioCodecArgs().
export const ENCODINGS: Record<string, string[]> = {
    copy: ['-c:v', 'copy'],
    '720p': ['-vf', 'scale=1280:720', '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '3000k'],
    '1080p': ['-vf', 'scale=1920:1080', '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '5000k'],
    vertical_rotate: [
        '-vf',
        'scale=720:-2:flags=fast_bilinear,transpose=1',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
    ],
};

// aresample=async=1000 compensates SRT/MPEG-TS timestamp jitter; async=1 is too
// weak and leaves audible gaps. Safe no-op for clean RTMP inputs.
const FLV_AUDIO_ARGS = [
    '-af',
    'aresample=async=1000:first_pts=0',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ac',
    '2',
    '-ar',
    '48000',
];

function buildAudioCodecArgs(isSrt: boolean): string[] {
    return isSrt ? ['-c:a', 'copy'] : FLV_AUDIO_ARGS;
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

// Abort the pull if no input data is read for this long (microseconds, ffmpeg's
// -rw_timeout unit). SRS holds publisher-less pulls open indefinitely, so without
// this an output whose input never returns (or sits on a stale half-open socket)
// would hang "running" forever. On timeout ffmpeg exits, the retry loop takes
// over, and the output is restarted once the input is live again.
const INPUT_TIMEOUT_US = 10 * 60 * 1_000_000; // 10 minutes

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
): string[] {
    const encArgs = ENCODINGS[videoEncoding] ?? ENCODINGS.copy;
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
        '-rw_timeout',
        String(INPUT_TIMEOUT_US),
        // When joining a live SRT/MPEG-TS stream mid-GOP, H264 P-frames arrive
        // before the first IDR carrying SPS/PPS. Without this flag those packets
        // are forwarded to the FLV muxer as-is, producing a malformed AVC stream
        // that the RTMP server rejects. With discardcorrupt, the bitstream parser
        // drops them and waits for the next clean IDR before writing any video.
        // +genpts regenerates missing/non-monotonic timestamps from SRS's
        // srt_to_rtmp remux so the muxer and aresample have a sane clock to work
        // against (the preview path uses the same flag).
        '-fflags',
        '+genpts+discardcorrupt',
        '-i',
        inputUrl,
        '-progress',
        'pipe:1',
    ];

    const useTee =
        videoEncoding !== 'copy' &&
        sinks.length > 1 &&
        sinks.every((s) => s.audioEncoding === sinks[0].audioEncoding);

    if (useTee) {
        // Audio is encoded once before the tee and fanned out, so it must use a
        // codec valid for every sink. AAC works in both flv and mpegts; only fall
        // back to copy when every sink is SRT (preserving multitrack passthrough).
        const allSrt = sinks.every((s) => s.url.startsWith('srt://'));
        const mapArgs = buildSinkMapArgs(sinks[0].audioEncoding, allSrt);
        const audioArgs = buildAudioCodecArgs(allSrt);
        const teeSpec = sinks
            .map((s) => `[f=${s.url.startsWith('srt://') ? 'mpegts' : 'flv'}]${s.url}`)
            .join('|');
        args.push(...mapArgs, ...encArgs, ...audioArgs, '-f', 'tee', teeSpec);
        return args;
    }

    for (const sink of sinks) {
        const isSrt = sink.url.startsWith('srt://');
        const mapArgs = buildSinkMapArgs(sink.audioEncoding, isSrt);
        const audioArgs = buildAudioCodecArgs(isSrt);
        const fmt = isSrt ? ['-f', 'mpegts'] : ['-f', 'flv'];
        args.push(...mapArgs, ...encArgs, ...audioArgs, ...fmt, sink.url);
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
