'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const childProcess = require('node:child_process');

const originalEnv = { ...process.env };

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

function loadOutputService(t, fakeProc) {
    process.env.OUTPUT_WATCHDOG_WARMUP_MS = '10';
    process.env.OUTPUT_WATCHDOG_STALL_MS = '20';
    process.env.OUTPUT_WATCHDOG_INTERVAL_MS = '10';

    t.mock.method(childProcess, 'spawn', () => fakeProc);
    delete require.cache[require.resolve('../src/services/outputs')];
    return require('../src/services/outputs').createOutputService;
}

describe('output watchdog', () => {
    beforeEach(() => {
        process.env = { ...originalEnv };
    });

    afterEach(() => {
        process.env = { ...originalEnv };
        delete require.cache[require.resolve('../src/services/outputs')];
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
});
