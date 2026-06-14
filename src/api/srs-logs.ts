import fs from 'fs';
import type { Express } from 'express';
import { SRS_LOG_PATH } from '../utils/conf.js';
import type { SrsEvent } from '../services/health.js';

const MAX_LOG_READ_BYTES = 100 * 1024;
const MAX_LOG_TAIL_LINES = 200;

function readLogFileTail(maxLines: number): string[] {
    try {
        const MAX_BYTES = MAX_LOG_READ_BYTES;
        const fd = fs.openSync(SRS_LOG_PATH, 'r');
        const { size } = fs.fstatSync(fd);
        const readLen = Math.min(size, MAX_BYTES);
        const buf = Buffer.alloc(readLen);
        fs.readSync(fd, buf, 0, readLen, size - readLen);
        fs.closeSync(fd);
        return buf
            .toString('utf8')
            .split('\n')
            .filter((l) => l.trim())
            .slice(-maxLines);
    } catch {
        return [];
    }
}

export function registerSrsLogsApi(app: Express, getSrsEvents: () => SrsEvent[]): void {
    app.get('/api/srs-logs', (_req, res) => {
        res.json({ events: getSrsEvents(), logTail: readLogFileTail(MAX_LOG_TAIL_LINES) });
    });
}
