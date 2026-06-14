import type { Express } from 'express';
import type { Db } from '../types.js';
import type { OutputService } from '../services/outputs.js';
import type { PreviewService } from '../services/preview.js';

export function registerPipelineApi(
    app: Express,
    db: Db,
    outputService: OutputService,
    previewService: PreviewService,
): void {
    app.post('/api/pipelines', (_req, res) => {
        const pipeline = db.createPipeline();
        return res.status(201).json(pipeline);
    });

    app.post('/api/pipelines/:id', (req, res) => {
        const id = parseInt(req.params.id);
        if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
        const existing = db.getPipeline(id);
        if (!existing) return res.status(404).json({ error: 'Pipeline not found' });

        const name = (req.body?.name as string | undefined)?.trim();
        if (!name) return res.status(400).json({ error: 'name is required' });
        const streamKeyId = req.body?.streamKeyId as number | undefined;
        const keyChanged = streamKeyId !== undefined && streamKeyId !== existing.streamKeyId;

        if (keyChanged) {
            const active = db.listOutputsForPipeline(id).some((o) => o.desiredState !== 'stopped');
            if (active) {
                return res
                    .status(409)
                    .json({ error: 'Stop all outputs before changing the stream key' });
            }
            // The preview pulls a fixed stream key and has no retry loop, so a
            // key reassignment would leave it pinned to the old key. Stop it;
            // the user can replay against the new key.
            previewService.stop(id);
        }

        const updated = db.updatePipeline(id, name, streamKeyId);
        return res.json(updated);
    });

    app.delete('/api/pipelines/:id', async (req, res) => {
        const id = parseInt(req.params.id);
        if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
        if (!db.getPipeline(id)) return res.status(404).json({ error: 'Pipeline not found' });

        const active = db.listOutputsForPipeline(id).some((o) => o.desiredState !== 'stopped');
        if (active) {
            return res
                .status(409)
                .json({ error: 'Stop all outputs before deleting this pipeline' });
        }

        previewService.stop(id);
        const outputs = db.listOutputsForPipeline(id);
        await Promise.all(outputs.map((o) => outputService.stopAndWait(o.id)));

        db.deletePipeline(id);
        return res.json({ ok: true });
    });

    app.get('/api/pipelines/:id/logs', (req, res) => {
        const id = parseInt(req.params.id);
        if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
        if (!db.getPipeline(id)) return res.status(404).json({ error: 'Pipeline not found' });
        return res.json(db.getPipelineLogs(id));
    });
}
