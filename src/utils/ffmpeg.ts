export const ENCODINGS: Record<string, string[]> = {
    copy: ['-c', 'copy'],
    '720p': [
        '-vf',
        'scale=1280:720',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-b:v',
        '3000k',
        '-c:a',
        'copy',
    ],
    '1080p': [
        '-vf',
        'scale=1920:1080',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-b:v',
        '5000k',
        '-c:a',
        'copy',
    ],
    vertical_rotate: [
        '-vf',
        'scale=720:-2:flags=fast_bilinear,transpose=1',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-c:a',
        'copy',
    ],
};

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
        const mapArgs = buildAudioMapArgs(sinks[0].audioEncoding);
        const teeSpec = sinks
            .map((s) => `[f=${s.url.startsWith('srt://') ? 'mpegts' : 'flv'}]${s.url}`)
            .join('|');
        args.push(...mapArgs, ...encArgs, '-f', 'tee', teeSpec);
        return args;
    }

    for (const sink of sinks) {
        const mapArgs = buildAudioMapArgs(sink.audioEncoding);
        const isSrt = sink.url.startsWith('srt://');
        const fmt = isSrt ? ['-f', 'mpegts'] : ['-f', 'flv'];
        args.push(...mapArgs, ...encArgs, ...fmt, sink.url);
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
