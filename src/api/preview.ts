import type { Express } from 'express';
import type { PreviewService } from '../services/preview.js';

export function registerPreviewApi(app: Express, previewService: PreviewService): void {
    app.post('/api/pipelines/:id/preview/start', async (req, res) => {
        const id = parseInt(req.params.id);
        if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
        const rawTrack = req.body?.audioTrack;
        const audioTrack =
            typeof rawTrack === 'number' && Number.isInteger(rawTrack) && rawTrack >= 0
                ? rawTrack
                : typeof rawTrack === 'string' && /^\d+$/.test(rawTrack)
                  ? parseInt(rawTrack)
                  : null;
        try {
            return res.json(await previewService.start(id, audioTrack));
        } catch (err) {
            return res.status(500).json({ error: String(err) });
        }
    });

    app.post('/api/pipelines/:id/preview/stop', (req, res) => {
        const id = parseInt(req.params.id);
        if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
        previewService.stop(id);
        return res.json({ ok: true });
    });
}
