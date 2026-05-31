import type { Express } from 'express';
import type { Db } from '../types.js';
import { writeSrsConf } from '../utils/conf.js';

export function registerSettingsApi(app: Express, db: Db): void {
    app.post('/api/settings', (req, res) => {
        const name = (req.body?.name as string | undefined)?.trim();
        const { latency } = req.body as { latency: number | null };

        if (!name) return res.status(400).json({ error: 'name is required' });
        if (latency !== null && (typeof latency !== 'number' || latency < 20 || latency > 60000)) {
            return res
                .status(400)
                .json({ error: 'latency must be null or a number between 20 and 60000' });
        }

        db.setSetting('serverName', name);
        const previousLatencyRaw = db.getSetting('srtLatency');
        const previousLatency = previousLatencyRaw ? parseInt(previousLatencyRaw) : null;
        const latencyChanged = previousLatency !== latency;

        if (latencyChanged) {
            db.setSetting('srtLatency', latency != null ? String(latency) : '');
            db.setSetting('srtLatencyPending', 'true');

            try {
                writeSrsConf(latency);
            } catch (e) {
                return res.status(500).json({ error: 'Failed to write srs.conf: ' + String(e) });
            }
        }

        return res.json({ serverName: name, srtLatency: latency, pending: latencyChanged });
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
            writeSrsConf(latency);
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
