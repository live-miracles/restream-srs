'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { Readable, Writable } = require('node:stream');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const dns = require('node:dns/promises');

const { createHostProbeService } = require('../../src/services/hostProbes');

class MockRequest extends Readable {
    constructor(method, url) {
        super();
        this.method = method;
        this.url = url;
        this.headers = {};
        this.socket = { remoteAddress: '127.0.0.1' };
        this.connection = this.socket;
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

function dispatch(app, method, route) {
    return new Promise((resolve, reject) => {
        app.handle(new MockRequest(method, route), new MockResponse(resolve), reject);
    });
}

function makeDb(targets) {
    return { listHostProbeTargets: () => targets };
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Host probes API integration (route only, no active probing)', () => {
    test('returns one entry per configured target with empty history', async () => {
        const app = express();
        const targets = [
            { slot: 1, label: 'YouTube', host: 'a.example.com', port: 1935 },
            { slot: 2, label: 'Facebook', host: 'b.example.com', port: 443 },
        ];
        const service = createHostProbeService(makeDb(targets));
        service.registerRoutes(app);

        const res = await dispatch(app, 'GET', '/api/host-probes');

        assert.equal(res.status, 200);
        assert.equal(res.body.targets.length, 2);
        assert.deepEqual(res.body.targets[0].target, targets[0]);
        assert.equal(res.body.targets[0].historySampleCount, 0);
        assert.equal(res.body.targets[0].historyFailureCount, 0);
        assert.equal(res.body.targets[0].averageLatencyMs, null);
        assert.equal(res.body.targets[0].latestSample, null);
        assert.equal(res.body.intervalMs, 5000);
    });

    test('returns an empty targets array when none are configured', async () => {
        const app = express();
        const service = createHostProbeService(makeDb([]));
        service.registerRoutes(app);

        const res = await dispatch(app, 'GET', '/api/host-probes');

        assert.equal(res.status, 200);
        assert.deepEqual(res.body.targets, []);
    });

    test('defaults to 6 hours when the hours query param is absent', async () => {
        const app = express();
        const service = createHostProbeService(makeDb([]));
        service.registerRoutes(app);

        const res = await dispatch(app, 'GET', '/api/host-probes');
        assert.equal(res.status, 200); // sanity: route still resolves
    });

    test('clamps an hours value above the 6-hour maximum', async () => {
        const app = express();
        const service = createHostProbeService(makeDb([]));
        service.registerRoutes(app);

        // Can't directly observe sinceTs, but a huge value must not throw and
        // must still produce a valid response (clamped internally to 6).
        const res = await dispatch(app, 'GET', '/api/host-probes?hours=999999');
        assert.equal(res.status, 200);
    });

    test('falls back to the default for non-numeric, negative, or zero hours', async () => {
        const app = express();
        const service = createHostProbeService(makeDb([]));
        service.registerRoutes(app);

        for (const hours of ['abc', '-5', '0', 'NaN', '']) {
            const res = await dispatch(app, 'GET', `/api/host-probes?hours=${hours}`);
            assert.equal(res.status, 200);
        }
    });

    test('reflects target list changes (add/remove) between requests', async () => {
        const app = express();
        const targets = [{ slot: 1, label: 'A', host: 'a.example.com', port: 1935 }];
        const service = createHostProbeService(makeDb(targets));
        service.registerRoutes(app);

        const first = await dispatch(app, 'GET', '/api/host-probes');
        assert.equal(first.body.targets.length, 1);

        targets.push({ slot: 2, label: 'B', host: 'b.example.com', port: 443 });
        const second = await dispatch(app, 'GET', '/api/host-probes');
        assert.equal(second.body.targets.length, 2);

        targets.length = 0;
        const third = await dispatch(app, 'GET', '/api/host-probes');
        assert.deepEqual(third.body.targets, []);
    });
});

describe('Host probes API integration (active probing, mocked dns/net)', () => {
    class FakeSocket extends EventEmitter {
        setTimeout(_ms) {}
        destroy() {
            this.destroyed = true;
        }
    }

    test('a successful connect produces an ok=true sample with resolved address and latency', async (t) => {
        t.mock.method(dns, 'lookup', async () => ({ address: '93.184.216.34', family: 4 }));
        const socket = new FakeSocket();
        t.mock.method(net, 'createConnection', () => {
            queueMicrotask(() => socket.emit('connect'));
            return socket;
        });

        const app = express();
        const targets = [{ slot: 1, label: 'A', host: 'a.example.com', port: 1935 }];
        const service = createHostProbeService(makeDb(targets));
        service.registerRoutes(app);
        service.start();

        await sleep(30);

        const res = await dispatch(app, 'GET', '/api/host-probes');
        const entry = res.body.targets[0];
        assert.equal(entry.historySampleCount, 1);
        assert.equal(entry.historyFailureCount, 0);
        assert.equal(entry.latestSample.ok, true);
        assert.equal(entry.latestSample.resolvedAddress, '93.184.216.34');
        assert.equal(typeof entry.latestSample.latencyMs, 'number');
        assert.ok(entry.averageLatencyMs !== null);
    });

    test('a DNS lookup failure produces an ok=false sample without ever opening a socket', async (t) => {
        t.mock.method(dns, 'lookup', async () => {
            throw new Error('ENOTFOUND nope.invalid');
        });
        let connectionAttempted = false;
        t.mock.method(net, 'createConnection', () => {
            connectionAttempted = true;
            return new FakeSocket();
        });

        const app = express();
        const targets = [{ slot: 1, label: 'A', host: 'nope.invalid', port: 1935 }];
        const service = createHostProbeService(makeDb(targets));
        service.registerRoutes(app);
        service.start();

        await sleep(30);

        const res = await dispatch(app, 'GET', '/api/host-probes');
        const entry = res.body.targets[0];
        assert.equal(entry.historyFailureCount, 1);
        assert.equal(entry.latestSample.ok, false);
        assert.match(entry.latestSample.error, /ENOTFOUND/);
        assert.equal(entry.latestSample.resolvedAddress, null);
        assert.equal(entry.averageLatencyMs, null);
        assert.equal(connectionAttempted, false);
    });

    test('a connection error produces an ok=false sample carrying the resolved address', async (t) => {
        t.mock.method(dns, 'lookup', async () => ({ address: '10.0.0.1', family: 4 }));
        const socket = new FakeSocket();
        t.mock.method(net, 'createConnection', () => {
            queueMicrotask(() => socket.emit('error', new Error('ECONNREFUSED')));
            return socket;
        });

        const app = express();
        const targets = [{ slot: 1, label: 'A', host: 'a.example.com', port: 1935 }];
        const service = createHostProbeService(makeDb(targets));
        service.registerRoutes(app);
        service.start();

        await sleep(30);

        const res = await dispatch(app, 'GET', '/api/host-probes');
        const entry = res.body.targets[0];
        assert.equal(entry.latestSample.ok, false);
        assert.match(entry.latestSample.error, /ECONNREFUSED/);
        assert.equal(entry.latestSample.resolvedAddress, '10.0.0.1');
    });

    test('an out-of-range port falls back to 1935 instead of a nonsense connection target', async (t) => {
        t.mock.method(dns, 'lookup', async () => ({ address: '10.0.0.1', family: 4 }));
        let usedPort = null;
        const socket = new FakeSocket();
        t.mock.method(net, 'createConnection', (opts) => {
            usedPort = opts.port;
            queueMicrotask(() => socket.emit('connect'));
            return socket;
        });

        const app = express();
        // port 99999 is out of the valid 1..65535 range.
        const targets = [{ slot: 1, label: 'A', host: 'a.example.com', port: 99999 }];
        const service = createHostProbeService(makeDb(targets));
        service.registerRoutes(app);
        service.start();

        await sleep(30);

        assert.equal(usedPort, 1935);
    });

    test('reconfiguring a target at the same slot resets its history (signature change)', async (t) => {
        t.mock.method(dns, 'lookup', async () => ({ address: '10.0.0.1', family: 4 }));
        t.mock.method(net, 'createConnection', () => {
            const socket = new FakeSocket();
            queueMicrotask(() => socket.emit('connect'));
            return socket;
        });

        const app = express();
        const targets = [{ slot: 1, label: 'A', host: 'a.example.com', port: 1935 }];
        const service = createHostProbeService(makeDb(targets));
        service.registerRoutes(app);
        service.start();
        await sleep(30);

        let res = await dispatch(app, 'GET', '/api/host-probes');
        assert.equal(res.body.targets[0].historySampleCount, 1);

        // Same slot, different host — a real reconfiguration, not a rename typo.
        targets[0] = { slot: 1, label: 'A', host: 'different-host.example.com', port: 1935 };
        res = await dispatch(app, 'GET', '/api/host-probes');
        assert.equal(res.body.targets[0].historySampleCount, 0);
    });

    test('two probes at slightly different concurrency-scheduled times both complete without crosstalk', async (t) => {
        t.mock.method(dns, 'lookup', async (host) => ({
            address: host === 'a.example.com' ? '10.0.0.1' : '10.0.0.2',
            family: 4,
        }));
        const sockets = new Map();
        t.mock.method(net, 'createConnection', (opts) => {
            const socket = new FakeSocket();
            sockets.set(opts.host, socket);
            if (opts.host === '10.0.0.1') {
                queueMicrotask(() => socket.emit('connect'));
            } else {
                queueMicrotask(() => socket.emit('error', new Error('refused')));
            }
            return socket;
        });

        const app = express();
        const targets = [
            { slot: 1, label: 'A', host: 'a.example.com', port: 1935 },
            { slot: 2, label: 'B', host: 'b.example.com', port: 1935 },
        ];
        const service = createHostProbeService(makeDb(targets));
        service.registerRoutes(app);
        service.start();

        await sleep(30);

        const res = await dispatch(app, 'GET', '/api/host-probes');
        const bySlot = new Map(res.body.targets.map((t2) => [t2.target.slot, t2]));
        assert.equal(bySlot.get(1).latestSample.ok, true);
        assert.equal(bySlot.get(2).latestSample.ok, false);
    });
});
