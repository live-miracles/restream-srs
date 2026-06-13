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
        const hasPassphrase = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'srtPassphrase');
        const passphrase = hasPassphrase
            ? normalizeSrtPassphrase(req.body?.srtPassphrase)
            : currentSrtPassphrase(db);
        const publicHost = (req.body?.publicHost as string | undefined)?.trim() ?? null;

        if (!name) return res.status(400).json({ error: 'name is required' });
        if (passphrase === undefined) {
            return res
                .status(400)
                .json({ error: 'SRT passphrase must be blank or 10 to 79 characters' });
        }

        db.setSetting('serverName', name);
        if (publicHost !== null) db.setSetting('publicHost', publicHost);
        const previousPassphrase = currentSrtPassphrase(db);
        const srtChanged = previousPassphrase !== passphrase;

        if (srtChanged) {
            db.setSetting('srtPassphrase', passphrase ?? '');
            try {
                writeSrsConf(passphrase);
            } catch (e) {
                return res.status(500).json({ error: 'Failed to write srs.conf: ' + String(e) });
            }
        }

        return res.json({
            serverName: name,
            srtPassphrase: passphrase,
            publicHost: publicHost ?? db.getSetting('publicHost') ?? 'localhost',
            pending: srtChanged,
        });
    });

    app.post('/api/settings/regenerate-stream-keys', (req, res) => {
        const pipelines = db.listPipelines();
        if (pipelines.length > 0) {
            return res
                .status(409)
                .json({ error: 'Cannot regenerate stream keys while pipelines exist' });
        }
        const streamKeys = db.regenerateStreamKeys();
        return res.json({ streamKeys });
    });

    app.post('/api/settings/server-name', (req, res) => {
        const name = (req.body?.name as string | undefined)?.trim();
        if (!name) return res.status(400).json({ error: 'name is required' });
        db.setSetting('serverName', name);
        return res.json({ serverName: name });
    });
}
