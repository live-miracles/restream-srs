'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { Readable, Writable } = require('node:stream');

const { registerSrsHooks } = require('../../src/api/srs');

class MockRequest extends Readable {
    constructor(method, url, body) {
        super();
        this.method = method;
        this.url = url;
        this.headers = {};
        this.socket = { remoteAddress: '127.0.0.1' };
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
        app.handle(new MockRequest(method, route, body), new MockResponse(resolve), reject);
    });
}

function createHarness(assignedKeys) {
    const app = express();
    const db = {
        listPipelines: () =>
            assignedKeys.map((streamKey, index) => ({
                id: index + 1,
                name: `Pipeline ${index + 1}`,
                streamKey,
                streamKeyId: index + 1,
            })),
    };
    registerSrsHooks(app, db);
    return {
        publish: (body) => dispatch(app, 'POST', '/api/srs/on_publish', body),
        play: (body) => dispatch(app, 'POST', '/api/srs/on_play', body),
        ready: () => dispatch(app, 'GET', '/api/ready'),
    };
}

describe('SRS publish hook integration', () => {
    test('exposes an unauthenticated readiness endpoint', async () => {
        const harness = createHarness([]);

        const res = await harness.ready();

        assert.equal(res.status, 200);
        assert.deepEqual(res.body, { ok: true });
    });

    test('allows an assigned stream key', async () => {
        const harness = createHarness(['key01_good']);

        const res = await harness.publish({ app: 'live', stream: 'key01_good' });

        assert.equal(res.status, 200);
        assert.deepEqual(res.body, { code: 0 });
    });

    test('rejects an unassigned stream key', async () => {
        const harness = createHarness(['key01_good']);

        const res = await harness.publish({ app: 'live', stream: 'key99_bad' });

        assert.equal(res.status, 403);
        assert.deepEqual(res.body, { code: 403 });
    });
});

describe('SRS play hook integration', () => {
    test('allows plays from loopback (app ffmpeg pulls)', async () => {
        const harness = createHarness(['key01_good']);

        for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
            const res = await harness.play({ app: 'live', stream: 'key01_good', ip });
            assert.equal(res.status, 200);
            assert.deepEqual(res.body, { code: 0 });
        }
    });

    test('rejects plays from any non-loopback address', async () => {
        const harness = createHarness(['key01_good']);

        for (const ip of ['203.0.113.5', '10.0.0.4', '::ffff:203.0.113.5', undefined]) {
            const res = await harness.play({ app: 'live', stream: 'key01_good', ip });
            assert.equal(res.status, 403);
            assert.deepEqual(res.body, { code: 403 });
        }
    });
});
