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
    const args: string[] = ['-i', inputUrl, '-progress', 'pipe:1'];

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
