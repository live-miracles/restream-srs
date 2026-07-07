'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { Readable, Writable } = require('node:stream');

class MockRequest extends Readable {
    constructor(method, url, body, ip = '127.0.0.1') {
        super();
        this.method = method;
        this.url = url;
        this.headers = {};
        this.socket = { remoteAddress: ip };
        this.connection = this.socket;
        this.body = body;
    }

    _read() {
        this.push(null);
    }
}

class MockResponse extends Writable {
    constructor(resolve) {
        super();
        this.statusCode = 200;
        this.headers = {};
        this.chunks = [];
        this.resolve = resolve;
        this.setHeader = (name, value) => {
            this.headers[String(name).toLowerCase()] = value;
        };
        this.getHeader = (name) => this.headers[String(name).toLowerCase()];
        this.removeHeader = (name) => {
            delete this.headers[String(name).toLowerCase()];
        };
        this.writeHead = (statusCode, headers = {}) => {
            this.statusCode = statusCode;
            for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
            return this;
        };
        this.end = (chunk, encoding, callback) => {
            if (chunk) this.chunks.push(Buffer.from(chunk, encoding));
            const text = Buffer.concat(this.chunks).toString('utf8');
            this.resolve({
                status: this.statusCode,
                headers: this.headers,
                body: text ? JSON.parse(text) : undefined,
            });
            if (callback) callback();
            return this;
        };
    }

    _write(chunk, _encoding, callback) {
        this.chunks.push(Buffer.from(chunk));
        callback();
    }
}

function dispatch(app, method, route, body, ip) {
    return new Promise((resolve, reject) => {
        app.handle(new MockRequest(method, route, body, ip), new MockResponse(resolve), reject);
    });
}

function makeDb() {
    const settings = new Map();
    const sessionRows = new Map();
    return {
        getSetting: (key) => settings.get(key) ?? null,
        setSetting: (key, value) => settings.set(key, value),
        createSession: (token) => sessionRows.set(token, Date.now()),
        deleteSession: (token) => sessionRows.delete(token),
        listSessions: () => [...sessionRows.keys()],
        pruneExpiredSessions: (maxAgeMs) => {
            const cutoff = Date.now() - maxAgeMs;
            for (const [token, createdAt] of sessionRows) {
                if (createdAt < cutoff) sessionRows.delete(token);
            }
        },
    };
}

// The auth module keeps sessions and the login rate limiter in module state,
// so each test loads a fresh copy.
async function createHarness() {
    delete require.cache[require.resolve('../../src/api/auth')];
    const { registerAuthApi, initializePassword } = require('../../src/api/auth');
    const app = express();
    const db = makeDb();
    await initializePassword(db);
    registerAuthApi(app, db);
    return {
        login: (password, ip) => dispatch(app, 'POST', '/api/auth/login', { password }, ip),
    };
}

describe('auth login integration', () => {
    beforeEach(() => {
        delete require.cache[require.resolve('../../src/api/auth')];
    });

    test('accepts the correct password and sets a session cookie', async () => {
        const harness = await createHarness();

        const res = await harness.login('admin');

        assert.equal(res.status, 200);
        assert.deepEqual(res.body, { ok: true });
        assert.match(res.headers['set-cookie'], /^session=[0-9a-f]{64}; HttpOnly/);
    });

    test('rejects a wrong password', async () => {
        const harness = await createHarness();

        const res = await harness.login('wrong');

        assert.equal(res.status, 401);
    });

    test('blocks an IP after repeated failures, others unaffected', async () => {
        const harness = await createHarness();

        for (let i = 0; i < 5; i++) {
            const res = await harness.login('wrong', '203.0.113.9');
            assert.equal(res.status, 401);
        }

        // Even the correct password is refused while the IP is blocked.
        const blocked = await harness.login('admin', '203.0.113.9');
        assert.equal(blocked.status, 429);
        assert.ok(Number(blocked.headers['retry-after']) > 0);

        // A different client IP is not affected.
        const other = await harness.login('admin', '198.51.100.7');
        assert.equal(other.status, 200);
    });

    test('a successful login resets the failure counter', async () => {
        const harness = await createHarness();

        for (let i = 0; i < 4; i++) {
            await harness.login('wrong', '203.0.113.9');
        }
        const ok = await harness.login('admin', '203.0.113.9');
        assert.equal(ok.status, 200);

        // Counter was reset: the next failure is a plain 401, not a block.
        const res = await harness.login('wrong', '203.0.113.9');
        assert.equal(res.status, 401);
    });
});
