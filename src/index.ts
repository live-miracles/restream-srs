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
import { registerSrsHooks, registerSrsLogsApi } from './api/srs.js';
import {
    registerAuthApi,
    requireAuth,
    initializePassword,
    checkIsAuthenticated,
} from './api/auth.js';
import { registerVersionApi } from './api/version.js';
import { writeSrsConf } from './utils/conf.js';

const app = express();
const PORT = parseInt(process.env.PORT || '8080');

app.use(express.json());

const db = createDb();
initializePassword(db);

const outputService = createOutputService(db);
const healthService = createHealthService(db, outputService);
const previewService = createPreviewService(db);

// Outputs only start ffmpeg when the input is live and SRS is reachable.
outputService.setInputReadyCheck(healthService.isInputReady);

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
registerVersionApi(app);
registerMetricsApi(app);
healthService.registerRoutes(app);
registerSrsLogsApi(app, healthService.getSrsEvents);

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
    writeSrsConf(db.getSetting('srtPassphrase') || null);

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
