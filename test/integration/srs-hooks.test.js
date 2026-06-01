'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { Readable, Writable } = require('node:stream');

const { registerSrsHooks } = require('../../src/api/srs-hooks');

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
    return { request: (body) => dispatch(app, 'POST', '/api/srs/on_publish', body) };
}

describe('SRS publish hook integration', () => {
    test('allows an assigned stream key', async () => {
        const harness = createHarness(['key01_good']);

        const res = await harness.request({ app: 'live', stream: 'key01_good' });

        assert.equal(res.status, 200);
        assert.deepEqual(res.body, { code: 0 });
    });

    test('rejects an unassigned stream key', async () => {
        const harness = createHarness(['key01_good']);

        const res = await harness.request({ app: 'live', stream: 'key99_bad' });

        assert.equal(res.status, 403);
        assert.deepEqual(res.body, { code: 403 });
    });
});
