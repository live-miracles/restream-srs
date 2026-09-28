import { execFile } from 'child_process';
import type { Express } from 'express';
import type { Db } from '../types.js';
import { kickSrsClientsByStream } from '../utils/srs.js';
import type { SrsEvent } from '../services/health.js';
import type { InputState } from '../services/inputState.js';

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

// SRS colors its own stdout with ANSI SGR codes, which journald stores
// verbatim. Lines are passed through as-is; the dashboard's log viewer
// renders those codes as color instead of stripping them.
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

// A rejected publisher that keeps retrying (misconfigured or stale encoder)
// can hit on_publish far faster than any real publish/kick cycle needs — seen
// in production hitting 10-40ms retry intervals indefinitely. Without this,
// every single rejection fires its own kickSrsClientsByStream sweep against
// SRS's client-list API, and those unthrottled sweeps pile up faster than
// they resolve. Cap kicks to one per app/stream pair per window, and clear
// the whole map each window so it can't grow unbounded under a flood of
// distinct (attacker-controlled) stream names.
const KICK_COOLDOWN_MS = 5000;

export function registerSrsHooks(app: Express, db: Db, inputState: InputState): void {
    let recentlyKicked = new Map<string, number>();
    setInterval(() => {
        recentlyKicked = new Map();
    }, KICK_COOLDOWN_MS).unref();

    app.get('/api/ready', (_req, res) => {
        res.json({ ok: true });
    });

    app.post('/api/srs/on_publish', (req, res) => {
        const stream = req.body?.stream as string | undefined;
        const hookApp = req.body?.app as string | undefined;
        const ip = (req.body?.ip as string | undefined) ?? 'unknown';
        if (!stream) return res.status(400).json({ code: 400 });

        const pipeline = db.listPipelines().find((p) => p.streamKey === stream);
        if (!pipeline) {
            // Put the IP before the attacker-controlled stream name so logs stay
            // easy to scan and cannot be made to look like a different client.
            console.log(`[srs-hook] rejected publish from ${ip}: ${stream}`);
            const kickKey = `${hookApp ?? ''}/${stream}`;
            if (hookApp && !recentlyKicked.has(kickKey)) {
                recentlyKicked.set(kickKey, Date.now());
                void kickSrsClientsByStream(hookApp, stream).catch(() => {});
            }
            return res.status(403).json({ code: 403 });
        }

        // SRS lets a same-key publish on a different protocol take over the
        // underlying source, but its own stats layer keeps the *original*
        // publisher's tcUrl/cid pinned — a same-key publish is treated as "a
        // duplicate publish event by bridge" and ignored — until the stream
        // fully drops to zero clients. That leaves our protocol tracking (and
        // the ffprobe URL it drives) permanently stuck on the old protocol: seen
        // in production as a stale "rtmp" badge and a failed encoding probe
        // after switching an already-live pipeline's publisher to SRT. Reject a
        // cross-protocol publish to an already-live pipeline outright so this
        // can't happen; the existing stream must be stopped first.
        const incomingProtocol = (req.body?.tcUrl as string | undefined)?.startsWith('srt://')
            ? 'srt'
            : 'rtmp';
        const currentProtocol = inputState.getProtocol(pipeline.id);
        if (
            inputState.isLive(pipeline.id) &&
            currentProtocol &&
            currentProtocol !== incomingProtocol
        ) {
            console.log(
                `[srs-hook] rejected publish from ${ip}: ${stream} (already live via ${currentProtocol}, attempted ${incomingProtocol})`,
            );
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
