import type { Express } from 'express';
import type { Db, HostProbeTarget } from '../types.js';

const MAX_HOST_PROBE_TARGETS = 10;

function normalizeHostProbeTargets(value: unknown): HostProbeTarget[] | null {
    if (!Array.isArray(value)) return [];

    const targets: HostProbeTarget[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') return null;
        const row = item as Record<string, unknown>;
        const slot = Number(row.slot);
        const label = typeof row.label === 'string' ? row.label.trim() : '';
        const host = typeof row.host === 'string' ? row.host.trim() : '';
        const port = Number(row.port);

        if (!Number.isInteger(slot) || slot < 1 || slot > MAX_HOST_PROBE_TARGETS) return null;
        if (!label || !host) return null;
        if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

        targets.push({ slot, label, host, port });
    }

    if (targets.length > MAX_HOST_PROBE_TARGETS) return null;
    if (new Set(targets.map((target) => target.slot)).size !== targets.length) return null;
    return targets.sort((a, b) => a.slot - b.slot);
}

// Custom pipeline/output display order: [{id: <pipelineId>, outs: [<outputId>, ...]}].
// This is a pure UI concern — the backend only stores and returns it verbatim;
// it never reorders pipelines/outputs itself or keeps this in sync with
// creates/deletes. The frontend reconciles it against the current pipeline/
// output list at render time (anything missing here just sorts to the end),
// so stale or incomplete entries (deleted pipelines, new ones never dragged)
// are harmless and self-heal on the next read.
function normalizeLayoutOrder(value: unknown): { id: number; outs: string[] }[] | null {
    if (!Array.isArray(value)) return null;

    const order: { id: number; outs: string[] }[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') return null;
        const row = item as Record<string, unknown>;
        if (!Number.isInteger(row.id)) return null;
        if (!Array.isArray(row.outs) || !row.outs.every((o) => typeof o === 'string')) return null;
        order.push({ id: row.id as number, outs: row.outs as string[] });
    }
    return order;
}

export function registerSettingsApi(app: Express, db: Db): void {
    app.post('/api/settings/general', (req, res) => {
        const name = (req.body?.name as string | undefined)?.trim();
        const publicHost = (req.body?.publicHost as string | undefined)?.trim() ?? null;

        if (!name) return res.status(400).json({ error: 'name is required' });

        db.setSetting('serverName', name);
        if (publicHost !== null) db.setSetting('publicHost', publicHost);

        return res.json({
            serverName: name,
            publicHost: publicHost ?? db.getSetting('publicHost') ?? 'localhost',
        });
    });

    app.post('/api/settings/host-probes', (req, res) => {
        const hostProbeTargets = normalizeHostProbeTargets(req.body?.hostProbeTargets);
        if (hostProbeTargets === null) {
            return res.status(400).json({ error: 'Invalid host probe target configuration' });
        }

        db.replaceHostProbeTargets(hostProbeTargets);

        return res.json({ hostProbeTargets });
    });

    app.post('/api/settings/layout-order', (req, res) => {
        const order = normalizeLayoutOrder(req.body?.order);
        if (order === null) {
            return res.status(400).json({ error: 'Invalid layout order' });
        }

        db.setSetting('layoutOrder', JSON.stringify(order));
        return res.json({ layoutOrder: order });
    });

    app.post('/api/settings/regenerate-stream-keys', (req, res) => {
        const pipelines = db.listPipelines();
        if (pipelines.length > 0) {
            return res
                .status(409)
                .json({ error: 'Cannot regenerate stream keys while pipelines exist' });
        }
        const streamKeys = db.regenerateStreamKeys();
        return res.json({ streamKeys });
    });
}
