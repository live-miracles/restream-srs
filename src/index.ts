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
import {
    registerAuthApi,
    requireAuth,
    initializePassword,
    checkIsAuthenticated,
} from './api/auth.js';
import { writeSrsConf } from './utils/conf.js';

const app = express();
const PORT = parseInt(process.env.PORT || '8080');

app.use(express.json());

const db = createDb();
initializePassword(db);

const outputService = createOutputService(db);
const healthService = createHealthService(db, outputService);
const previewService = createPreviewService(db);

// Unauthenticated routes
registerSrsHooks(app, db);
registerAuthApi(app, db);

// Auth middleware for all remaining /api/* routes
app.use('/api', requireAuth);

registerConfigApi(app, db);
registerPipelineApi(app, db, outputService, previewService);
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

const serveIndexOrRedirect = (req: express.Request, res: express.Response): void => {
    if (checkIsAuthenticated(req)) {
        res.sendFile(path.join(publicDir, 'index.html'));
    } else {
        res.redirect('/login');
    }
};

app.get('/', serveIndexOrRedirect);
app.get('/index.html', serveIndexOrRedirect);

app.get('/login', (req, res) => {
    if (checkIsAuthenticated(req)) {
        res.redirect('/');
    } else {
        res.sendFile(path.join(publicDir, 'login.html'));
    }
});

app.use('/', express.static(publicDir));

async function main(): Promise<void> {
    const srtPassphrase = db.getSetting('srtPassphrase') || null;
    try {
        writeSrsConf(srtPassphrase);
        console.log('[conf] srs.conf written');
    } catch (e) {
        console.warn('[conf] could not write srs.conf:', e);
    }

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

let shuttingDown = false;
function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${signal} received, killing ffmpeg jobs`);
    outputService.shutdown();
    previewService.shutdown();
    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
    console.error('Fatal startup error:', err);
    process.exit(1);
});
