import type { Express } from 'express';
import { validateOutputUrl, validateAudioEncoding, ENCODINGS } from '../utils/ffmpeg.js';
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
        const videoEncoding = (req.body?.videoEncoding as string | undefined)?.trim() || 'source';
        const audioEncoding = validateAudioEncoding(req.body?.audioEncoding);

        if (!name) return res.status(400).json({ error: 'name is required' });
        if (!url || !validateOutputUrl(url))
            return res
                .status(400)
                .json({ error: 'valid url is required (rtmp://, rtmps://, srt://)' });
        if (!ENCODINGS[videoEncoding])
            return res.status(400).json({ error: `unknown videoEncoding: ${videoEncoding}` });
        if (audioEncoding === null)
            return res.status(400).json({ error: 'invalid audioEncoding value' });

        const output = db.createOutput({ pipelineId, name, url, videoEncoding, audioEncoding });
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
        const videoEncoding =
            (req.body?.videoEncoding as string | undefined)?.trim() ?? output.videoEncoding;
        const audioEncoding = validateAudioEncoding(
            req.body?.audioEncoding ?? output.audioEncoding,
        );

        if (!name) return res.status(400).json({ error: 'name is required' });
        if (!validateOutputUrl(url)) return res.status(400).json({ error: 'valid url required' });
        if (!ENCODINGS[videoEncoding])
            return res.status(400).json({ error: `unknown videoEncoding: ${videoEncoding}` });
        if (audioEncoding === null)
            return res.status(400).json({ error: 'invalid audioEncoding value' });

        const updated = db.updateOutput(outId, { name, url, videoEncoding, audioEncoding });
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
