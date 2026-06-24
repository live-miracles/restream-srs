import type { Express } from 'express';
import { validateOutputUrl, validateAudioEncoding, ENCODINGS } from '../utils/ffmpeg.js';
import type { Db, SinkInput } from '../types.js';
import type { OutputService } from '../services/outputs.js';

// Validate the sinks array from the request body. Each sink needs a valid URL
// and audio track selection; multiple tracks are only valid for SRT sinks since
// FLV/RTMP carries a single audio stream.
function parseSinks(raw: unknown): { sinks: SinkInput[] } | { error: string } {
    if (!Array.isArray(raw) || raw.length === 0) {
        return { error: 'at least one sink is required' };
    }
    const sinks: SinkInput[] = [];
    for (const item of raw) {
        const url = (item?.url as string | undefined)?.trim();
        if (!url || !validateOutputUrl(url)) {
            return { error: 'each sink needs a valid url (rtmp://, rtmps://, srt://)' };
        }
        const audioEncoding = validateAudioEncoding(item?.audioEncoding);
        if (audioEncoding === null) {
            return { error: `invalid audioEncoding for sink ${url}` };
        }
        if (!url.startsWith('srt://') && audioEncoding.includes(',')) {
            return { error: 'multiple audio tracks require an SRT sink' };
        }
        sinks.push({ url, audioEncoding });
    }
    const firstIsSrt = sinks[0].url.startsWith('srt://');
    if (!sinks.every((s) => s.url.startsWith('srt://') === firstIsSrt)) {
        return { error: 'all sinks must be the same protocol (SRT or RTMP)' };
    }
    return { sinks };
}

export function registerOutputApi(app: Express, db: Db, outputService: OutputService): void {
    app.post('/api/pipelines/:pipelineId/outputs', (req, res) => {
        const pipelineId = parseInt(req.params.pipelineId);
        if (isNaN(pipelineId)) return res.status(400).json({ error: 'invalid pipelineId' });
        if (!db.getPipeline(pipelineId))
            return res.status(404).json({ error: 'Pipeline not found' });

        const name = (req.body?.name as string | undefined)?.trim();
        const videoEncoding = (req.body?.videoEncoding as string | undefined)?.trim() || 'copy';
        const parsed = parseSinks(req.body?.sinks);

        if (!name) return res.status(400).json({ error: 'name is required' });
        if (!ENCODINGS[videoEncoding])
            return res.status(400).json({ error: `unknown videoEncoding: ${videoEncoding}` });
        if ('error' in parsed) return res.status(400).json({ error: parsed.error });

        const output = db.createOutput({
            pipelineId,
            name,
            videoEncoding,
            sinks: parsed.sinks,
        });
        return res.status(201).json(output);
    });

    app.post('/api/pipelines/:pipelineId/outputs/bulk', (req, res) => {
        const pipelineId = parseInt(req.params.pipelineId);
        if (isNaN(pipelineId)) return res.status(400).json({ error: 'invalid pipelineId' });
        if (!db.getPipeline(pipelineId))
            return res.status(404).json({ error: 'Pipeline not found' });

        const rawOutputs = req.body?.outputs;
        if (!Array.isArray(rawOutputs) || rawOutputs.length === 0)
            return res.status(400).json({ error: 'outputs array is required' });

        const validated: { name: string; videoEncoding: string; sinks: SinkInput[] }[] = [];
        for (const item of rawOutputs) {
            const name = (item?.name as string | undefined)?.trim();
            const videoEncoding = (item?.videoEncoding as string | undefined)?.trim() || 'copy';
            const parsed = parseSinks(item?.sinks);

            if (!name) return res.status(400).json({ error: 'each output must have a name' });
            if (!ENCODINGS[videoEncoding])
                return res.status(400).json({ error: `unknown videoEncoding: ${videoEncoding}` });
            if ('error' in parsed) return res.status(400).json({ error: parsed.error });

            validated.push({ name, videoEncoding, sinks: parsed.sinks });
        }

        const created = validated.map((v) => db.createOutput({ pipelineId, ...v }));
        return res.status(201).json(created);
    });

    app.post('/api/pipelines/:pipelineId/outputs/start-all', (req, res) => {
        const pipelineId = parseInt(req.params.pipelineId);
        if (isNaN(pipelineId)) return res.status(400).json({ error: 'invalid pipelineId' });
        if (!db.getPipeline(pipelineId))
            return res.status(404).json({ error: 'Pipeline not found' });

        db.setDesiredStateForPipeline(pipelineId, 'running');
        db.clearLastErrorsForPipeline(pipelineId);
        const scheduled = outputService.restartPipelineOutputs(pipelineId);
        return res.json({ ok: true, scheduled });
    });

    app.post('/api/pipelines/:pipelineId/outputs/stop-all', (req, res) => {
        const pipelineId = parseInt(req.params.pipelineId);
        if (isNaN(pipelineId)) return res.status(400).json({ error: 'invalid pipelineId' });
        if (!db.getPipeline(pipelineId))
            return res.status(404).json({ error: 'Pipeline not found' });

        const outputs = db.listOutputsForPipeline(pipelineId);
        db.setDesiredStateForPipeline(pipelineId, 'stopped');
        for (const o of outputs) outputService.stop(o.id);
        return res.json({ ok: true });
    });

    app.post('/api/pipelines/:pipelineId/outputs/:outId', (req, res) => {
        const { pipelineId, outId } = req.params;
        const output = db.getOutput(outId);
        if (!output || output.pipelineId !== parseInt(pipelineId)) {
            return res.status(404).json({ error: 'Output not found' });
        }

        const name = (req.body?.name as string | undefined)?.trim() ?? output.name;
        const videoEncoding =
            (req.body?.videoEncoding as string | undefined)?.trim() ?? output.videoEncoding;
        const parsed = parseSinks(req.body?.sinks);

        if (!name) return res.status(400).json({ error: 'name is required' });
        if (!ENCODINGS[videoEncoding])
            return res.status(400).json({ error: `unknown videoEncoding: ${videoEncoding}` });
        if ('error' in parsed) return res.status(400).json({ error: parsed.error });

        const updated = db.updateOutput(outId, {
            name,
            videoEncoding,
            sinks: parsed.sinks,
        });
        return res.json(updated);
    });

    app.delete('/api/pipelines/:pipelineId/outputs', (req, res) => {
        const pipelineId = parseInt(req.params.pipelineId);
        if (isNaN(pipelineId)) return res.status(400).json({ error: 'invalid pipelineId' });
        if (!db.getPipeline(pipelineId))
            return res.status(404).json({ error: 'Pipeline not found' });

        const outputs = db.listOutputsForPipeline(pipelineId);
        for (const o of outputs) {
            if (o.desiredState !== 'stopped' || outputService.getStats(o.id).status === 'running') {
                return res.status(409).json({
                    error: `Output "${o.name}" is still running. Stop all outputs before clearing.`,
                });
            }
        }

        db.deleteOutputsForPipeline(pipelineId);
        return res.json({ ok: true });
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
            db.clearOutputLastError(outId);
            await outputService.start(outId);
            return res.json({ ok: true, status: outputService.getStats(outId) });
        } catch (err) {
            try {
                db.setOutputDesiredState(outId, 'stopped');
            } catch {
                /* best-effort */
            }
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
