import type { Express } from 'express';
import { validateOutputUrl, validateAudioEncoding, ENCODINGS } from '../utils/ffmpeg.js';
import type { Db, PullMethod, SinkInput } from '../types.js';
import type { OutputService } from '../services/outputs.js';

function parsePullMethod(value: unknown): PullMethod {
    return value === 'srt' ? 'srt' : 'rtmp';
}

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
        const pullMethod = parsePullMethod(req.body?.pullMethod);
        const parsed = parseSinks(req.body?.sinks);

        if (!name) return res.status(400).json({ error: 'name is required' });
        if (!ENCODINGS[videoEncoding])
            return res.status(400).json({ error: `unknown videoEncoding: ${videoEncoding}` });
        if ('error' in parsed) return res.status(400).json({ error: parsed.error });

        const output = db.createOutput({
            pipelineId,
            name,
            videoEncoding,
            pullMethod,
            sinks: parsed.sinks,
        });
        return res.status(201).json(output);
    });

    app.post('/api/pipelines/:pipelineId/outputs/:outId', (req, res) => {
        const { pipelineId, outId } = req.params;
        const output = db.listOutputsForPipeline(parseInt(pipelineId)).find((o) => o.id === outId);
        if (!output) {
            return res.status(404).json({ error: 'Output not found' });
        }

        const name = (req.body?.name as string | undefined)?.trim() ?? output.name;
        const videoEncoding =
            (req.body?.videoEncoding as string | undefined)?.trim() ?? output.videoEncoding;
        const pullMethod = parsePullMethod(req.body?.pullMethod ?? output.pullMethod);
        const parsed = parseSinks(req.body?.sinks);

        if (!name) return res.status(400).json({ error: 'name is required' });
        if (!ENCODINGS[videoEncoding])
            return res.status(400).json({ error: `unknown videoEncoding: ${videoEncoding}` });
        if ('error' in parsed) return res.status(400).json({ error: parsed.error });

        const updated = db.updateOutput(outId, {
            name,
            videoEncoding,
            pullMethod,
            sinks: parsed.sinks,
        });
        return res.json(updated);
    });

    app.delete('/api/pipelines/:pipelineId/outputs/:outId', async (req, res) => {
        const { pipelineId, outId } = req.params;
        const output = db.listOutputsForPipeline(parseInt(pipelineId)).find((o) => o.id === outId);
        if (!output) {
            return res.status(404).json({ error: 'Output not found' });
        }

        await outputService.stopAndWait(outId);
        outputService.clearRetryState(outId);
        db.deleteOutput(outId);
        return res.json({ ok: true });
    });

    app.post('/api/pipelines/:pipelineId/outputs/:outId/start', async (req, res) => {
        const { pipelineId, outId } = req.params;
        const output = db.listOutputsForPipeline(parseInt(pipelineId)).find((o) => o.id === outId);
        if (!output) {
            return res.status(404).json({ error: 'Output not found' });
        }

        try {
            db.setOutputDesiredState(outId, 'running');
            await outputService.start(outId);
            try {
                db.appendOutputLog(outId, 'start', 'User started output');
            } catch {
                /* non-critical */
            }
            return res.json({ ok: true, status: outputService.getStats(outId) });
        } catch (err) {
            return res.status(400).json({ error: (err as Error).message });
        }
    });

    app.post('/api/pipelines/:pipelineId/outputs/:outId/stop', async (req, res) => {
        const { pipelineId, outId } = req.params;
        const output = db.listOutputsForPipeline(parseInt(pipelineId)).find((o) => o.id === outId);
        if (!output) {
            return res.status(404).json({ error: 'Output not found' });
        }

        db.setOutputDesiredState(outId, 'stopped');
        outputService.stop(outId);
        try {
            db.appendOutputLog(outId, 'stop', 'User stopped output');
        } catch {
            /* non-critical */
        }
        return res.json({ ok: true });
    });

    app.get('/api/pipelines/:pipelineId/outputs/:outId/logs', (req, res) => {
        const { pipelineId, outId } = req.params;
        const output = db.listOutputsForPipeline(parseInt(pipelineId)).find((o) => o.id === outId);
        if (!output) {
            return res.status(404).json({ error: 'Output not found' });
        }
        return res.json(db.getOutputLogs(outId));
    });
}
