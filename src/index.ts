import express from 'express';
import path from 'path';
import { createDb } from './db/index.js';
import { createOutputService } from './services/outputs.js';
import { createHealthService } from './services/health.js';
import { registerPipelineApi } from './api/pipelines.js';
import { registerOutputApi } from './api/outputs.js';
import { registerConfigApi } from './api/config.js';
import { registerMetricsApi } from './api/metrics.js';
import { registerSettingsApi } from './api/settings.js';
import { createPreviewService } from './services/preview.js';
import { registerPreviewApi } from './api/preview.js';
import { registerSrsHooks } from './api/srs-hooks.js';

const app = express();
const PORT = parseInt(process.env.PORT || '8080');

app.use(express.json());

const db = createDb();
const outputService = createOutputService(db);
const healthService = createHealthService(db, outputService);
const previewService = createPreviewService(db);

registerSrsHooks(app, db);
registerConfigApi(app, db);
registerPipelineApi(app, db, outputService);
registerOutputApi(app, db, outputService);
registerPreviewApi(app, previewService);
registerSettingsApi(app, db);
registerMetricsApi(app);
healthService.registerRoutes(app);

app.use(
    '/hls',
    (_req, res, next) => {
        res.setHeader('Cache-Control', 'no-cache');
        next();
    },
    express.static(previewService.baseDir),
);

const publicDir = path.join(__dirname, '..', 'public');
app.use('/', express.static(publicDir));

async function main(): Promise<void> {
    const allOutputs = db.listOutputs();
    for (const output of allOutputs) {
        if (output.desiredState === 'running') {
            outputService.start(output.id).catch(() => {
                /* will retry */
            });
        }
    }

    healthService.start();

    app.listen(PORT, () => {
        console.log(`[server] listening on http://0.0.0.0:${PORT}`);
    });
}

main().catch((err) => {
    console.error('Fatal startup error:', err);
    process.exit(1);
});
