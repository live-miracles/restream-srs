'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { Readable, Writable } = require('node:stream');

const { registerSrsHooks, registerSrsLogsApi } = require('../../src/api/srs');
const childProcess = require('node:child_process');

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

    test('rejects a publish with no stream field at all', async () => {
        const harness = createHarness(['key01_good']);

        const res = await harness.publish({ app: 'live' });

        assert.equal(res.status, 400);
        assert.deepEqual(res.body, { code: 400 });
    });

    test('rejects a publish with an empty-string stream', async () => {
        const harness = createHarness(['key01_good']);

        const res = await harness.publish({ app: 'live', stream: '' });

        assert.equal(res.status, 400);
        assert.deepEqual(res.body, { code: 400 });
    });

    test('rejecting a publish with no hookApp does not crash (skips the kick call)', async () => {
        const harness = createHarness(['key01_good']);

        const res = await harness.publish({ stream: 'key99_bad' });

        assert.equal(res.status, 403);
        assert.deepEqual(res.body, { code: 403 });
    });

    test('rejects a very long, non-matching stream value without crashing', async () => {
        const harness = createHarness(['key01_good']);
        const longStream = 'x'.repeat(10_000);

        const res = await harness.publish({ app: 'live', stream: longStream });

        assert.equal(res.status, 403);
        assert.deepEqual(res.body, { code: 403 });
    });

    test('a stream key match is case-sensitive and exact (no substring/prefix match)', async () => {
        const harness = createHarness(['key01_good']);

        for (const stream of ['KEY01_GOOD', 'key01_goodextra', 'key01_goo']) {
            const res = await harness.publish({ app: 'live', stream });
            assert.equal(res.status, 403);
        }
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

    test('rejects an ip that merely starts with a loopback-like prefix but is not localhost', async () => {
        const harness = createHarness(['key01_good']);

        // '127' without the trailing dot must not match the '127.' prefix check.
        for (const ip of ['1270.0.0.1', '127', '::ffff:127', 'localhost']) {
            const res = await harness.play({ app: 'live', stream: 'key01_good', ip });
            assert.equal(res.status, 403);
        }
    });

    test('loopback plays succeed even with no stream field (hook does not validate stream on play)', async () => {
        const harness = createHarness(['key01_good']);

        const res = await harness.play({ app: 'live', ip: '127.0.0.1' });

        assert.equal(res.status, 200);
        assert.deepEqual(res.body, { code: 0 });
    });
});

describe('SRS logs API integration', () => {
    function createLogsHarness(t, { execError, execOutput = '' } = {}) {
        const app = express();
        const events = [{ source: 'srs', type: 'up', message: 'test event', ts: 1 }];
        t.mock.method(childProcess, 'execFile', (_cmd, _args, _opts, cb) => {
            queueMicrotask(() => cb(execError ?? null, execOutput, ''));
        });
        registerSrsLogsApi(app, () => events);
        return {
            events,
            get: () => dispatch(app, 'GET', '/api/srs-logs'),
        };
    }

    test('returns app-level srs events alongside empty log tails when journalctl is unavailable', async (t) => {
        const harness = createLogsHarness(t, {
            execError: new Error('journalctl: command not found'),
        });

        const res = await harness.get();

        assert.equal(res.status, 200);
        assert.deepEqual(res.body.events, harness.events);
        assert.deepEqual(res.body.srs, { lines: [], source: 'none' });
        assert.deepEqual(res.body.dashboard, { lines: [], source: 'none' });
        assert.deepEqual(res.body.relay, { lines: [], source: 'none' });
    });

    test('parses non-empty journal output into lines with source=journal', async (t) => {
        const harness = createLogsHarness(t, { execOutput: 'line one\nline two\n\n' });

        const res = await harness.get();

        assert.equal(res.status, 200);
        assert.deepEqual(res.body.srs, { lines: ['line one', 'line two'], source: 'journal' });
        assert.deepEqual(res.body.dashboard, {
            lines: ['line one', 'line two'],
            source: 'journal',
        });
    });

    test('blank-only journal output is treated as no logs (source=none)', async (t) => {
        const harness = createLogsHarness(t, { execOutput: '\n\n   \n' });

        const res = await harness.get();

        assert.deepEqual(res.body.srs, { lines: [], source: 'none' });
    });
});
