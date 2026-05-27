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

export function buildFfmpegArgs(
    inputUrl: string,
    outputUrl: string,
    encoding = 'source',
): string[] {
    const encArgs = ENCODINGS[encoding] ?? ENCODINGS.source;
    const isSrt = outputUrl.startsWith('srt://');
    const outputArgs = isSrt ? ['-f', 'mpegts', outputUrl] : ['-f', 'flv', outputUrl];
    return ['-i', inputUrl, ...encArgs, '-progress', 'pipe:1', ...outputArgs];
}

export function validateOutputUrl(url: string): boolean {
    return url.startsWith('rtmp://') || url.startsWith('rtmps://') || url.startsWith('srt://');
}
