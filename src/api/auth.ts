import type { Express, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import type { Db } from '../types.js';

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const sessions = new Set<string>();

function hashPassword(password: string): string {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 32).toString('hex');
    return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
    const parts = stored.split(':');
    if (parts.length !== 2) return false;
    const [salt, hash] = parts;
    try {
        const newHash = crypto.scryptSync(password, salt, 32).toString('hex');
        return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(newHash, 'hex'));
    } catch {
        return false;
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

export function initializePassword(db: Db): void {
    if (!db.getSetting('dashboardPasswordHash')) {
        db.setSetting('dashboardPasswordHash', hashPassword('admin'));
    }
    db.pruneExpiredSessions(SESSION_MAX_AGE_MS);
    for (const token of db.listSessions()) {
        sessions.add(token);
    }
}

export function registerAuthApi(app: Express, db: Db): void {
    app.post('/api/auth/login', (req, res) => {
        const password = (req.body?.password as string | undefined) ?? '';
        const hash = db.getSetting('dashboardPasswordHash');
        if (!hash || !verifyPassword(password, hash)) {
            return res.status(401).json({ error: 'Incorrect password' });
        }
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

    app.post('/api/auth/change-password', requireAuth, (req, res) => {
        const currentPassword = (req.body?.currentPassword as string | undefined) ?? '';
        const newPassword = (req.body?.newPassword as string | undefined) ?? '';
        if (!newPassword) {
            return res.status(400).json({ error: 'New password cannot be empty' });
        }
        const hash = db.getSetting('dashboardPasswordHash');
        if (!hash || !verifyPassword(currentPassword, hash)) {
            return res.status(403).json({ error: 'Current password is incorrect' });
        }
        db.setSetting('dashboardPasswordHash', hashPassword(newPassword));
        return res.json({ ok: true });
    });
}
