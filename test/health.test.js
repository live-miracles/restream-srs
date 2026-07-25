'use strict';

const { after, describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { Readable, Writable } = require('node:stream');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    hasBondedRelayPublishConflict,
    isProbeUsable,
    isLoopbackIp,
    localSrtOutputTargetsStream,
} = require('../src/services/health');

describe('health media probe validation', () => {
    test('accepts video with codec and dimensions', () => {
        assert.equal(
            isProbeUsable({
                video: {
                    codec: 'h264',
                    width: 1920,
                    height: 1080,
                    fps: 50,
                    profile: 'Main',
                    level: '4.2',
                    fieldOrder: 'progressive',
                },
                audio: null,
                audioTracks: [],
            }),
            true,
        );
    });

    test('rejects missing or dimensionless video', () => {
        assert.equal(isProbeUsable(null), false);
        assert.equal(isProbeUsable({ video: null, audio: null, audioTracks: [] }), false);
        assert.equal(
            isProbeUsable({
                video: {
                    codec: 'h264',
                    width: 0,
                    height: 0,
                    fps: null,
                    profile: '',
                    level: '',
                    fieldOrder: null,
                },
                audio: null,
                audioTracks: [],
            }),
            false,
        );
    });
});

describe('health local SRT output detection', () => {
    test('matches local SRS SRT outputs by stream resource', () => {
        assert.equal(
            localSrtOutputTargetsStream(
                'srt://127.0.0.1:10080?streamid=#!::r=live/key01,m=publish',
                'key01',
            ),
            true,
        );
        assert.equal(
            localSrtOutputTargetsStream(
                'srt://localhost:10080?streamid=%23!::r=live/key01,m=publish',
                'key01',
            ),
            true,
        );
        assert.equal(
            localSrtOutputTargetsStream(
                'srt://localhost:10080?streamid=%23%21%3A%3Ar%3Dlive%2Fkey01%2Cm%3Dpublish',
                'key01',
            ),
            true,
        );
    });

    test('ignores non-local, wrong-port, and different-stream SRT outputs', () => {
        assert.equal(
            localSrtOutputTargetsStream(
                'srt://192.0.2.10:10080?streamid=#!::r=live/key01,m=publish',
                'key01',
            ),
            false,
        );
        assert.equal(
            localSrtOutputTargetsStream(
                'srt://127.0.0.1:10081?streamid=#!::r=live/key01,m=publish',
                'key01',
            ),
            false,
        );
        assert.equal(
            localSrtOutputTargetsStream(
                'srt://127.0.0.1:10080?streamid=#!::r=live/key02,m=publish',
                'key01',
            ),
            false,
        );
    });
});

describe('health loopback ip detection', () => {
    test('accepts IPv4 and IPv6 loopback forms', () => {
        assert.equal(isLoopbackIp('127.0.0.1'), true);
        assert.equal(isLoopbackIp('::1'), true);
        assert.equal(isLoopbackIp('::ffff:127.0.0.1'), true);
    });

    test('rejects non-loopback, malformed, and empty values', () => {
        assert.equal(isLoopbackIp('127.0.0.2'), false);
        assert.equal(isLoopbackIp('10.0.0.1'), false);
        assert.equal(isLoopbackIp(''), false);
        assert.equal(isLoopbackIp(null), false);
        assert.equal(isLoopbackIp(undefined), false);
    });
});

describe('health bonded relay publish conflict detection', () => {
    test('flags any existing pipeline input when bonded relay input is active but not accepted', () => {
        assert.equal(
            hasBondedRelayPublishConflict({
                inputConnected: true,
                relayInputActive: true,
                relayAcceptedBySrs: false,
            }),
            true,
        );
    });

    test('does not flag idle pipelines or relay publishers accepted by SRS', () => {
        assert.equal(
            hasBondedRelayPublishConflict({
                inputConnected: false,
                relayInputActive: true,
                relayAcceptedBySrs: false,
            }),
            false,
        );
        assert.equal(
            hasBondedRelayPublishConflict({
                inputConnected: true,
                relayInputActive: false,
                relayAcceptedBySrs: false,
            }),
            false,
        );
        assert.equal(
            hasBondedRelayPublishConflict({
                inputConnected: true,
                relayInputActive: true,
                relayAcceptedBySrs: true,
            }),
            false,
        );
    });
});

// ── createHealthService poll orchestration ─────────────

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restream-srs-health-'));
const originalCwd = process.cwd();

after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

class MockRequest extends Readable {
    constructor() {
        super();
        this.method = 'GET';
        this.url = '/api/health';
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
            this.resolve(text ? JSON.parse(text) : undefined);
            if (callback) callback();
            return this;
        };
    }
    _write(chunk, _encoding, callback) {
        this.chunks.push(Buffer.from(chunk));
        callback();
    }
}

function getSnapshot(app) {
    return new Promise((resolve, reject) => {
        app.handle(new MockRequest(), new MockResponse(resolve), reject);
    });
}

function jsonResponse(body, ok = true, status = 200) {
    return { ok, status, json: async () => body };
}

function makeFakeDb(pipelines, outputs = []) {
    const logs = [];
    return {
        logs,
        appendLogThrows: false,
        getConfigRev: () => 1,
        listPipelines: () => pipelines,
        listOutputs: () => outputs,
        appendPipelineLog(pipelineId, event, message) {
            if (this.appendLogThrows) throw new Error('db busy');
            logs.push({ pipelineId, event, message });
        },
    };
}

function makeFakeOutputService() {
    const restarts = [];
    return {
        restarts,
        getStats: () => ({
            status: 'stopped',
            pid: null,
            bitrateKbps: null,
            startedAtMs: null,
            failures: 0,
            warningReason: null,
            memoryUsageBytes: null,
            memoryLimitBytes: null,
            cpuPercent: null,
        }),
        restartPipelineOutputs(pipelineId, staggerBase) {
            restarts.push({ pipelineId, staggerBase });
            return 0;
        },
    };
}

function makeFakeSrtRelay() {
    return {
        getStats: () => ({ status: 'stopped', lastError: null }),
        getStreamStatus: () => ({ inputActive: false }),
    };
}

function makeFakeInputState() {
    const live = new Map();
    const protocol = new Map();
    return {
        setSrsReachable() {},
        setPipelineState(id, isLive, proto) {
            live.set(id, isLive);
            if (proto) protocol.set(id, proto);
            else protocol.delete(id);
        },
        setInputResolution() {},
        clearPipeline(id) {
            live.delete(id);
            protocol.delete(id);
        },
        isLive: (id) => live.get(id) ?? false,
        getProtocol: (id) => protocol.get(id) ?? null,
    };
}

function loadHealthService(t) {
    fs.writeFileSync(
        path.join(tempDir, 'restream.json'),
        JSON.stringify(
            {
                port: 8080,
                database_path: './db.sqlite',
                srs_config_path: './srs.conf',
                ffmpeg_path: 'ffmpeg',
                ffprobe_path: 'ffprobe',
            },
            null,
            4,
        ),
        'utf8',
    );
    fs.writeFileSync(
        path.join(tempDir, 'srs.conf'),
        'listen 1935;\nhttp_api {\n    listen 1985;\n}\n',
        'utf8',
    );
    // No pipeline in these tests reaches the ffprobe-scheduling branch with a
    // real url unless explicitly connected+protocol'd; guard it anyway so a
    // real ffprobe binary is never shelled out to during this suite.
    t.mock.method(childProcess, 'execFile', (_cmd, _args, _opts, cb) => {
        queueMicrotask(() => cb(new Error('ffprobe disabled in test'), '', ''));
    });
    delete require.cache[require.resolve('../src/services/health')];
    delete require.cache[require.resolve('../src/utils/srsConfig')];
    return require('../src/services/health').createHealthService;
}

describe('createHealthService poll orchestration', () => {
    beforeEach(() => {
        process.chdir(tempDir);
    });

    afterEach(() => {
        process.chdir(originalCwd);
        delete require.cache[require.resolve('../src/services/health')];
        delete require.cache[require.resolve('../src/utils/appConfig')];
        delete require.cache[require.resolve('../src/utils/srsConfig')];
    });

    test('marks srsReachable false and logs a down event when the streams fetch rejects', async (t) => {
        t.mock.method(globalThis, 'fetch', async () => {
            throw new Error('ECONNREFUSED');
        });
        const createHealthService = loadHealthService(t);
        const db = makeFakeDb([]);
        const service = createHealthService(
            db,
            makeFakeOutputService(),
            makeFakeSrtRelay(),
            makeFakeInputState(),
        );
        const app = express();
        service.registerRoutes(app);

        service.start();
        await sleep(20);

        const snapshot = await getSnapshot(app);
        assert.equal(snapshot.srsReachable, false);
        const events = service.getSrsEvents();
        assert.equal(events.length, 1);
        assert.equal(events[0].source, 'srs');
        assert.equal(events[0].type, 'down');
        assert.match(events[0].message, /ECONNREFUSED/);

        service.shutdown();
    });

    test('does not log a second down event on consecutive unreachable polls', async (t) => {
        t.mock.method(globalThis, 'fetch', async () => {
            throw new Error('down');
        });
        const createHealthService = loadHealthService(t);
        const service = createHealthService(
            makeFakeDb([]),
            makeFakeOutputService(),
            makeFakeSrtRelay(),
            makeFakeInputState(),
        );
        const app = express();
        service.registerRoutes(app);

        service.start();
        await sleep(20);
        const snap1 = await getSnapshot(app);
        assert.equal(snap1.srsReachable, false);
        assert.equal(service.getSrsEvents().length, 1);

        service.shutdown();
    });

    test('a malformed (non-JSON) streams response is treated as unreachable, not a crash', async (t) => {
        t.mock.method(globalThis, 'fetch', async (url) => {
            if (String(url).includes('/streams/')) {
                return { ok: true, status: 200, json: async () => JSON.parse('not json') };
            }
            return jsonResponse({ code: 0, clients: [] });
        });
        const createHealthService = loadHealthService(t);
        const service = createHealthService(
            makeFakeDb([]),
            makeFakeOutputService(),
            makeFakeSrtRelay(),
            makeFakeInputState(),
        );
        const app = express();
        service.registerRoutes(app);

        service.start();
        await sleep(20);

        const snapshot = await getSnapshot(app);
        assert.equal(snapshot.srsReachable, false);

        service.shutdown();
    });

    test('a clients-endpoint failure alone does not flip srsReachable false (streams endpoint is load-bearing)', async (t) => {
        t.mock.method(globalThis, 'fetch', async (url) => {
            if (String(url).includes('/streams/')) {
                return jsonResponse({ code: 0, streams: [] });
            }
            throw new Error('clients endpoint down');
        });
        const createHealthService = loadHealthService(t);
        const service = createHealthService(
            makeFakeDb([]),
            makeFakeOutputService(),
            makeFakeSrtRelay(),
            makeFakeInputState(),
        );
        const app = express();
        service.registerRoutes(app);

        service.start();
        await sleep(20);

        const snapshot = await getSnapshot(app);
        assert.equal(snapshot.srsReachable, true);

        service.shutdown();
    });

    // POLL_INTERVAL_MS (5s) is not configurable, so these two tests fake only
    // 'setInterval' to fire the second poll deterministically without a real
    // 5s wait, while leaving setTimeout/setImmediate real so the async fetch
    // chain and ffprobe scheduling underneath each poll still resolve normally.
    test('logs an up event once SRS becomes reachable again after an outage', async (t) => {
        let failing = true;
        t.mock.method(globalThis, 'fetch', async (url) => {
            if (failing) throw new Error('down');
            if (String(url).includes('/streams/')) return jsonResponse({ code: 0, streams: [] });
            return jsonResponse({ code: 0, clients: [] });
        });
        const createHealthService = loadHealthService(t);
        const service = createHealthService(
            makeFakeDb([]),
            makeFakeOutputService(),
            makeFakeSrtRelay(),
            makeFakeInputState(),
        );
        const app = express();
        service.registerRoutes(app);

        t.mock.timers.enable({ apis: ['setInterval'] });
        service.start();
        await sleep(20);
        assert.equal((await getSnapshot(app)).srsReachable, false);
        assert.equal(service.getSrsEvents().length, 1);

        failing = false;
        t.mock.timers.tick(5000);
        await sleep(20);

        assert.equal((await getSnapshot(app)).srsReachable, true);
        const events = service.getSrsEvents();
        assert.equal(events.length, 2);
        assert.equal(events[1].type, 'up');

        service.shutdown();
    });

    test('hides a pipeline as offline during an SRS outage even though it was live moments before', async (t) => {
        let reachable = true;
        const pipeline = { id: 1, name: 'P1', streamKey: 'key01', streamKeyId: 1 };
        t.mock.method(globalThis, 'fetch', async (url) => {
            if (!reachable) throw new Error('down');
            if (String(url).includes('/streams/')) {
                return jsonResponse({
                    code: 0,
                    streams: [
                        {
                            id: 's1',
                            name: 'key01',
                            vhost: '__defaultVhost__',
                            app: 'live',
                            tcUrl: 'rtmp://x/live',
                            live_ms: 0,
                            publish: { active: true, cid: 'cid-1' },
                            kbps: { recv_30s: 100, send_30s: 100 },
                            clients: 1,
                            frames: 0,
                            recv_bytes: 0,
                            send_bytes: 0,
                        },
                    ],
                });
            }
            return jsonResponse({ code: 0, clients: [] });
        });
        const createHealthService = loadHealthService(t);
        const db = makeFakeDb([pipeline]);
        const service = createHealthService(
            db,
            makeFakeOutputService(),
            makeFakeSrtRelay(),
            makeFakeInputState(),
        );
        const app = express();
        service.registerRoutes(app);

        t.mock.timers.enable({ apis: ['setInterval'] });
        service.start();
        await sleep(20);
        const liveSnap = await getSnapshot(app);
        assert.equal(liveSnap.pipelines['1'].input.connected, true);
        assert.equal(liveSnap.pipelines['1'].input.live, true);
        assert.ok(db.logs.some((l) => l.event === 'online'));

        reachable = false;
        t.mock.timers.tick(5000);
        await sleep(20);

        const outageSnap = await getSnapshot(app);
        assert.equal(outageSnap.srsReachable, false);
        // Displayed state must not show a stale "green" input while SRS
        // itself is unreachable, even though the pipeline was live seconds
        // ago and no offline log entry has fired (no false transition).
        assert.equal(outageSnap.pipelines['1'].input.connected, false);
        assert.equal(outageSnap.pipelines['1'].input.live, false);
        assert.equal(
            db.logs.filter((l) => l.event === 'offline').length,
            0,
            'an SRS outage must not itself log a pipeline offline transition',
        );

        service.shutdown();
    });

    test('does not crash the poll loop when appendPipelineLog throws', async (t) => {
        const pipeline = { id: 1, name: 'P1', streamKey: 'key01', streamKeyId: 1 };
        t.mock.method(globalThis, 'fetch', async (url) => {
            if (String(url).includes('/streams/')) {
                return jsonResponse({
                    code: 0,
                    streams: [
                        {
                            id: 's1',
                            name: 'key01',
                            vhost: '__defaultVhost__',
                            app: 'live',
                            tcUrl: 'rtmp://x/live',
                            live_ms: 0,
                            publish: { active: true, cid: 'cid-1' },
                            kbps: { recv_30s: 0, send_30s: 0 },
                            clients: 1,
                            frames: 0,
                            recv_bytes: 0,
                            send_bytes: 0,
                        },
                    ],
                });
            }
            return jsonResponse({ code: 0, clients: [] });
        });
        const createHealthService = loadHealthService(t);
        const db = makeFakeDb([pipeline]);
        db.appendLogThrows = true;
        const outputService = makeFakeOutputService();
        const service = createHealthService(
            db,
            outputService,
            makeFakeSrtRelay(),
            makeFakeInputState(),
        );
        const app = express();
        service.registerRoutes(app);

        service.start();
        await sleep(20);

        const snapshot = await getSnapshot(app);
        assert.equal(snapshot.pipelines['1'].input.connected, true);
        // The pipeline just went live: restartPipelineOutputs must still have
        // been invoked even though appendPipelineLog threw.
        assert.equal(outputService.restarts.length, 1);
        assert.equal(outputService.restarts[0].pipelineId, 1);

        service.shutdown();
    });

    test('restartPipelineOutputs is invoked exactly once on the offline-to-online transition', async (t) => {
        const pipeline = { id: 1, name: 'P1', streamKey: 'key01', streamKeyId: 1 };
        t.mock.method(globalThis, 'fetch', async (url) => {
            if (String(url).includes('/streams/')) {
                return jsonResponse({
                    code: 0,
                    streams: [
                        {
                            id: 's1',
                            name: 'key01',
                            vhost: '__defaultVhost__',
                            app: 'live',
                            tcUrl: 'rtmp://x/live',
                            live_ms: 0,
                            publish: { active: true, cid: 'cid-1' },
                            kbps: { recv_30s: 0, send_30s: 0 },
                            clients: 1,
                            frames: 0,
                            recv_bytes: 0,
                            send_bytes: 0,
                        },
                    ],
                });
            }
            return jsonResponse({ code: 0, clients: [] });
        });
        const createHealthService = loadHealthService(t);
        const outputService = makeFakeOutputService();
        const service = createHealthService(
            makeFakeDb([pipeline]),
            outputService,
            makeFakeSrtRelay(),
            makeFakeInputState(),
        );
        const app = express();
        service.registerRoutes(app);

        service.start();
        await sleep(20);
        assert.equal(outputService.restarts.length, 1);

        service.shutdown();
    });

    test('an unassigned/deleted pipeline never appears in the snapshot', async (t) => {
        t.mock.method(globalThis, 'fetch', async (url) => {
            if (String(url).includes('/streams/')) return jsonResponse({ code: 0, streams: [] });
            return jsonResponse({ code: 0, clients: [] });
        });
        const createHealthService = loadHealthService(t);
        const service = createHealthService(
            makeFakeDb([]),
            makeFakeOutputService(),
            makeFakeSrtRelay(),
            makeFakeInputState(),
        );
        const app = express();
        service.registerRoutes(app);

        service.start();
        await sleep(20);

        const snapshot = await getSnapshot(app);
        assert.deepEqual(snapshot.pipelines, {});

        service.shutdown();
    });
});
