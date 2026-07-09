'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { Readable, Writable } = require('node:stream');

const { createDb } = require('../../src/db/index');
const { registerSettingsApi } = require('../../src/api/settings');

class MockRequest extends Readable {
    constructor(method, url, body) {
        super();
        this.method = method;
        this.url = url;
        this.headers =
            body === undefined
                ? {}
                : {
                      'content-type': 'application/json',
                      'content-length': Buffer.byteLength(JSON.stringify(body)),
                  };
        this.socket = { remoteAddress: '127.0.0.1' };
        this.connection = this.socket;
        this.body = body;
        this.bodyText = body === undefined ? '' : JSON.stringify(body);
    }

    _read() {
        this.push(this.bodyText);
        this.push(null);
        this.bodyText = '';
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
                text,
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

function dispatch(app, method, route, body) {
    return new Promise((resolve, reject) => {
        const req = new MockRequest(method, route, body);
        const res = new MockResponse(resolve);
        app.handle(req, res, reject);
    });
}

function createHarness({ applyIpWhitelist } = {}) {
    const app = express();

    const db = createDb(':memory:');
    const calls = [];
    const apply =
        applyIpWhitelist ??
        (async (ips) => {
            calls.push(ips);
            return { ok: true };
        });
    const getBannedIps = async () => ({ ok: true, bans: [] });
    registerSettingsApi(app, db, apply, getBannedIps);

    return {
        db,
        whitelistCalls: calls,
        request: (method, route, body) => dispatch(app, method, route, body),
    };
}

describe('Settings API integration', () => {
    describe('POST /api/settings/general', () => {
        test('updates the server name', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/settings/general', {
                name: 'Control Room',
            });

            assert.equal(res.status, 200);
            assert.deepEqual(res.body, {
                serverName: 'Control Room',
                publicHost: 'localhost',
            });
            assert.equal(harness.db.getSetting('serverName'), 'Control Room');
        });

        test('leaves other settings untouched when only the name changes', async () => {
            const harness = createHarness();
            harness.db.setSetting('serverName', 'Old Name');
            harness.db.setSetting('srtPassphrase', 'secret-value');
            harness.db.replaceHostProbeTargets([
                { slot: 1, label: 'YouTube', host: 'a.rtmp.youtube.com', port: 1935 },
            ]);
            harness.db.replaceWhitelistIps(['203.0.113.4']);

            const res = await harness.request('POST', '/api/settings/general', {
                name: 'New Name',
            });

            assert.equal(res.status, 200);
            assert.equal(res.body.serverName, 'New Name');
            assert.equal(harness.db.getSetting('serverName'), 'New Name');
            assert.equal(harness.db.getSetting('srtPassphrase'), 'secret-value');
            assert.equal(harness.db.listHostProbeTargets().length, 1);
            assert.deepEqual(harness.db.listWhitelistIps(), ['203.0.113.4']);
        });

        test('ignores extraneous payload fields such as an SRT passphrase', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/settings/general', {
                name: 'Control Room',
                srtPassphrase: 'secret-value',
            });

            assert.equal(res.status, 200);
            assert.equal(harness.db.getSetting('srtPassphrase'), null);
        });

        test('rejects a missing name', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/settings/general', {});

            assert.equal(res.status, 400);
        });

        test('updates the public host when provided', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/settings/general', {
                name: 'Control Room',
                publicHost: 'stream.example.com',
            });

            assert.equal(res.status, 200);
            assert.equal(res.body.publicHost, 'stream.example.com');
            assert.equal(harness.db.getSetting('publicHost'), 'stream.example.com');
        });
    });

    describe('POST /api/settings/host-probes', () => {
        test('saves host probe targets', async () => {
            const harness = createHarness();
            const hostProbeTargets = [
                { slot: 1, label: 'YouTube', host: 'a.rtmp.youtube.com', port: 1935 },
                { slot: 2, label: 'Facebook', host: 'live-api-s.facebook.com', port: 443 },
            ];

            const res = await harness.request('POST', '/api/settings/host-probes', {
                hostProbeTargets,
            });

            assert.equal(res.status, 200);
            assert.deepEqual(res.body, { hostProbeTargets });
            assert.deepEqual(harness.db.listHostProbeTargets(), hostProbeTargets);
        });

        test('rejects an invalid host probe target', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/settings/host-probes', {
                hostProbeTargets: [{ slot: 1, label: '', host: '', port: 1935 }],
            });

            assert.equal(res.status, 400);
            assert.deepEqual(harness.db.listHostProbeTargets(), []);
        });

        test('does not touch the server name', async () => {
            const harness = createHarness();
            harness.db.setSetting('serverName', 'Control Room');

            const res = await harness.request('POST', '/api/settings/host-probes', {
                hostProbeTargets: [],
            });

            assert.equal(res.status, 200);
            assert.equal(harness.db.getSetting('serverName'), 'Control Room');
        });
    });

    describe('POST /api/settings/whitelist', () => {
        test('saves and dedupes the IP whitelist', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/settings/whitelist', {
                whitelistIps: ['203.0.113.4', '203.0.113.0/24', '203.0.113.4'],
            });

            assert.equal(res.status, 200);
            assert.deepEqual([...res.body.whitelistIps].sort(), ['203.0.113.0/24', '203.0.113.4']);
            assert.equal(res.body.whitelistApplied, true);
            assert.deepEqual(harness.db.listWhitelistIps().sort(), [
                '203.0.113.0/24',
                '203.0.113.4',
            ]);
            assert.deepEqual(harness.whitelistCalls, [res.body.whitelistIps]);
        });

        test('rejects an invalid whitelist entry', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/settings/whitelist', {
                whitelistIps: ['not-an-ip'],
            });

            assert.equal(res.status, 400);
            assert.deepEqual(harness.db.listWhitelistIps(), []);
        });

        test('surfaces a fail2ban apply failure without losing the save', async () => {
            const harness = createHarness({
                applyIpWhitelist: async () => ({
                    ok: false,
                    error: 'sudo: a password is required',
                }),
            });
            const res = await harness.request('POST', '/api/settings/whitelist', {
                whitelistIps: ['203.0.113.4'],
            });

            assert.equal(res.status, 200);
            assert.equal(res.body.whitelistApplied, false);
            assert.equal(res.body.whitelistError, 'sudo: a password is required');
            assert.deepEqual(harness.db.listWhitelistIps(), ['203.0.113.4']);
        });
    });
});
