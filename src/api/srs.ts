import fs from 'fs';
import type { Express } from 'express';
import { SRS_LOG_PATH } from '../utils/conf.js';
import type { Db } from '../types.js';
import { kickSrsClientsByStream } from '../utils/srs.js';
import type { SrsEvent } from '../services/health.js';

const MAX_LOG_READ_BYTES = 100 * 1024;
const MAX_LOG_TAIL_LINES = 200;

function readLogFileTail(maxLines: number): { lines: string[]; fileExists: boolean } {
    try {
        const fd = fs.openSync(SRS_LOG_PATH, 'r');
        const { size } = fs.fstatSync(fd);
        const readLen = Math.min(size, MAX_LOG_READ_BYTES);
        const buf = Buffer.alloc(readLen);
        fs.readSync(fd, buf, 0, readLen, size - readLen);
        fs.closeSync(fd);
        return {
            fileExists: true,
            lines: buf
                .toString('utf8')
                .split('\n')
                .filter((l) => l.trim())
                .slice(-maxLines),
        };
    } catch (err: unknown) {
        const isNotFound = (err as NodeJS.ErrnoException).code === 'ENOENT';
        return { fileExists: !isNotFound, lines: [] };
    }
}

export function registerSrsHooks(app: Express, db: Db): void {
    app.get('/api/ready', (_req, res) => {
        res.json({ ok: true });
    });

    app.post('/api/srs/on_publish', (req, res) => {
        const stream = req.body?.stream as string | undefined;
        const hookApp = req.body?.app as string | undefined;
        const ip = (req.body?.ip as string | undefined) ?? 'unknown';
        if (!stream) return res.status(400).json({ code: 400 });

        const valid = db.listPipelines().some((p) => p.streamKey === stream);
        if (!valid) {
            // "rejected ... from <ip>:" is matched by the fail2ban filter that
            // server-install.sh writes — keep the format in sync if changing
            // it. The IP goes before the attacker-controlled stream name so a
            // crafted name can't spoof or evade the match.
            console.log(`[srs-hook] rejected publish from ${ip}: ${stream}`);
            if (hookApp) void kickSrsClientsByStream(hookApp, stream).catch(() => {});
            return res.status(403).json({ code: 403 });
        }

        console.log(`[srs-hook] allowed publish from ${ip}: ${stream}`);
        return res.json({ code: 0 });
    });

    // Only the app's own ffmpeg/ffprobe (preview, outputs, health probes) ever
    // plays streams from SRS, and always over loopback. Rejecting every other
    // play makes the public RTMP/SRT ports ingest-only: knowing a stream key is
    // no longer enough to watch a stream. SRT plays fire this hook too (SRS
    // calls on_play for native SRT connections even with srt_to_rtmp off).
    app.post('/api/srs/on_play', (req, res) => {
        const ip = (req.body?.ip as string | undefined) ?? '';
        const stream = req.body?.stream as string | undefined;
        const loopback = ip === '::1' || ip.startsWith('127.') || ip.startsWith('::ffff:127.');
        if (!loopback) {
            console.log(`[srs-hook] rejected play from ${ip || 'unknown'}: ${stream ?? '?'}`);
            return res.status(403).json({ code: 403 });
        }
        return res.json({ code: 0 });
    });
}

export function registerSrsLogsApi(app: Express, getSrsEvents: () => SrsEvent[]): void {
    app.get('/api/srs-logs', (_req, res) => {
        const { lines, fileExists } = readLogFileTail(MAX_LOG_TAIL_LINES);
        res.json({ events: getSrsEvents(), logTail: lines, logFileExists: fileExists });
    });
}
