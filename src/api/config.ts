import type { Express } from 'express';
import { ENCODINGS } from '../utils/ffmpeg.js';
import { rtmpPublishUrl, srtPublishUrl } from '../utils/srs.js';
import type { Db } from '../types.js';

export function registerConfigApi(app: Express, db: Db): void {
    app.get('/api/config', (_req, res) => {
        const srtPassphrase = db.getSetting('srtPassphrase') || null;
        const host = db.getSetting('publicHost') || 'localhost';
        const pipelines = db.listPipelines().map((p) => ({
            ...p,
            rtmpPublishUrl: rtmpPublishUrl(p.streamKey, host),
            srtPublishUrl: srtPublishUrl(p.streamKey, host, srtPassphrase),
        }));
        res.json({
            configRev: db.getConfigRev(),
            pipelines,
            outputs: db.listOutputs(),
            encodings: Object.keys(ENCODINGS),
            streamKeys: db.listStreamKeys(),
            serverName: db.getSetting('serverName') ?? 'Restream SRS',
            srtPassphrase,
            publicHost: host,
        });
    });
}
