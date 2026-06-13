export const ENCODINGS: Record<string, string[]> = {
    source: ['-c', 'copy'],
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

export function buildFfmpegArgs(
    inputUrl: string,
    outputUrl: string,
    videoEncoding = 'source',
    audioEncoding = 'copy',
): string[] {
    const mapArgs = buildAudioMapArgs(audioEncoding);
    const encArgs = ENCODINGS[videoEncoding] ?? ENCODINGS.source;
    const isSrt = outputUrl.startsWith('srt://');
    const outputArgs = isSrt ? ['-f', 'mpegts', outputUrl] : ['-f', 'flv', outputUrl];
    return ['-i', inputUrl, ...mapArgs, ...encArgs, '-progress', 'pipe:1', ...outputArgs];
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
