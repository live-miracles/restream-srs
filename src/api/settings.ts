import type { Express } from 'express';
import type { Db } from '../types.js';
import { writeSrtRuntimeConfigs } from '../utils/conf.js';

const SRT_PASSPHRASE_MIN_LEN = 10;
const SRT_PASSPHRASE_MAX_LEN = 79;

function normalizeSrtPassphrase(value: unknown): string | null | undefined {
    if (value == null) return null;
    if (typeof value !== 'string') return undefined;
    const passphrase = value.trim();
    if (!passphrase) return null;
    if (passphrase.length < SRT_PASSPHRASE_MIN_LEN || passphrase.length > SRT_PASSPHRASE_MAX_LEN)
        return undefined;
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
            return res.status(400).json({
                error: `SRT passphrase must be blank or ${SRT_PASSPHRASE_MIN_LEN} to ${SRT_PASSPHRASE_MAX_LEN} characters`,
            });
        }

        db.setSetting('serverName', name);
        if (publicHost !== null) db.setSetting('publicHost', publicHost);
        const previousPassphrase = currentSrtPassphrase(db);
        const srtChanged = previousPassphrase !== passphrase;

        if (srtChanged) {
            db.setSetting('srtPassphrase', passphrase ?? '');
            try {
                writeSrtRuntimeConfigs(passphrase);
            } catch (e) {
                return res
                    .status(500)
                    .json({ error: 'Failed to write SRT configuration: ' + String(e) });
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
}
