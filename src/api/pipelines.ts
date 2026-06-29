import type { Express } from 'express';
import type { Db } from '../types.js';
import type { OutputService } from '../services/outputs.js';
import type { PreviewService } from '../services/preview.js';
import type { SrtRelayService } from '../services/srtRelay.js';

export function registerPipelineApi(
    app: Express,
    db: Db,
    outputService: OutputService,
    previewService: PreviewService,
    srtRelayService: SrtRelayService,
): void {
    app.post('/api/pipelines', (_req, res) => {
        const pipeline = db.createPipeline();
        return res.status(201).json(pipeline);
    });

    app.get('/api/pipelines/:id', (req, res) => {
        const id = parseInt(req.params.id);
        if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
        const pipeline = db.getPipeline(id);
        if (!pipeline) return res.status(404).json({ error: 'Pipeline not found' });
        return res.json({
            ...pipeline,
            srtRelay: srtRelayService.getStats(id),
        });
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
            if (existing.bondingEnabled) {
                return res
                    .status(409)
                    .json({ error: 'Stop SRT bonding before changing the stream key' });
            }
            // The preview pulls a fixed stream key and has no retry loop, so a
            // key reassignment would leave it pinned to the old key. Stop it;
            // the user can replay against the new key.
            previewService.stop(id);
        }

        const updated = db.updatePipeline(id, name, streamKeyId);
        return res.json(updated);
    });

    app.post('/api/pipelines/:id/bonding', (req, res) => {
        const id = parseInt(req.params.id);
        if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
        if (!db.getPipeline(id)) return res.status(404).json({ error: 'Pipeline not found' });

        const enabled = req.body?.enabled;
        if (typeof enabled !== 'boolean') {
            return res.status(400).json({ error: 'enabled boolean is required' });
        }

        try {
            const updated = db.setPipelineBondingEnabled(id, enabled);
            if (enabled) srtRelayService.start(id);
            else srtRelayService.stop(id);
            return res.json({
                ok: true,
                pipeline: updated,
                srtRelay: srtRelayService.getStats(id),
            });
        } catch (err) {
            try {
                db.setPipelineBondingEnabled(id, false);
            } catch {
                /* best-effort */
            }
            return res.status(400).json({ error: (err as Error).message });
        }
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
        await srtRelayService.stopAndWait(id);
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
