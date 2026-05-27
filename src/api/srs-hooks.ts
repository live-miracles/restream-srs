import type { Express } from 'express';
import type { Db } from '../types.js';

export function registerSrsHooks(app: Express, db: Db): void {
    app.post('/api/srs/on_publish', (req, res) => {
        const stream = req.body?.stream as string | undefined;
        if (!stream) return res.status(400).json({ code: 400 });

        const valid = db.listStreamKeys().some((k) => k.key === stream);
        if (!valid) {
            console.log(`[srs-hook] rejected publish: ${stream}`);
            return res.status(403).json({ code: 403 });
        }

        console.log(`[srs-hook] allowed publish: ${stream}`);
        return res.json({ code: 0 });
    });
}
