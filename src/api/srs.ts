import { execFile } from 'child_process';
import type { Express } from 'express';
import type { Db } from '../types.js';
import { kickSrsClientsByStream } from '../utils/srs.js';
import type { SrsEvent } from '../services/health.js';

const MAX_LOG_READ_BYTES = 100 * 1024;
const MAX_LOG_TAIL_LINES = 200;

// All three only ever log to the journal (never a file), and only exist as
// systemd units in production — `npm run dev`/`npm run srs`/`npm run relay`
// aren't systemd-managed, so these read as empty (source 'none') locally.
const SRS_SYSTEMD_UNIT = 'srs.service';
const APP_SYSTEMD_UNIT = 'restream-srs.service';
const RELAY_SYSTEMD_UNIT = 'srt-bonding-relay.service';

type LogSource = 'journal' | 'none';
interface LogTail {
    lines: string[];
    source: LogSource;
}

function readJournalTail(unit: string, maxLines: number): Promise<string[]> {
    return new Promise((resolve) => {
        execFile(
            'journalctl',
            ['-u', unit, '-n', String(maxLines), '--no-pager', '-o', 'cat'],
            { timeout: 5000, maxBuffer: MAX_LOG_READ_BYTES },
            (err, stdout) => {
                resolve(err ? [] : stdout.split('\n').filter((l) => l.trim()));
            },
        );
    });
}

async function readJournalOnlyTail(unit: string, maxLines: number): Promise<LogTail> {
    const lines = await readJournalTail(unit, maxLines);
    return { lines, source: lines.length > 0 ? 'journal' : 'none' };
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
    app.get('/api/srs-logs', async (_req, res) => {
        const [srs, dashboard, relay] = await Promise.all([
            readJournalOnlyTail(SRS_SYSTEMD_UNIT, MAX_LOG_TAIL_LINES),
            readJournalOnlyTail(APP_SYSTEMD_UNIT, MAX_LOG_TAIL_LINES),
            readJournalOnlyTail(RELAY_SYSTEMD_UNIT, MAX_LOG_TAIL_LINES),
        ]);
        res.json({ events: getSrsEvents(), srs, dashboard, relay });
    });
}
