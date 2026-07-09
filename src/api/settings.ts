import type { Express } from 'express';
import type { Db, HostProbeTarget } from '../types.js';
import { normalizeIpWhitelist } from '../utils/ipValidation.js';
import type { ApplyWhitelistResult, GetBannedIpsResult } from '../services/fail2ban.js';

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

export function registerSettingsApi(
    app: Express,
    db: Db,
    applyIpWhitelist: (ips: string[]) => Promise<ApplyWhitelistResult>,
    getBannedIps: () => Promise<GetBannedIpsResult>,
): void {
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

    app.post('/api/settings/whitelist', async (req, res) => {
        const whitelistIps = normalizeIpWhitelist(req.body?.whitelistIps);
        if (whitelistIps === null) {
            return res.status(400).json({ error: 'Invalid IP whitelist' });
        }

        db.replaceWhitelistIps(whitelistIps);

        // Best-effort: the DB write above already succeeded regardless of
        // whether fail2ban is reachable, so a failure here is a dashboard
        // warning, not a failed save.
        const applyResult = await applyIpWhitelist(whitelistIps);

        return res.json({
            whitelistIps,
            whitelistApplied: applyResult.ok,
            whitelistError: applyResult.ok ? null : (applyResult.error ?? 'unknown error'),
        });
    });

    app.get('/api/settings/fail2ban-bans', async (_req, res) => {
        const result = await getBannedIps();
        return res.json(result);
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
