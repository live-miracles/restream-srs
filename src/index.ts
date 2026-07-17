import express from 'express';
import compression from 'compression';
import path from 'path';
import { createDb } from './db/index.js';
import { createOutputService } from './services/outputs.js';
import { createSrtRelayService } from './services/srtRelay.js';
import { createHealthService } from './services/health.js';
import { registerPipelineApi } from './api/pipelines.js';
import { registerOutputApi } from './api/outputs.js';
import { registerConfigApi } from './api/config.js';
import { registerMetricsApi } from './api/metrics.js';
import { registerSettingsApi } from './api/settings.js';
import { createPreviewService } from './services/preview.js';
import { registerPreviewApi } from './api/preview.js';
import { registerSrsHooks, registerSrsLogsApi } from './api/srs.js';
import { createInputState } from './services/inputState.js';
import {
    registerAuthApi,
    requireAuth,
    initializePassword,
    checkIsAuthenticated,
} from './api/auth.js';
import { registerVersionApi } from './api/version.js';
import { readAppConfig } from './utils/appConfig.js';
import { createHostProbeService } from './services/hostProbes.js';

const app = express();
const PORT = readAppConfig().port;

// gzip responses. The /api/config and /api/health JSON for 50 inputs / 500
// outputs is large and re-fetched by every dashboard client on the 5s poll;
// JSON compresses very well, so this cuts response size and bandwidth sharply.
app.use(
    compression({
        // HLS playlists/segments are latency-sensitive live media; letting a
        // proxy/browser transform or buffer them like normal text/static assets
        // increases the odds of stale manifest reuse and live-edge stalls.
        filter(req, res) {
            if (req.path.startsWith('/hls/')) return false;
            return compression.filter(req, res);
        },
    }),
);
app.use(express.json());

const db = createDb();

const inputState = createInputState();
const outputService = createOutputService(db, inputState);
const srtRelayService = createSrtRelayService();
const healthService = createHealthService(db, outputService, srtRelayService, inputState);
const previewService = createPreviewService(db, inputState);
const hostProbeService = createHostProbeService(db);

// Unauthenticated routes
registerSrsHooks(app, db);
registerAuthApi(app, db);

// Auth middleware for all remaining /api/* routes
app.use('/api', requireAuth);

registerConfigApi(app, db);
registerPipelineApi(app, db, outputService, previewService, srtRelayService);
registerOutputApi(app, db, outputService);
registerPreviewApi(app, previewService);
registerSettingsApi(app, db);
registerVersionApi(app);
registerMetricsApi(app);
healthService.registerRoutes(app);
hostProbeService.registerRoutes(app);
registerSrsLogsApi(app, healthService.getSrsEvents);

app.use(
    '/hls',
    (_req, res, next) => {
        // Live HLS must never be cached by browsers or intermediaries; a stale
        // manifest is enough to make playback freeze on every refresh and then
        // fall out of the live window entirely.
        res.setHeader(
            'Cache-Control',
            'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0, no-transform',
        );
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Surrogate-Control', 'no-store');
        next();
    },
    express.static(previewService.baseDir, {
        etag: false,
        lastModified: false,
    }),
);

const publicDir = path.join(__dirname, '..', 'public');

const serveIndexOrRedirect = (req: express.Request, res: express.Response): void => {
    if (checkIsAuthenticated(req)) {
        res.setHeader('Cache-Control', 'no-store');
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
        res.setHeader('Cache-Control', 'no-store');
        res.sendFile(path.join(publicDir, 'login.html'));
    }
});

app.use(
    '/',
    express.static(publicDir, {
        setHeaders(res, filePath) {
            if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
                res.setHeader('Cache-Control', 'no-cache');
            }
        },
    }),
);

async function main(): Promise<void> {
    // Must finish before listen(): seeds the default password hash and loads
    // persisted sessions, which the auth middleware consults on every request.
    await initializePassword(db);

    srtRelayService.start();
    healthService.start();
    hostProbeService.start();

    app.listen(PORT, () => {
        console.log(`[server] listening on http://0.0.0.0:${PORT}`);
    });
}

let shuttingDown = false;
function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${signal} received, killing media jobs`);
    outputService.shutdown();
    healthService.shutdown();
    srtRelayService.shutdown();
    previewService.shutdown();
    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
    console.error('Fatal startup error:', err);
    process.exit(1);
});
