import type { Express } from 'express';
import { ENCODINGS } from '../utils/ffmpeg.js';
import { rtmpPublishUrl, srtPublishUrl } from '../utils/srs.js';
import { readSrsConfigValues } from '../utils/srsConfig.js';
import type { Db } from '../types.js';
import { readRelayConfig } from '../utils/relayConfig.js';

export function registerConfigApi(app: Express, db: Db): void {
    app.get('/api/config', (_req, res) => {
        // srtPassphrase feeds the bonding-relay URL (relay listener, port 10081);
        // direct SRT publish URLs go to SRS itself, which enforces its own
        // srt_server passphrase. The install script sets both to the same value,
        // but each URL must reflect the config its endpoint actually checks.
        const srtPassphrase = readRelayConfig().passphrase || null;
        const srsSrtPassphrase = readSrsConfigValues().srtPassphrase;
        const host = db.getSetting('publicHost') || 'localhost';
        const pipelines = db.listPipelines().map((p) => ({
            ...p,
            rtmpPublishUrl: rtmpPublishUrl(p.streamKey, host),
            srtPublishUrl: srtPublishUrl(p.streamKey, host, srsSrtPassphrase),
        }));
        res.json({
            configRev: db.getConfigRev(),
            pipelines,
            outputs: db.listOutputs(),
            hostProbeTargets: db.listHostProbeTargets(),
            encodings: Object.keys(ENCODINGS),
            streamKeys: db.listStreamKeys(),
            serverName: db.getSetting('serverName') ?? 'Restream SRS',
            srtPassphrase,
            publicHost: host,
        });
    });
}
