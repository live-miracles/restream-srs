import type { Express } from 'express';
import { validateOutputUrl, validateAudioEncoding, ENCODINGS } from '../utils/ffmpeg.js';
import type { Db, TranslationInput } from '../types.js';
import type { OutputService } from '../services/outputs.js';
import type { HealthService } from '../services/health.js';
import { cyan } from '../utils/ansiColor.js';

// Validate an output's destination from the request body. It needs a valid URL
// and audio track selection; multiple tracks are only valid for an SRT
// destination since FLV/RTMP carries a single audio stream.
function parseDestination(
    body: unknown,
): { url: string; audioEncoding: string } | { error: string } {
    const b = body as Record<string, unknown> | null | undefined;
    const url = (b?.url as string | undefined)?.trim();
    if (!url || !validateOutputUrl(url)) {
        return { error: 'a valid url is required (rtmp://, rtmps://, srt://)' };
    }
    const audioEncoding = validateAudioEncoding(b?.audioEncoding);
    if (audioEncoding === null) {
        return { error: 'invalid audioEncoding' };
    }
    if (!url.startsWith('srt://') && audioEncoding.includes(',')) {
        return { error: 'multiple audio tracks require an SRT destination' };
    }
    return { url, audioEncoding };
}

function parseTranslation(body: unknown): TranslationInput | null | undefined | { error: string } {
    const raw = (body as Record<string, unknown> | null | undefined)?.translation;
    if (raw === undefined) return undefined;
    if (raw === null || raw === false) return null;
    if (typeof raw !== 'object') return { error: 'translation must be an object or null' };
    const value = raw as Record<string, unknown>;
    const rawTranslatorPipelineId = value.translatorPipelineId;
    const translatorPipelineId = Number(rawTranslatorPipelineId);
    if (
        (typeof rawTranslatorPipelineId !== 'number' &&
            typeof rawTranslatorPipelineId !== 'string') ||
        String(rawTranslatorPipelineId).trim() === '' ||
        !Number.isInteger(translatorPipelineId) ||
        translatorPipelineId <= 0
    ) {
        return { error: 'translation translatorPipelineId is required' };
    }
    const numeric = (key: string, min: number, max: number): number | string => {
        if (value[key] === undefined) return '';
        const n = Number(value[key]);
        return Number.isFinite(n) && n >= min && n <= max ? n : `${key} is invalid`;
    };
    const delay = numeric('translationDelayMs', 0, 5000);
    const thresholdDb = numeric('voiceThresholdDb', -100, 0);
    const duckVolumePercent = numeric('duckVolumePercent', 0, 100);
    const duckDurationMs = numeric('duckDurationMs', 0, 30000);
    const restoreSilenceMs = numeric('restoreSilenceMs', 0, 30000);
    const restoreVolumePercent = numeric('restoreVolumePercent', 0, 100);
    const restoreDurationMs = numeric('restoreDurationMs', 0, 30000);
    const restoreSilence2Ms = numeric('restoreSilence2Ms', 0, 60000);
    const restoreVolume2Percent = numeric('restoreVolume2Percent', 0, 100);
    const restoreDuration2Ms = numeric('restoreDuration2Ms', 0, 60000);
    if (typeof delay === 'string') return { error: delay };
    if (typeof thresholdDb === 'string') return { error: thresholdDb };
    if (typeof duckVolumePercent === 'string') return { error: duckVolumePercent };
    if (typeof duckDurationMs === 'string') return { error: duckDurationMs };
    if (typeof restoreSilenceMs === 'string') return { error: restoreSilenceMs };
    if (typeof restoreVolumePercent === 'string') return { error: restoreVolumePercent };
    if (typeof restoreDurationMs === 'string') return { error: restoreDurationMs };
    if (typeof restoreSilence2Ms === 'string') return { error: restoreSilence2Ms };
    if (restoreSilence2Ms < restoreSilenceMs) {
        return { error: 'restoreSilence2Ms must be greater than or equal to restoreSilenceMs' };
    }
    if (typeof restoreVolume2Percent === 'string') return { error: restoreVolume2Percent };
    if (typeof restoreDuration2Ms === 'string') return { error: restoreDuration2Ms };
    return {
        translatorPipelineId,
        ...(value.translationDelayMs === undefined ? {} : { translationDelayMs: delay }),
        ...(value.voiceThresholdDb === undefined ? {} : { voiceThresholdDb: thresholdDb }),
        ...(value.duckVolumePercent === undefined ? {} : { duckVolumePercent }),
        ...(value.duckDurationMs === undefined ? {} : { duckDurationMs }),
        ...(value.restoreSilenceMs === undefined ? {} : { restoreSilenceMs }),
        ...(value.restoreVolumePercent === undefined ? {} : { restoreVolumePercent }),
        ...(value.restoreDurationMs === undefined ? {} : { restoreDurationMs }),
        ...(value.restoreSilence2Ms === undefined ? {} : { restoreSilence2Ms }),
        ...(value.restoreVolume2Percent === undefined ? {} : { restoreVolume2Percent }),
        ...(value.restoreDuration2Ms === undefined ? {} : { restoreDuration2Ms }),
    };
}

export function registerOutputApi(
    app: Express,
    db: Db,
    outputService: OutputService,
    healthService: HealthService,
): void {
    app.post('/api/pipelines/:pipelineId/outputs', (req, res) => {
        const pipelineId = parseInt(req.params.pipelineId);
        if (isNaN(pipelineId)) return res.status(400).json({ error: 'invalid pipelineId' });
        if (!db.getPipeline(pipelineId))
            return res.status(404).json({ error: 'Pipeline not found' });

        const name = (req.body?.name as string | undefined)?.trim();
        const videoEncoding = (req.body?.videoEncoding as string | undefined)?.trim() || 'copy';
        const parsed = parseDestination(req.body);

        if (!name) return res.status(400).json({ error: 'name is required' });
        if (!ENCODINGS[videoEncoding])
            return res.status(400).json({ error: `unknown videoEncoding: ${videoEncoding}` });
        if ('error' in parsed) return res.status(400).json({ error: parsed.error });
        const translation = parseTranslation(req.body);
        if (translation && 'error' in translation) return res.status(400).json(translation);
        if (translation && !db.getPipeline(translation.translatorPipelineId)) {
            return res.status(400).json({ error: 'translation translator pipeline not found' });
        }
        if (translation && translation.translatorPipelineId === pipelineId) {
            return res
                .status(400)
                .json({ error: 'translation translator must be another pipeline' });
        }
        if (parsed.audioEncoding === 'translation' && !translation) {
            return res
                .status(400)
                .json({ error: 'translation audio requires translation settings' });
        }
        if (parsed.audioEncoding !== 'translation' && translation) {
            return res
                .status(400)
                .json({ error: 'translation settings require translation audio' });
        }

        let output: ReturnType<Db['createOutput']>;
        try {
            output = db.createOutput({
                pipelineId,
                name,
                videoEncoding,
                url: parsed.url,
                audioEncoding: parsed.audioEncoding,
                translation,
            });
        } catch (error) {
            console.error('[outputs] failed to create output:', error);
            return res.status(500).json({
                error: error instanceof Error ? error.message : 'could not create output',
            });
        }
        console.log(cyan(`[outputs] user add requested: ${output.id} (${output.name})`));
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

        const validated: {
            name: string;
            videoEncoding: string;
            url: string;
            audioEncoding: string;
        }[] = [];
        for (const item of rawOutputs) {
            const name = (item?.name as string | undefined)?.trim();
            const videoEncoding = (item?.videoEncoding as string | undefined)?.trim() || 'copy';
            const parsed = parseDestination(item);

            if (!name) return res.status(400).json({ error: 'each output must have a name' });
            if (!ENCODINGS[videoEncoding])
                return res.status(400).json({ error: `unknown videoEncoding: ${videoEncoding}` });
            if ('error' in parsed) return res.status(400).json({ error: parsed.error });

            validated.push({
                name,
                videoEncoding,
                url: parsed.url,
                audioEncoding: parsed.audioEncoding,
            });
        }

        const created = db.createOutputs(validated.map((v) => ({ pipelineId, ...v })));
        console.log(
            cyan(
                `[outputs] user add-bulk requested: pipeline=${pipelineId} count=${created.length}`,
            ),
        );
        return res.status(201).json(created);
    });

    app.post('/api/pipelines/:pipelineId/outputs/start-all', (req, res) => {
        const pipelineId = parseInt(req.params.pipelineId);
        if (isNaN(pipelineId)) return res.status(400).json({ error: 'invalid pipelineId' });
        if (!db.getPipeline(pipelineId))
            return res.status(404).json({ error: 'Pipeline not found' });

        db.setDesiredStateForPipeline(pipelineId, 'running');
        const scheduled = outputService.restartPipelineOutputs(pipelineId, 0);
        console.log(
            cyan(
                `[outputs] user start-all requested: pipeline=${pipelineId} scheduled=${scheduled}`,
            ),
        );
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
        console.log(
            cyan(
                `[outputs] user stop-all requested: pipeline=${pipelineId} count=${outputs.length}`,
            ),
        );
        return res.json({ ok: true });
    });

    app.post('/api/pipelines/:pipelineId/outputs/:outId', (req, res) => {
        const { pipelineId, outId } = req.params;
        const output = db.getOutput(outId);
        if (!output || output.pipelineId !== parseInt(pipelineId)) {
            return res.status(404).json({ error: 'Output not found' });
        }

        // The UI disables Save for running outputs, but a client holding stale
        // config could still submit — the running ffmpeg would keep the old
        // destination while the DB shows the new one until the next restart.
        if (
            output.desiredState !== 'stopped' ||
            outputService.getStats(outId).status === 'running'
        ) {
            return res.status(409).json({ error: 'Stop the output before editing it' });
        }

        const name = (req.body?.name as string | undefined)?.trim() ?? output.name;
        const videoEncoding =
            (req.body?.videoEncoding as string | undefined)?.trim() ?? output.videoEncoding;
        const parsed = parseDestination(req.body);

        if (!name) return res.status(400).json({ error: 'name is required' });
        if (!ENCODINGS[videoEncoding])
            return res.status(400).json({ error: `unknown videoEncoding: ${videoEncoding}` });
        if ('error' in parsed) return res.status(400).json({ error: parsed.error });
        const parsedTranslation = parseTranslation(req.body);
        if (parsedTranslation && 'error' in parsedTranslation)
            return res.status(400).json(parsedTranslation);
        // Preserve an existing translation when an older client omits the
        // optional field, but always clear it when switching to normal audio.
        const translation =
            parsedTranslation === undefined && parsed.audioEncoding === 'translation'
                ? output.translation
                : parsedTranslation;
        if (translation && !db.getPipeline(translation.translatorPipelineId)) {
            return res.status(400).json({ error: 'translation translator pipeline not found' });
        }
        if (translation && translation.translatorPipelineId === output.pipelineId) {
            return res
                .status(400)
                .json({ error: 'translation translator must be another pipeline' });
        }
        if (parsed.audioEncoding === 'translation' && !translation) {
            return res
                .status(400)
                .json({ error: 'translation audio requires translation settings' });
        }
        if (parsed.audioEncoding !== 'translation' && translation) {
            return res
                .status(400)
                .json({ error: 'translation settings require translation audio' });
        }

        let updated: ReturnType<Db['updateOutput']>;
        try {
            updated = db.updateOutput(outId, {
                name,
                videoEncoding,
                url: parsed.url,
                audioEncoding: parsed.audioEncoding,
                translation,
            });
        } catch (error) {
            console.error('[outputs] failed to update output:', error);
            return res.status(500).json({
                error: error instanceof Error ? error.message : 'could not update output',
            });
        }
        console.log(cyan(`[outputs] user update requested: ${outId} (${name})`));
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

        console.log(cyan(`[outputs] user delete requested: ${outId} (${output.name})`));
        await outputService.stopAndWait(outId);
        outputService.clearRetryState(outId);
        db.deleteOutput(outId);
        return res.json({ ok: true });
    });

    app.get('/api/pipelines/:pipelineId/outputs/:outId/errors', (req, res) => {
        const { pipelineId, outId } = req.params;
        const output = db.getOutput(outId);
        if (!output || output.pipelineId !== parseInt(pipelineId)) {
            return res.status(404).json({ error: 'Output not found' });
        }

        return res.json(db.getOutputErrorHistory(outId));
    });

    app.delete('/api/pipelines/:pipelineId/outputs/:outId/errors', (req, res) => {
        const { pipelineId, outId } = req.params;
        const output = db.getOutput(outId);
        if (!output || output.pipelineId !== parseInt(pipelineId)) {
            return res.status(404).json({ error: 'Output not found' });
        }

        db.clearOutputLastError(outId);
        healthService.clearOutputErrorInSnapshot(pipelineId, outId);
        return res.json({ ok: true });
    });

    app.post('/api/pipelines/:pipelineId/outputs/:outId/start', async (req, res) => {
        const { pipelineId, outId } = req.params;
        const output = db.getOutput(outId);
        if (!output || output.pipelineId !== parseInt(pipelineId)) {
            return res.status(404).json({ error: 'Output not found' });
        }

        console.log(cyan(`[outputs] user start requested: ${outId} (${output.name})`));
        try {
            db.setOutputDesiredState(outId, 'running');
            await outputService.start(outId);
            const stats = outputService.getStats(outId);
            return res.json({ ok: true, status: stats });
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

        console.log(cyan(`[outputs] user stop requested: ${outId} (${output.name})`));
        db.setOutputDesiredState(outId, 'stopped');
        outputService.stop(outId);
        return res.json({ ok: true });
    });
}
