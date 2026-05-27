import type { Express } from 'express';
import { validateOutputUrl, ENCODINGS } from '../utils/ffmpeg.js';
import type { Db } from '../types.js';
import type { OutputService } from '../services/outputs.js';

export function registerOutputApi(app: Express, db: Db, outputService: OutputService): void {
    app.post('/api/pipelines/:pipelineId/outputs', (req, res) => {
        const pipelineId = parseInt(req.params.pipelineId);
        if (isNaN(pipelineId)) return res.status(400).json({ error: 'invalid pipelineId' });
        if (!db.getPipeline(pipelineId))
            return res.status(404).json({ error: 'Pipeline not found' });

        const name = (req.body?.name as string | undefined)?.trim();
        const url = (req.body?.url as string | undefined)?.trim();
        const encoding = (req.body?.encoding as string | undefined)?.trim() || 'source';

        if (!name) return res.status(400).json({ error: 'name is required' });
        if (!url || !validateOutputUrl(url))
            return res
                .status(400)
                .json({ error: 'valid url is required (rtmp://, rtmps://, srt://)' });
        if (!ENCODINGS[encoding])
            return res.status(400).json({ error: `unknown encoding: ${encoding}` });

        const output = db.createOutput({ pipelineId, name, url, encoding });
        return res.status(201).json(output);
    });

    app.post('/api/pipelines/:pipelineId/outputs/:outId', (req, res) => {
        const { pipelineId, outId } = req.params;
        const output = db.getOutput(outId);
        if (!output || output.pipelineId !== parseInt(pipelineId)) {
            return res.status(404).json({ error: 'Output not found' });
        }

        const name = (req.body?.name as string | undefined)?.trim() ?? output.name;
        const url = (req.body?.url as string | undefined)?.trim() ?? output.url;
        const encoding = (req.body?.encoding as string | undefined)?.trim() ?? output.encoding;

        if (!name) return res.status(400).json({ error: 'name is required' });
        if (!validateOutputUrl(url)) return res.status(400).json({ error: 'valid url required' });
        if (!ENCODINGS[encoding])
            return res.status(400).json({ error: `unknown encoding: ${encoding}` });

        const updated = db.updateOutput(outId, { name, url, encoding });
        return res.json(updated);
    });

    app.delete('/api/pipelines/:pipelineId/outputs/:outId', async (req, res) => {
        const { pipelineId, outId } = req.params;
        const output = db.getOutput(outId);
        if (!output || output.pipelineId !== parseInt(pipelineId)) {
            return res.status(404).json({ error: 'Output not found' });
        }

        await outputService.stopAndWait(outId);
        outputService.clearRetryState(outId);
        db.deleteOutput(outId);
        return res.json({ ok: true });
    });

    app.post('/api/pipelines/:pipelineId/outputs/:outId/start', async (req, res) => {
        const { pipelineId, outId } = req.params;
        const output = db.getOutput(outId);
        if (!output || output.pipelineId !== parseInt(pipelineId)) {
            return res.status(404).json({ error: 'Output not found' });
        }

        try {
            db.setOutputDesiredState(outId, 'running');
            await outputService.start(outId);
            return res.json({ ok: true, status: outputService.getStats(outId) });
        } catch (err) {
            return res.status(400).json({ error: (err as Error).message });
        }
    });

    app.post('/api/pipelines/:pipelineId/outputs/:outId/stop', async (req, res) => {
        const { pipelineId, outId } = req.params;
        const output = db.getOutput(outId);
        if (!output || output.pipelineId !== parseInt(pipelineId)) {
            return res.status(404).json({ error: 'Output not found' });
        }

        db.setOutputDesiredState(outId, 'stopped');
        outputService.stop(outId);
        return res.json({ ok: true });
    });
}
