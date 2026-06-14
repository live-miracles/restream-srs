import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import type { Express } from 'express';

const VERSION_EXEC_TIMEOUT_MS = 3000;
const VERSION_FETCH_TIMEOUT_MS = 2000;

function exec(cmd: string, args: string[]): Promise<string> {
    return new Promise((resolve) => {
        execFile(cmd, args, { timeout: VERSION_EXEC_TIMEOUT_MS }, (_err, stdout, stderr) => {
            resolve((stdout || stderr).trim());
        });
    });
}

function readOsRelease(): string {
    try {
        const content = fs.readFileSync('/etc/os-release', 'utf8');
        const match = content.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
        return match?.[1] ?? os.type();
    } catch {
        return os.type();
    }
}

async function getSrsVersion(): Promise<string> {
    const srsApiUrl = process.env.SRS_API_URL ?? 'http://localhost:1985';
    try {
        const resp = await fetch(`${srsApiUrl}/api/v1/versions`, {
            signal: AbortSignal.timeout(VERSION_FETCH_TIMEOUT_MS),
        });
        const data = (await resp.json()) as { data?: { version?: string } };
        return data?.data?.version ?? 'unknown';
    } catch {
        return 'unknown';
    }
}

interface VersionResult {
    commit: string;
    srs: string;
    ffmpeg: string;
    os: string;
    kernel: string;
}

let cached: VersionResult | null = null;

export function registerVersionApi(app: Express): void {
    app.get('/api/version', async (_req, res) => {
        if (cached) return res.json(cached);

        const [commitLine, srs, ffmpegOut] = await Promise.all([
            exec('git', ['log', '-1', '--format=%h %s']),
            getSrsVersion(),
            exec('ffmpeg', ['-version']),
        ]);

        const ffmpegLine = ffmpegOut.split('\n')[0] ?? '';
        const ffmpeg = ffmpegLine.replace(/^ffmpeg version /, '').split(' ')[0] || 'unknown';

        cached = {
            commit: commitLine || 'unknown',
            srs: srs || 'unknown',
            ffmpeg,
            os: readOsRelease(),
            kernel: os.release(),
        };
        return res.json(cached);
    });
}
