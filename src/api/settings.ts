import type { Express } from 'express';
import type { Db } from '../types.js';

export function registerSettingsApi(app: Express, db: Db): void {
    app.post('/api/settings', (req, res) => {
        const name = (req.body?.name as string | undefined)?.trim();
        const publicHost = (req.body?.publicHost as string | undefined)?.trim() ?? null;

        if (!name) return res.status(400).json({ error: 'name is required' });

        db.setSetting('serverName', name);
        if (publicHost !== null) db.setSetting('publicHost', publicHost);

        return res.json({
            serverName: name,
            publicHost: publicHost ?? db.getSetting('publicHost') ?? 'localhost',
            pending: false,
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
