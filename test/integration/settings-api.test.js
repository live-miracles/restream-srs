'use strict';

const { after, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restream-srs-settings-'));
process.env.SRS_CONF_PATH = path.join(tempDir, 'srs.conf');
process.env.SRT_BONDING_RELAY_ENV_PATH = path.join(tempDir, 'srt-bonding-relay.env');

// writeSrsConf patches an existing file, so seed a minimal conf with the
// srt_server block that the passphrase injection regex targets.
fs.writeFileSync(
    process.env.SRS_CONF_PATH,
    'srt_server {\n    enabled     on;\n    listen      10080;\n}\n',
    'utf8',
);

const { createDb } = require('../../src/db/index');
const { registerSettingsApi } = require('../../src/api/settings');

after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
});

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

function createHarness() {
    const app = express();

    const db = createDb(':memory:');
    registerSettingsApi(app, db);

    return {
        db,
        request: (method, route, body) => dispatch(app, method, route, body),
    };
}

describe('Settings API integration', () => {
    test('combined settings endpoint updates name', async () => {
        const harness = createHarness();
        const res = await harness.request('POST', '/api/settings', {
            name: 'Control Room',
        });

        assert.equal(res.status, 200);
        assert.deepEqual(res.body, {
            serverName: 'Control Room',
            srtPassphrase: null,
            publicHost: 'localhost',
            pending: false,
        });
        assert.equal(harness.db.getSetting('serverName'), 'Control Room');
    });

    test('combined settings endpoint does not mark pending when only name changes', async () => {
        const harness = createHarness();
        harness.db.setSetting('serverName', 'Old Name');
        harness.db.setSetting('srtPassphrase', 'secret-value');

        const res = await harness.request('POST', '/api/settings', {
            name: 'New Name',
            srtPassphrase: 'secret-value',
        });

        assert.equal(res.status, 200);
        assert.deepEqual(res.body, {
            serverName: 'New Name',
            srtPassphrase: 'secret-value',
            publicHost: 'localhost',
            pending: false,
        });
        assert.equal(harness.db.getSetting('serverName'), 'New Name');
        assert.equal(harness.db.getSetting('srtPassphrase'), 'secret-value');
    });

    test('combined settings endpoint writes SRT passphrase settings', async () => {
        const harness = createHarness();
        const res = await harness.request('POST', '/api/settings', {
            name: 'Control Room',
            srtPassphrase: 'secret-value',
        });

        assert.equal(res.status, 200);
        assert.deepEqual(res.body, {
            serverName: 'Control Room',
            srtPassphrase: 'secret-value',
            publicHost: 'localhost',
            pending: true,
        });
        assert.equal(harness.db.getSetting('srtPassphrase'), 'secret-value');
        const conf = fs.readFileSync(process.env.SRS_CONF_PATH, 'utf8');
        const relayEnv = fs.readFileSync(process.env.SRT_BONDING_RELAY_ENV_PATH, 'utf8');
        assert.match(conf, /passphrase\s+"secret-value";/);
        assert.match(conf, /pbkeylen\s+16;/);
        assert.match(relayEnv, /passphrase=secret-value/);
        assert.match(relayEnv, /pbkeylen=16/);
    });

    test('combined settings endpoint rejects invalid SRT passphrase', async () => {
        const harness = createHarness();
        const res = await harness.request('POST', '/api/settings', {
            name: 'Control Room',
            srtPassphrase: 'short',
        });

        assert.equal(res.status, 400);
        assert.match(res.body.error, /10 to 79/);
        assert.equal(harness.db.getSetting('srtPassphrase'), null);
    });
});
