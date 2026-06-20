import type { Express } from 'express';
import type { PreviewService } from '../services/preview.js';
import { SRS_HLS_BASE } from '../utils/srs.js';

// SRS HLS assets are `<streamKey>.m3u8` and `<streamKey>-<seq>.ts`. The playlist
// references segments by bare filename, so hls.js resolves them against the
// proxy path — both land back on this route.
const HLS_ASSET_RE = /^[A-Za-z0-9_]+(?:-\d+)?\.(m3u8|ts)$/;

export function registerPreviewApi(app: Express, previewService: PreviewService): void {
    // Proxy SRS's native HLS (served on its own http_server port) through the app
    // so the browser stays same-origin and SRS's port need not be exposed.
    app.get('/api/preview/hls/:asset', async (req, res) => {
        const asset = String(req.params.asset || '');
        const m = HLS_ASSET_RE.exec(asset);
        if (!m) return res.status(400).end();
        try {
            // Forward hls_ctx and any other query params SRS requires for session tracking
            const qs = new URLSearchParams(req.query as Record<string, string>).toString();
            const upstream = await fetch(`${SRS_HLS_BASE}/${asset}${qs ? '?' + qs : ''}`, {
                signal: AbortSignal.timeout(5000),
            });
            if (!upstream.ok) return res.status(upstream.status).end();
            res.setHeader('Cache-Control', 'no-cache');
            if (m[1] === 'm3u8') {
                // SRS serves a master playlist with absolute /live/... paths. Rewrite
                // them through this proxy so hls.js stays same-origin and the hls_ctx
                // token is preserved in subsequent segment requests.
                const body = (await upstream.text()).replace(/\/live\//g, '/api/preview/hls/');
                res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
                res.end(body);
            } else {
                res.setHeader('Content-Type', 'video/mp2t');
                res.end(Buffer.from(await upstream.arrayBuffer()));
            }
        } catch {
            res.status(502).end();
        }
    });

    app.post('/api/pipelines/:id/preview/start', async (req, res) => {
        const id = parseInt(req.params.id);
        if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });

        const rawCount = req.body?.audioTrackCount;
        const audioTrackCount =
            typeof rawCount === 'number' && Number.isInteger(rawCount) && rawCount >= 1
                ? rawCount
                : 1;

        try {
            return res.json(await previewService.start(id, audioTrackCount));
        } catch (err) {
            return res.status(500).json({ error: String(err) });
        }
    });

    app.post('/api/pipelines/:id/preview/stop', (req, res) => {
        const id = parseInt(req.params.id);
        if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
        previewService.stop(id);
        return res.json({ ok: true });
    });
}
