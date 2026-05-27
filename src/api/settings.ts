import type { Express } from 'express';
import type { Db } from '../types.js';

export function registerSettingsApi(app: Express, db: Db): void {
    app.post('/api/settings/server-name', (req, res) => {
        const name = (req.body?.name as string | undefined)?.trim();
        if (!name) return res.status(400).json({ error: 'name is required' });
        db.setSetting('serverName', name);
        return res.json({ serverName: name });
    });
}
