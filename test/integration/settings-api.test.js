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
        });

        assert.equal(res.status, 200);
        assert.deepEqual(res.body, {
            serverName: 'New Name',
            publicHost: 'localhost',
            pending: false,
        });
        assert.equal(harness.db.getSetting('serverName'), 'New Name');
        assert.equal(harness.db.getSetting('srtPassphrase'), 'secret-value');
    });

    test('combined settings endpoint ignores SRT passphrase payloads', async () => {
        const harness = createHarness();
        const res = await harness.request('POST', '/api/settings', {
            name: 'Control Room',
            srtPassphrase: 'secret-value',
        });

        assert.equal(res.status, 200);
        assert.deepEqual(res.body, {
            serverName: 'Control Room',
            publicHost: 'localhost',
            pending: false,
        });
        assert.equal(harness.db.getSetting('srtPassphrase'), null);
    });

    test('combined settings endpoint ignores invalid SRT passphrase payloads', async () => {
        const harness = createHarness();
        const res = await harness.request('POST', '/api/settings', {
            name: 'Control Room',
            srtPassphrase: 'short',
        });

        assert.equal(res.status, 200);
        assert.deepEqual(res.body, {
            serverName: 'Control Room',
            publicHost: 'localhost',
            pending: false,
        });
        assert.equal(harness.db.getSetting('srtPassphrase'), null);
    });
});
