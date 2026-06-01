import type { Express } from 'express';
import type { Db } from '../types.js';
import { writeSrsConf } from '../utils/conf.js';

function normalizeSrtPassphrase(value: unknown): string | null | undefined {
    if (value == null) return null;
    if (typeof value !== 'string') return undefined;
    const passphrase = value.trim();
    if (!passphrase) return null;
    if (passphrase.length < 10 || passphrase.length > 79) return undefined;
    return passphrase;
}

function currentSrtPassphrase(db: Db): string | null {
    return db.getSetting('srtPassphrase') || null;
}

export function registerSettingsApi(app: Express, db: Db): void {
    app.post('/api/settings', (req, res) => {
        const name = (req.body?.name as string | undefined)?.trim();
        const { latency } = req.body as { latency: number | null };
        const hasPassphrase = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'srtPassphrase');
        const passphrase = hasPassphrase
            ? normalizeSrtPassphrase(req.body?.srtPassphrase)
            : currentSrtPassphrase(db);

        if (!name) return res.status(400).json({ error: 'name is required' });
        if (latency !== null && (typeof latency !== 'number' || latency < 20 || latency > 60000)) {
            return res
                .status(400)
                .json({ error: 'latency must be null or a number between 20 and 60000' });
        }
        if (passphrase === undefined) {
            return res
                .status(400)
                .json({ error: 'SRT passphrase must be blank or 10 to 79 characters' });
        }

        db.setSetting('serverName', name);
        const previousLatencyRaw = db.getSetting('srtLatency');
        const previousLatency = previousLatencyRaw ? parseInt(previousLatencyRaw) : null;
        const previousPassphrase = currentSrtPassphrase(db);
        const srtChanged = previousLatency !== latency || previousPassphrase !== passphrase;

        if (srtChanged) {
            db.setSetting('srtLatency', latency != null ? String(latency) : '');
            db.setSetting('srtPassphrase', passphrase ?? '');
            db.setSetting('srtLatencyPending', 'true');

            try {
                writeSrsConf(latency, passphrase);
            } catch (e) {
                return res.status(500).json({ error: 'Failed to write srs.conf: ' + String(e) });
            }
        }

        return res.json({
            serverName: name,
            srtLatency: latency,
            srtPassphrase: passphrase,
            pending: srtChanged,
        });
    });

    app.post('/api/settings/server-name', (req, res) => {
        const name = (req.body?.name as string | undefined)?.trim();
        if (!name) return res.status(400).json({ error: 'name is required' });
        db.setSetting('serverName', name);
        return res.json({ serverName: name });
    });

    app.post('/api/settings/srt-latency', (req, res) => {
        const { latency } = req.body as { latency: number | null };
        if (latency !== null && (typeof latency !== 'number' || latency < 20 || latency > 60000)) {
            return res
                .status(400)
                .json({ error: 'latency must be null or a number between 20 and 60000' });
        }
        db.setSetting('srtLatency', latency != null ? String(latency) : '');
        db.setSetting('srtLatencyPending', 'true');
        try {
            writeSrsConf(latency, currentSrtPassphrase(db));
        } catch (e) {
            return res.status(500).json({ error: 'Failed to write srs.conf: ' + String(e) });
        }
        return res.json({ srtLatency: latency, pending: true });
    });

    app.post('/api/settings/srt-latency/dismiss', (_req, res) => {
        db.setSetting('srtLatencyPending', 'false');
        return res.json({ ok: true });
    });
}
