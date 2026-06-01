import type { Express } from 'express';
import type { Db } from '../types.js';
import { kickSrsClientsByStream } from '../utils/srs.js';

export function registerSrsHooks(app: Express, db: Db): void {
    app.post('/api/srs/on_publish', (req, res) => {
        const stream = req.body?.stream as string | undefined;
        const hookApp = req.body?.app as string | undefined;
        if (!stream) return res.status(400).json({ code: 400 });

        const valid = db.listPipelines().some((p) => p.streamKey === stream);
        if (!valid) {
            console.log(`[srs-hook] rejected publish: ${stream}`);
            if (hookApp) void kickSrsClientsByStream(hookApp, stream).catch(() => {});
            return res.status(403).json({ code: 403 });
        }

        console.log(`[srs-hook] allowed publish: ${stream}`);
        return res.json({ code: 0 });
    });
}
