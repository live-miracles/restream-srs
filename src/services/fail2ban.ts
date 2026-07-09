import { execFile } from 'child_process';

const APPLY_SCRIPT = '/usr/local/sbin/restream-srs-fail2ban-apply';
const STATUS_SCRIPT = '/usr/local/sbin/restream-srs-fail2ban-status';
const APPLY_TIMEOUT_MS = 10_000;
const STATUS_TIMEOUT_MS = 10_000;

// Local pipeline outputs republish/replay through SRS over loopback (see
// rtmpPublishUrlLocal/srtPublishUrlLocal in api/config.ts), so a banned
// loopback address would take down internal relaying, not just some remote
// attacker. Always synced in addition to whatever the user configures, and
// never persisted to the DB or shown in the UI.
const ALWAYS_WHITELISTED_IPS = ['127.0.0.1', '::1'];

export interface ApplyWhitelistResult {
    ok: boolean;
    error?: string;
}

export interface Fail2banBan {
    ip: string;
    jail: string;
    bannedAt: number | null;
    unbanAt: number | null;
    reason: string | null;
}

export interface GetBannedIpsResult {
    ok: boolean;
    bans: Fail2banBan[];
    error?: string;
}

// Goes through sudo because restream-srs.service runs unprivileged
// (NoNewPrivileges) and has no other path to fail2ban's root-only control
// socket. `-n` makes sudo fail fast instead of hanging on a password prompt
// if the sudoers rule is ever missing.
export function applyIpWhitelist(ips: string[]): Promise<ApplyWhitelistResult> {
    const mergedIps = [...new Set([...ALWAYS_WHITELISTED_IPS, ...ips])];
    return new Promise((resolve) => {
        execFile(
            'sudo',
            ['-n', APPLY_SCRIPT, 'sync', ...mergedIps],
            { timeout: APPLY_TIMEOUT_MS },
            (err, _stdout, stderr) => {
                if (err) {
                    const detail = stderr.trim() || err.message;
                    console.warn(`[fail2ban] failed to apply IP whitelist: ${detail}`);
                    resolve({ ok: false, error: detail });
                    return;
                }
                resolve({ ok: true });
            },
        );
    });
}

// Goes through sudo for the same reason as applyIpWhitelist above: the fail2ban
// control socket and its ban database are root-only. The status script queries
// both (currently-banned IPs via `fail2ban-client status`, and their ban/unban
// timestamps + triggering log line via fail2ban's own sqlite database) and
// returns them as one JSON blob so this only needs a single sudo round trip.
export function getBannedIps(): Promise<GetBannedIpsResult> {
    return new Promise((resolve) => {
        execFile(
            'sudo',
            ['-n', STATUS_SCRIPT],
            { timeout: STATUS_TIMEOUT_MS },
            (err, stdout, stderr) => {
                if (err) {
                    const detail = stderr.trim() || err.message;
                    console.warn(`[fail2ban] failed to list banned IPs: ${detail}`);
                    resolve({ ok: false, bans: [], error: detail });
                    return;
                }
                try {
                    const bans = JSON.parse(stdout) as Fail2banBan[];
                    resolve({ ok: true, bans });
                } catch {
                    resolve({ ok: false, bans: [], error: 'invalid response from status script' });
                }
            },
        );
    });
}
