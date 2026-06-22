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
    app.post('/api/srs/on_publish', (req, res) => {
        const stream = req.body?.stream as string | undefined;
        const hookApp = req.body?.app as string | undefined;
        if (!stream) return res.status(400).json({ code: 400 });

        const valid = db.listPipelines().some((p) => p.streamKey === stream);
        if (!valid) {
            console.log(`[srs-hook] rejected publish: ${stream}`);
            if (hookApp) void kickSrsClientsByStream(hookApp, stream).catch(() => {});
            return res.status(403).json({ code: 403 });
        }

        console.log(`[srs-hook] allowed publish: ${stream}`);
        return res.json({ code: 0 });
    });
}

export function registerSrsLogsApi(app: Express, getSrsEvents: () => SrsEvent[]): void {
    app.get('/api/srs-logs', (_req, res) => {
        const { lines, fileExists } = readLogFileTail(MAX_LOG_TAIL_LINES);
        res.json({ events: getSrsEvents(), logTail: lines, logFileExists: fileExists });
    });
}
