import type { Express } from 'express';
import { ENCODINGS } from '../utils/ffmpeg.js';
import { rtmpPublishUrl, srtPublishUrl } from '../utils/srs.js';
import type { Db } from '../types.js';

export function registerConfigApi(app: Express, db: Db): void {
    app.get('/config', (_req, res) => {
        const srtPassphrase = db.getSetting('srtPassphrase') || null;
        const host = db.getSetting('publicHost') || 'localhost';
        const pipelines = db.listPipelines().map((p) => ({
            ...p,
            rtmpPublishUrl: rtmpPublishUrl(p.streamKey, host),
            srtPublishUrl: srtPublishUrl(p.streamKey, host, srtPassphrase),
        }));
        const outputs = db.listOutputs();
        const encodings = Object.keys(ENCODINGS);
        const streamKeys = db.listStreamKeys();
        const serverName = db.getSetting('serverName') ?? 'Restream SRS';
        res.json({
            pipelines,
            outputs,
            encodings,
            streamKeys,
            serverName,
            srtPassphrase,
            publicHost: host,
        });
    });
}
