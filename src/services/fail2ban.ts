import { execFile } from 'child_process';

const APPLY_SCRIPT = '/usr/local/sbin/restream-srs-fail2ban-apply';
const APPLY_TIMEOUT_MS = 10_000;

export interface ApplyWhitelistResult {
    ok: boolean;
    error?: string;
}

// Goes through sudo because restream-srs.service runs unprivileged
// (NoNewPrivileges) and has no other path to fail2ban's root-only control
// socket. `-n` makes sudo fail fast instead of hanging on a password prompt
// if the sudoers rule is ever missing.
export function applyIpWhitelist(ips: string[]): Promise<ApplyWhitelistResult> {
    return new Promise((resolve) => {
        execFile(
            'sudo',
            ['-n', APPLY_SCRIPT, 'sync', ...ips],
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
