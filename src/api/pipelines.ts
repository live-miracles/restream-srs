import type { Express } from 'express';
import type { Db } from '../types.js';
import type { OutputService } from '../services/outputs.js';

export function registerPipelineApi(app: Express, db: Db, outputService: OutputService): void {
    app.post('/api/pipelines', (_req, res) => {
        const pipeline = db.createPipeline();
        return res.status(201).json(pipeline);
    });

    app.post('/api/pipelines/:id', (req, res) => {
        const id = parseInt(req.params.id);
        if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
        if (!db.getPipeline(id)) return res.status(404).json({ error: 'Pipeline not found' });

        const name = (req.body?.name as string | undefined)?.trim();
        if (!name) return res.status(400).json({ error: 'name is required' });
        const streamKeyId = req.body?.streamKeyId as number | undefined;

        const updated = db.updatePipeline(id, name, streamKeyId);
        return res.json(updated);
    });

    app.delete('/api/pipelines/:id', async (req, res) => {
        const id = parseInt(req.params.id);
        if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
        if (!db.getPipeline(id)) return res.status(404).json({ error: 'Pipeline not found' });

        const outputs = db.listOutputsForPipeline(id);
        await Promise.all(outputs.map((o) => outputService.stopAndWait(o.id)));

        db.deletePipeline(id);
        return res.json({ ok: true });
    });
}
