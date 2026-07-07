'use strict';

const { after, describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restream-srs-outputs-'));
const originalCwd = process.cwd();

class FakeFfmpeg extends EventEmitter {
    constructor(pid = 1234) {
        super();
        this.pid = pid;
        this.stdout = new PassThrough();
        this.stderr = new PassThrough();
        this.killSignals = [];
    }

    kill(signal) {
        this.killSignals.push(signal);
        queueMicrotask(() => {
            this.emit('exit', null, signal);
            this.emit('close', null, signal);
        });
        return true;
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeDb() {
    const output = {
        id: 'out1',
        pipelineId: 1,
        seq: 1,
        name: 'YouTube',
        desiredState: 'running',
        videoEncoding: 'copy',
        sinks: [{ seq: 1, url: 'rtmp://youtube.example/live/key', audioEncoding: 'copy' }],
        lastError: null,
    };
    return {
        lastError: null,
        getPipeline(id) {
            return id === 1
                ? { id: 1, name: 'Live', streamKey: 'stream-key', streamKeyId: 1 }
                : null;
        },
        getOutput(id) {
            return id === output.id ? output : null;
        },
        listOutputsForPipeline() {
            return [output];
        },
        setOutputLastError(_id, message) {
            this.lastError = `${Date.now()}\n${message}`;
        },
    };
}

function loadOutputService(t, fakeProc, options = {}) {
    fs.writeFileSync(
        path.join(tempDir, 'restream.json'),
        JSON.stringify(
            {
                port: 8080,
                database_path: './db.sqlite',
                srs_config_path: './srs.conf',
                ffmpeg_path: 'ffmpeg',
                ffprobe_path: 'ffprobe',
                output_watchdog: {
                    warmup_ms: 10,
                    stall_ms: options.progressStallMs ?? 20,
                    interval_ms: 10,
                    socket_warmup_ms: options.socketWarmupMs ?? 15_000,
                    socket_grace_ms: options.socketGraceMs ?? 30_000,
                },
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

    t.mock.method(childProcess, 'spawn', () => fakeProc);
    if (options.ssError) {
        t.mock.method(childProcess, 'execFile', (_cmd, _args, _opts, cb) => {
            queueMicrotask(() => cb(options.ssError, '', ''));
        });
    } else if (options.ssOutput !== undefined) {
        t.mock.method(childProcess, 'execFile', (_cmd, _args, _opts, cb) => {
            queueMicrotask(() => cb(null, options.ssOutput, ''));
        });
    }
    delete require.cache[require.resolve('../src/services/outputs')];
    return require('../src/services/outputs').createOutputService;
}

describe('output watchdog', () => {
    beforeEach(() => {
        process.chdir(tempDir);
    });

    afterEach(() => {
        process.chdir(originalCwd);
        delete require.cache[require.resolve('../src/services/outputs')];
        delete require.cache[require.resolve('../src/utils/appConfig')];
    });

    after(() => {
        process.chdir(originalCwd);
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('kills and retries a running output when ffmpeg output progress stalls', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const createOutputService = loadOutputService(t, proc);
        const service = createOutputService(db);
        service.setInputReadyCheck(() => true);

        await service.start('out1');
        proc.stdout.write('total_size=4096\nout_time_ms=1000000\nbitrate=3200.0kbits/s\n');
        proc.stderr.write('Connection reset by peer\n');

        await sleep(80);

        assert.deepEqual(proc.killSignals, ['SIGTERM']);
        assert.equal(service.getStats('out1').status, 'failed');
        assert.equal(service.getStats('out1').failures, 1);
        assert.match(db.lastError, /watchdog: ffmpeg output stalled; restarting process/);
        assert.match(db.lastError, /last_total_size=4096/);
        assert.match(db.lastError, /last_out_time_ms=1000000/);
        assert.match(db.lastError, /last_bitrate_kbps=3200/);
        assert.match(db.lastError, /Connection reset by peer/);
        assert.match(db.lastError, /Restarting output: no ffmpeg output progress for \d+s/);

        service.shutdown();
    });

    test('does not kill while ffmpeg output progress continues advancing', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const createOutputService = loadOutputService(t, proc);
        const service = createOutputService(db);
        service.setInputReadyCheck(() => true);

        await service.start('out1');
        proc.stdout.write('total_size=4096\nout_time_ms=1000000\n');
        await sleep(15);
        proc.stdout.write('total_size=8192\nout_time_ms=2000000\n');
        await sleep(15);
        proc.stdout.write('total_size=12288\nout_time_ms=3000000\n');

        await sleep(15);

        assert.deepEqual(proc.killSignals, []);
        assert.equal(service.getStats('out1').status, 'running');
        assert.equal(db.lastError, null);

        service.shutdown();
    });

    test('still kills stalled output when recording last_error fails', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        db.setOutputLastError = () => {
            throw new Error('database busy');
        };
        const createOutputService = loadOutputService(t, proc);
        const service = createOutputService(db);
        service.setInputReadyCheck(() => true);

        await service.start('out1');
        proc.stdout.write('total_size=4096\nout_time_ms=1000000\n');

        await sleep(80);

        assert.deepEqual(proc.killSignals, ['SIGTERM']);
        assert.equal(service.getStats('out1').status, 'failed');
        assert.equal(service.getStats('out1').failures, 1);

        service.shutdown();
    });

    test('warns when RTMP destination socket is closing before grace elapses', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const ssOutput =
            'CLOSE-WAIT 57 0 10.160.0.30:47178 192.178.174.134:1935 users:(("ffmpeg",pid=1234,fd=6))\n';
        const createOutputService = loadOutputService(t, proc, {
            progressStallMs: 500,
            socketWarmupMs: 10,
            socketGraceMs: 500,
            ssOutput,
        });
        const service = createOutputService(db);
        service.setInputReadyCheck(() => true);

        await service.start('out1');
        proc.stdout.write('total_size=4096\nout_time_ms=1000000\nbitrate=3200.0kbits/s\n');
        await sleep(40);

        assert.equal(service.getStats('out1').status, 'running');
        assert.match(service.getStats('out1').warningReason || '', /CLOSE-WAIT/);
        assert.deepEqual(proc.killSignals, []);

        service.shutdown();
    });

    test('does not turn ss failures into missing socket kills', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const createOutputService = loadOutputService(t, proc, {
            progressStallMs: 500,
            socketWarmupMs: 10,
            socketGraceMs: 20,
            ssError: new Error('ss failed'),
        });
        const service = createOutputService(db);
        service.setInputReadyCheck(() => true);

        await service.start('out1');
        proc.stdout.write('total_size=4096\nout_time_ms=1000000\nbitrate=3200.0kbits/s\n');
        await sleep(80);

        assert.equal(service.getStats('out1').warningReason, null);
        assert.deepEqual(proc.killSignals, []);
        assert.equal(db.lastError, null);

        service.shutdown();
    });

    test('progress watchdog still kills while socket warning grace is open', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const ssOutput =
            'CLOSE-WAIT 57 0 10.160.0.30:47178 192.178.174.134:1935 users:(("ffmpeg",pid=1234,fd=6))\n';
        const createOutputService = loadOutputService(t, proc, {
            progressStallMs: 20,
            socketWarmupMs: 10,
            socketGraceMs: 500,
            ssOutput,
        });
        const service = createOutputService(db);
        service.setInputReadyCheck(() => true);

        await service.start('out1');
        proc.stdout.write('total_size=4096\nout_time_ms=1000000\nbitrate=3200.0kbits/s\n');
        await sleep(80);

        assert.deepEqual(proc.killSignals, ['SIGTERM']);
        assert.match(db.lastError, /watchdog: ffmpeg output stalled; restarting process/);

        service.shutdown();
    });

    test('kills and retries when RTMP destination socket stays unhealthy', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const ssOutput =
            'CLOSE-WAIT 57 0 10.160.0.30:47178 192.178.174.134:1935 users:(("ffmpeg",pid=1234,fd=6))\n';
        const createOutputService = loadOutputService(t, proc, {
            progressStallMs: 500,
            socketWarmupMs: 10,
            socketGraceMs: 20,
            ssOutput,
        });
        const service = createOutputService(db);
        service.setInputReadyCheck(() => true);

        await service.start('out1');
        proc.stdout.write('total_size=4096\nout_time_ms=1000000\nbitrate=3200.0kbits/s\n');
        await sleep(80);

        assert.deepEqual(proc.killSignals, ['SIGTERM']);
        assert.equal(service.getStats('out1').status, 'failed');
        assert.equal(service.getStats('out1').failures, 1);
        assert.match(db.lastError, /destination socket unhealthy/);
        assert.match(db.lastError, /CLOSE-WAIT/);
        assert.match(
            db.lastError,
            /socket_warning=RTMP socket CLOSE-WAIT on destination port 1935/,
        );
        assert.match(db.lastError, /socket_snapshot:/);
        assert.match(db.lastError, /CLOSE-WAIT peer=192\.178\.174\.134:1935/);
        assert.match(db.lastError, /last_bitrate_kbps=3200/);
        assert.match(
            db.lastError,
            /Restarting output: RTMP socket CLOSE-WAIT on destination port 1935/,
        );

        service.shutdown();
    });

    test('ignores local RTMP outputs in socket watchdog', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        db.getOutput('out1').sinks = [
            { seq: 1, url: 'rtmp://localhost/live/downstream', audioEncoding: 'copy' },
        ];
        const ssOutput =
            'CLOSE-WAIT 0 0 127.0.0.1:50100 127.0.0.1:1935 users:(("ffmpeg",pid=1234,fd=5))\n';
        const createOutputService = loadOutputService(t, proc, {
            progressStallMs: 500,
            socketWarmupMs: 10,
            socketGraceMs: 20,
            ssOutput,
        });
        const service = createOutputService(db);
        service.setInputReadyCheck(() => true);

        await service.start('out1');
        proc.stdout.write('total_size=4096\nout_time_ms=1000000\nbitrate=3200.0kbits/s\n');
        await sleep(80);

        assert.equal(service.getStats('out1').warningReason, null);
        assert.deepEqual(proc.killSignals, []);
        assert.equal(db.lastError, null);

        service.shutdown();
    });

    test('ignores IPv6 localhost RTMP outputs in socket watchdog', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        db.getOutput('out1').sinks = [
            { seq: 1, url: 'rtmp://[::1]:1935/live/downstream', audioEncoding: 'copy' },
        ];
        const ssOutput = 'CLOSE-WAIT 0 0 [::1]:50100 [::1]:1935 users:(("ffmpeg",pid=1234,fd=5))\n';
        const createOutputService = loadOutputService(t, proc, {
            progressStallMs: 500,
            socketWarmupMs: 10,
            socketGraceMs: 20,
            ssOutput,
        });
        const service = createOutputService(db);
        service.setInputReadyCheck(() => true);

        await service.start('out1');
        proc.stdout.write('total_size=4096\nout_time_ms=1000000\nbitrate=3200.0kbits/s\n');
        await sleep(80);

        assert.equal(service.getStats('out1').warningReason, null);
        assert.deepEqual(proc.killSignals, []);
        assert.equal(db.lastError, null);

        service.shutdown();
    });

    test('keeps RTMP output healthy when remote destination socket is established', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const ssOutput =
            'ESTAB 0 0 10.160.0.30:50532 192.178.174.134:1935 users:(("ffmpeg",pid=1234,fd=6))\n';
        const createOutputService = loadOutputService(t, proc, {
            progressStallMs: 500,
            socketWarmupMs: 10,
            socketGraceMs: 20,
            ssOutput,
        });
        const service = createOutputService(db);
        service.setInputReadyCheck(() => true);

        await service.start('out1');
        proc.stdout.write('total_size=4096\nout_time_ms=1000000\nbitrate=3200.0kbits/s\n');
        await sleep(40);

        assert.equal(service.getStats('out1').warningReason, null);
        assert.deepEqual(proc.killSignals, []);

        service.shutdown();
    });
});
