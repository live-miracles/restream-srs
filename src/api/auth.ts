import type { Express, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import type { Db } from '../types.js';

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_PRUNE_INTERVAL_MS = 60 * 60 * 1000; // hourly

// Failed-login rate limit, per client IP. /api/auth/login is unauthenticated
// and internet-exposed, and each verify costs a scrypt — without a limit a
// password-guessing flood both brute-forces the single dashboard password and
// burns CPU. Successful logins reset the counter.
const LOGIN_WINDOW_MS = 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_BLOCK_MS = 5 * 60 * 1000;
const LOGIN_TRACKER_MAX_ENTRIES = 10_000;

interface LoginFailureState {
    count: number;
    windowStartMs: number;
    blockedUntilMs: number;
}

const loginFailures = new Map<string, LoginFailureState>();

const sessions = new Set<string>();

// scrypt runs on the libuv threadpool instead of the event loop. The sync
// variant would block the whole control plane (health poll, output retries,
// SRS hooks) for tens of ms per call — and login is unauthenticated, so that
// blocking would be attacker-triggerable.
function scryptAsync(password: string, salt: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, 32, (err, derivedKey) => {
            if (err) reject(err);
            else resolve(derivedKey);
        });
    });
}

async function hashPassword(password: string): Promise<string> {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = (await scryptAsync(password, salt)).toString('hex');
    return `${salt}:${hash}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
    const parts = stored.split(':');
    if (parts.length !== 2) return false;
    const [salt, hash] = parts;
    try {
        const newHash = (await scryptAsync(password, salt)).toString('hex');
        return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(newHash, 'hex'));
    } catch {
        return false;
    }
}

function clientIp(req: Request): string {
    return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

// Returns how many seconds the caller must still wait, or 0 if allowed.
function loginBlockedForSeconds(ip: string): number {
    const state = loginFailures.get(ip);
    if (!state) return 0;
    const remainingMs = state.blockedUntilMs - Date.now();
    return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
}

function noteLoginFailure(ip: string): void {
    // Opportunistic cleanup so the tracker cannot grow without bound under a
    // spoofed-source flood.
    if (loginFailures.size >= LOGIN_TRACKER_MAX_ENTRIES) {
        const now = Date.now();
        for (const [key, state] of loginFailures) {
            if (now - state.windowStartMs > LOGIN_WINDOW_MS && state.blockedUntilMs <= now) {
                loginFailures.delete(key);
            }
        }
    }

    const now = Date.now();
    const state = loginFailures.get(ip);
    if (!state || now - state.windowStartMs > LOGIN_WINDOW_MS) {
        loginFailures.set(ip, { count: 1, windowStartMs: now, blockedUntilMs: 0 });
        return;
    }
    state.count++;
    if (state.count >= LOGIN_MAX_FAILURES) {
        state.blockedUntilMs = now + LOGIN_BLOCK_MS;
    }
}

function getSessionToken(req: Request): string | null {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) return null;
    for (const part of cookieHeader.split(';')) {
        const [k, ...v] = part.trim().split('=');
        if (k.trim() === 'session') return v.join('=');
    }
    return null;
}

export function checkIsAuthenticated(req: Request): boolean {
    const token = getSessionToken(req);
    return token !== null && sessions.has(token);
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
    if (checkIsAuthenticated(req)) {
        next();
        return;
    }
    res.status(401).json({ error: 'Unauthorized' });
}

function pruneSessions(db: Db): void {
    db.pruneExpiredSessions(SESSION_MAX_AGE_MS);
    const alive = new Set(db.listSessions());
    for (const token of sessions) {
        if (!alive.has(token)) sessions.delete(token);
    }
}

export async function initializePassword(db: Db): Promise<void> {
    if (!db.getSetting('dashboardPasswordHash')) {
        db.setSetting('dashboardPasswordHash', await hashPassword('admin'));
    }
    pruneSessions(db);
    for (const token of db.listSessions()) {
        sessions.add(token);
    }
    // The 30-day session expiry was previously only enforced at boot, so on a
    // long-running server old session tokens stayed valid indefinitely.
    setInterval(() => pruneSessions(db), SESSION_PRUNE_INTERVAL_MS).unref();
}

export function registerAuthApi(app: Express, db: Db): void {
    app.post('/api/auth/login', async (req, res) => {
        const ip = clientIp(req);
        const retryAfterSec = loginBlockedForSeconds(ip);
        if (retryAfterSec > 0) {
            res.setHeader('Retry-After', String(retryAfterSec));
            return res
                .status(429)
                .json({ error: `Too many failed logins. Try again in ${retryAfterSec}s.` });
        }

        const password = (req.body?.password as string | undefined) ?? '';
        const hash = db.getSetting('dashboardPasswordHash');
        if (!hash || !(await verifyPassword(password, hash))) {
            // IP first, before anything attacker-influenced, so log-based
            // banning (fail2ban) can match on it reliably.
            console.warn(`[auth] client_ip=${ip} rejected login: incorrect password`);
            noteLoginFailure(ip);
            return res.status(401).json({ error: 'Incorrect password' });
        }
        loginFailures.delete(ip);
        const token = crypto.randomBytes(32).toString('hex');
        sessions.add(token);
        db.createSession(token);
        res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Path=/; SameSite=Strict`);
        return res.json({ ok: true });
    });

    app.post('/api/auth/logout', requireAuth, (req, res) => {
        const token = getSessionToken(req);
        if (token) {
            sessions.delete(token);
            db.deleteSession(token);
        }
        res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0');
        return res.json({ ok: true });
    });

    app.post('/api/auth/change-password', requireAuth, async (req, res) => {
        const currentPassword = (req.body?.currentPassword as string | undefined) ?? '';
        const newPassword = (req.body?.newPassword as string | undefined) ?? '';
        if (!newPassword) {
            return res.status(400).json({ error: 'New password cannot be empty' });
        }
        const hash = db.getSetting('dashboardPasswordHash');
        if (!hash || !(await verifyPassword(currentPassword, hash))) {
            return res.status(403).json({ error: 'Current password is incorrect' });
        }
        db.setSetting('dashboardPasswordHash', await hashPassword(newPassword));
        return res.json({ ok: true });
    });
}
