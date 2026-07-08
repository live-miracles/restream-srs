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

export function registerSettingsApi(app: Express, db: Db): void {
    app.post('/api/settings', (req, res) => {
        const name = (req.body?.name as string | undefined)?.trim();
        const publicHost = (req.body?.publicHost as string | undefined)?.trim() ?? null;
        const hostProbeTargets = normalizeHostProbeTargets(req.body?.hostProbeTargets);

        if (!name) return res.status(400).json({ error: 'name is required' });
        if (hostProbeTargets === null) {
            return res.status(400).json({ error: 'Invalid host probe target configuration' });
        }

        db.setSetting('serverName', name);
        if (publicHost !== null) db.setSetting('publicHost', publicHost);
        db.replaceHostProbeTargets(hostProbeTargets);

        return res.json({
            serverName: name,
            publicHost: publicHost ?? db.getSetting('publicHost') ?? 'localhost',
            hostProbeTargets,
            pending: false,
        });
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
