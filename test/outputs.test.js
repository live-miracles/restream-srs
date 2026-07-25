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

after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

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

// Like FakeFfmpeg, but kill() only records the signal — the test controls when
// the process actually exits, so it can interleave calls into the window
// between SIGTERM and the real process exit.
class ManualExitFfmpeg extends EventEmitter {
    constructor(pid = 1234) {
        super();
        this.pid = pid;
        this.stdout = new PassThrough();
        this.stderr = new PassThrough();
        this.killSignals = [];
    }

    kill(signal) {
        this.killSignals.push(signal);
        return true;
    }

    exit(signal = 'SIGTERM') {
        this.emit('exit', null, signal);
        this.emit('close', null, signal);
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
        url: 'rtmp://youtube.example/live/key',
        audioEncoding: 'copy',
        lastError: null,
    };
    return {
        lastError: null,
        lastErrorKind: null,
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
        setOutputLastError(_id, message, kind) {
            this.lastError = `${Date.now()}\n${message}`;
            this.lastErrorKind = kind;
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
                    ...(options.memoryLimitMb !== undefined
                        ? { memory_limit_mb: options.memoryLimitMb }
                        : {}),
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

    t.mock.method(childProcess, 'spawn', () =>
        typeof fakeProc === 'function' ? fakeProc() : fakeProc,
    );
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

function makeReadyInputState(options = {}) {
    return {
        isReady() {
            return true;
        },
        isHighRes() {
            return options.highRes ?? false;
        },
        pullUrl(_pipelineId, streamKey) {
            return `rtmp://127.0.0.1:1935/live/${streamKey}`;
        },
    };
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

    test('kills and retries a running output when ffmpeg output progress stalls', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const createOutputService = loadOutputService(t, proc);
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        proc.stdout.write('total_size=4096\nout_time_ms=1000000\nbitrate=3200.0kbits/s\n');
        proc.stderr.write('Connection reset by peer\n');

        await sleep(80);

        assert.deepEqual(proc.killSignals, ['SIGTERM']);
        assert.equal(service.getStats('out1').status, 'failed');
        assert.equal(service.getStats('out1').failures, 1);
        assert.match(db.lastError, /watchdog: ffmpeg output stalled; restarting process/);
        assert.match(db.lastError, /last_total_size=4096/);
        assert.match(db.lastError, /last_out_time_us=1000000/);
        assert.match(db.lastError, /last_bitrate_kbps=3200/);
        assert.match(db.lastError, /Connection reset by peer/);
        assert.match(db.lastError, /Restarting output: no ffmpeg output progress for \d+s/);

        service.shutdown();
    });

    test('does not kill while ffmpeg output progress continues advancing', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const createOutputService = loadOutputService(t, proc);
        const service = createOutputService(db, makeReadyInputState());

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
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        proc.stdout.write('total_size=4096\nout_time_ms=1000000\n');

        await sleep(80);

        assert.deepEqual(proc.killSignals, ['SIGTERM']);
        assert.equal(service.getStats('out1').status, 'failed');
        assert.equal(service.getStats('out1').failures, 1);

        service.shutdown();
    });

    test('marks warningReason when RSS crosses 70% of the memory limit', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const createOutputService = loadOutputService(t, proc, {
            progressStallMs: 500,
            memoryLimitMb: 200,
        });
        const originalReadFileSync = fs.readFileSync;
        t.mock.method(fs, 'readFileSync', (filePath, ...rest) => {
            if (String(filePath) === `/proc/${proc.pid}/status`) {
                return 'VmRSS:  150000 kB\n'; // ~146MB, 73% of the 200MB limit
            }
            return originalReadFileSync(filePath, ...rest);
        });
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        await sleep(60);

        assert.equal(service.getStats('out1').status, 'running');
        assert.deepEqual(proc.killSignals, []);
        assert.match(service.getStats('out1').warningReason || '', /High memory usage/);
        assert.equal(service.getStats('out1').memoryUsageBytes, 150000 * 1024);
        assert.equal(service.getStats('out1').memoryLimitBytes, 200 * 1024 * 1024);

        service.shutdown();
    });

    test('clears memory warningReason once RSS drops back below the threshold', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const createOutputService = loadOutputService(t, proc, {
            progressStallMs: 500,
            memoryLimitMb: 200,
        });
        let rssKb = 150000; // ~73% of the 200MB limit
        const originalReadFileSync = fs.readFileSync;
        t.mock.method(fs, 'readFileSync', (filePath, ...rest) => {
            if (String(filePath) === `/proc/${proc.pid}/status`) {
                return `VmRSS:  ${rssKb} kB\n`;
            }
            return originalReadFileSync(filePath, ...rest);
        });
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        await sleep(40);
        assert.match(service.getStats('out1').warningReason || '', /High memory usage/);

        rssKb = 50000; // ~24% of the limit
        await sleep(40);
        assert.equal(service.getStats('out1').warningReason, null);
        assert.equal(service.getStats('out1').memoryUsageBytes, 50000 * 1024);
        assert.deepEqual(proc.killSignals, []);

        service.shutdown();
    });

    test('doubles the memory limit for a high-res (4K) input', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const createOutputService = loadOutputService(t, proc, {
            progressStallMs: 500,
            memoryLimitMb: 200,
        });
        const originalReadFileSync = fs.readFileSync;
        t.mock.method(fs, 'readFileSync', (filePath, ...rest) => {
            if (String(filePath) === `/proc/${proc.pid}/status`) {
                return 'VmRSS:  300000 kB\n'; // ~293MB: over the 200MB base limit, under the doubled 400MB limit
            }
            return originalReadFileSync(filePath, ...rest);
        });
        const service = createOutputService(db, makeReadyInputState({ highRes: true }));

        await service.start('out1');
        await sleep(60);

        assert.equal(service.getStats('out1').status, 'running');
        assert.deepEqual(proc.killSignals, []);
        assert.equal(service.getStats('out1').memoryLimitBytes, 200 * 1024 * 1024 * 2);
        assert.match(service.getStats('out1').warningReason || '', /High memory usage/);

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
        const service = createOutputService(db, makeReadyInputState());

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
        const service = createOutputService(db, makeReadyInputState());

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
        const service = createOutputService(db, makeReadyInputState());

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
        const service = createOutputService(db, makeReadyInputState());

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
        db.getOutput('out1').url = 'rtmp://localhost/live/downstream';
        const ssOutput =
            'CLOSE-WAIT 0 0 127.0.0.1:50100 127.0.0.1:1935 users:(("ffmpeg",pid=1234,fd=5))\n';
        const createOutputService = loadOutputService(t, proc, {
            progressStallMs: 500,
            socketWarmupMs: 10,
            socketGraceMs: 20,
            ssOutput,
        });
        const service = createOutputService(db, makeReadyInputState());

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
        db.getOutput('out1').url = 'rtmp://[::1]:1935/live/downstream';
        const ssOutput = 'CLOSE-WAIT 0 0 [::1]:50100 [::1]:1935 users:(("ffmpeg",pid=1234,fd=5))\n';
        const createOutputService = loadOutputService(t, proc, {
            progressStallMs: 500,
            socketWarmupMs: 10,
            socketGraceMs: 20,
            ssOutput,
        });
        const service = createOutputService(db, makeReadyInputState());

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
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        proc.stdout.write('total_size=4096\nout_time_ms=1000000\nbitrate=3200.0kbits/s\n');
        await sleep(40);

        assert.equal(service.getStats('out1').warningReason, null);
        assert.deepEqual(proc.killSignals, []);

        service.shutdown();
    });
});

describe('output stop/start race', () => {
    beforeEach(() => {
        process.chdir(tempDir);
    });

    afterEach(() => {
        process.chdir(originalCwd);
        delete require.cache[require.resolve('../src/services/outputs')];
        delete require.cache[require.resolve('../src/utils/appConfig')];
    });

    test('restarts an output when start arrives while a stop kill is in flight', async (t) => {
        const procs = [];
        const spawnNext = () => {
            const proc = new ManualExitFfmpeg(1000 + procs.length);
            procs.push(proc);
            return proc;
        };
        const db = makeDb();
        const output = db.getOutput('out1');
        const createOutputService = loadOutputService(t, spawnNext, { progressStallMs: 60_000 });
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        assert.equal(procs.length, 1);
        assert.equal(service.getStats('out1').status, 'running');

        // Operator clicks Stop: desiredState flips first (API order), then the
        // kill is issued. The process has not exited yet.
        output.desiredState = 'stopped';
        service.stop('out1');
        assert.deepEqual(procs[0].killSignals, ['SIGTERM']);
        assert.equal(service.getStats('out1').status, 'running');

        // Operator clicks Start again before ffmpeg finishes dying. start()
        // still sees status 'running' and returns without spawning.
        output.desiredState = 'running';
        await service.start('out1');
        assert.equal(procs.length, 1);

        // The old process now exits from the SIGTERM. The requested-stop exit
        // must notice desiredState is 'running' again and respawn.
        procs[0].exit();
        await sleep(30);

        assert.equal(procs.length, 2, 'a replacement ffmpeg should have been spawned');
        assert.equal(service.getStats('out1').status, 'running');
        assert.equal(service.getStats('out1').failures, 0);

        service.shutdown();
    });

    test('does not restart when the output stays stopped', async (t) => {
        const procs = [];
        const spawnNext = () => {
            const proc = new ManualExitFfmpeg(1000 + procs.length);
            procs.push(proc);
            return proc;
        };
        const db = makeDb();
        const output = db.getOutput('out1');
        const createOutputService = loadOutputService(t, spawnNext, { progressStallMs: 60_000 });
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        output.desiredState = 'stopped';
        service.stop('out1');
        procs[0].exit();
        await sleep(30);

        assert.equal(procs.length, 1);
        assert.equal(service.getStats('out1').status, 'stopped');

        service.shutdown();
    });

    test('stopping during a retry backoff (no live process) still records a stopped marker', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const output = db.getOutput('out1');
        const createOutputService = loadOutputService(t, proc, { progressStallMs: 60_000 });
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        // Simulate ffmpeg crashing on its own (not via kill()) — the close
        // handler records a 'crash' entry, clears `processes`, and schedules
        // a retry a second or two out. No SIGTERM was sent, so this differs
        // from the SIGTERM-in-flight race covered above.
        proc.emit('close', 1, null);

        assert.equal(db.lastErrorKind, 'crash');
        assert.equal(service.getStats('out1').status, 'failed');

        // Operator clicks Stop while the output sits in that retry-backoff
        // gap — there's no live process for service.stop() to kill, so the
        // close handler (which normally writes the 'stopped' marker) never
        // runs. stop() must record it directly, or the crash above stays
        // the newest history entry forever and keeps showing as current.
        output.desiredState = 'stopped';
        service.stop('out1');

        assert.equal(service.getStats('out1').status, 'stopped');
        assert.equal(db.lastErrorKind, 'stopped');
        assert.match(db.lastError, /\n$/);

        service.shutdown();
    });

    test('stopping an output with pending stderr records it as a stopped-kind diagnostic entry', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const output = db.getOutput('out1');
        const createOutputService = loadOutputService(t, proc, { progressStallMs: 60_000 });
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        proc.stderr.write('Connection stuck, retrying handshake...\n');
        await sleep(15);

        output.desiredState = 'stopped';
        service.stop('out1');
        await sleep(15);

        assert.equal(service.getStats('out1').status, 'stopped');
        assert.equal(db.lastErrorKind, 'stopped');
        assert.match(db.lastError, /Connection stuck, retrying handshake/);

        service.shutdown();
    });

    test('stopping a clean output still records an empty stopped-kind marker', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const output = db.getOutput('out1');
        const createOutputService = loadOutputService(t, proc, { progressStallMs: 60_000 });
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        await sleep(15);

        output.desiredState = 'stopped';
        service.stop('out1');
        await sleep(15);

        // Written unconditionally (even with no stderr) so it becomes the
        // newest history entry and immediately supersedes any earlier crash,
        // instead of leaving a stale crash as the "current" error.
        assert.equal(service.getStats('out1').status, 'stopped');
        assert.equal(db.lastErrorKind, 'stopped');
        assert.match(db.lastError, /\n$/);

        service.shutdown();
    });

    test('shutdown does not record diagnostic entries even with pending stderr', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const createOutputService = loadOutputService(t, proc, { progressStallMs: 60_000 });
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        proc.stderr.write('some routine warning\n');
        await sleep(15);

        service.shutdown();
        await sleep(15);

        assert.equal(db.lastError, null);
    });
});

describe('output service control surface', () => {
    beforeEach(() => {
        process.chdir(tempDir);
    });

    afterEach(() => {
        process.chdir(originalCwd);
        delete require.cache[require.resolve('../src/services/outputs')];
        delete require.cache[require.resolve('../src/utils/appConfig')];
    });

    test('start() throws for an unknown output id and never spawns', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const createOutputService = loadOutputService(t, proc, { progressStallMs: 60_000 });
        const service = createOutputService(db, makeReadyInputState());

        await assert.rejects(() => service.start('does-not-exist'), /Output not found/);
        assert.equal(service.getStats('does-not-exist').status, 'stopped');

        service.shutdown();
    });

    test('start() throws for an invalid destination URL and never spawns', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        db.getOutput('out1').url = 'not-a-url';
        const createOutputService = loadOutputService(t, proc, { progressStallMs: 60_000 });
        const service = createOutputService(db, makeReadyInputState());

        await assert.rejects(() => service.start('out1'), /Invalid output URL/);
        assert.equal(service.getStats('out1').status, 'stopped');

        service.shutdown();
    });

    test('start() does not spawn while the input is not ready, and getStats stays stopped', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const createOutputService = loadOutputService(t, proc, { progressStallMs: 60_000 });
        const notReady = {
            isReady: () => false,
            isHighRes: () => false,
            pullUrl: () => 'rtmp://x',
        };
        const service = createOutputService(db, notReady);

        await service.start('out1');

        assert.equal(service.getStats('out1').status, 'stopped');
        assert.equal(service.getStats('out1').pid, null);

        service.shutdown();
    });

    test('a second concurrent start() while one is already running does not spawn twice', async (t) => {
        let spawnCount = 0;
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const createOutputService = loadOutputService(t, () => {
            spawnCount++;
            return proc;
        });
        const service = createOutputService(db, makeReadyInputState());

        await Promise.all([service.start('out1'), service.start('out1')]);

        assert.equal(spawnCount, 1);
        assert.equal(service.getStats('out1').status, 'running');

        service.shutdown();
    });

    test('getStats for an output that was never started returns stopped defaults', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const createOutputService = loadOutputService(t, proc, { progressStallMs: 60_000 });
        const service = createOutputService(db, makeReadyInputState());

        const stats = service.getStats('out1');
        assert.deepEqual(stats, {
            status: 'stopped',
            pid: null,
            bitrateKbps: null,
            startedAtMs: null,
            failures: 0,
            warningReason: null,
            memoryUsageBytes: null,
            memoryLimitBytes: null,
            cpuPercent: null,
        });

        service.shutdown();
    });

    test('stopAndWait resolves only after the process actually exits', async (t) => {
        const proc = new ManualExitFfmpeg();
        const db = makeDb();
        const createOutputService = loadOutputService(t, proc, { progressStallMs: 60_000 });
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        let resolved = false;
        const p = service.stopAndWait('out1').then(() => {
            resolved = true;
        });

        await sleep(15);
        assert.equal(resolved, false, 'must not resolve before the process exits');
        assert.deepEqual(proc.killSignals, ['SIGTERM']);

        proc.exit();
        await p;
        assert.equal(resolved, true);
        assert.equal(service.getStats('out1').status, 'stopped');

        service.shutdown();
    });

    test('stopAndWait on an already-stopped output resolves immediately', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const createOutputService = loadOutputService(t, proc, { progressStallMs: 60_000 });
        const service = createOutputService(db, makeReadyInputState());

        await service.stopAndWait('out1');
        assert.equal(service.getStats('out1').status, 'stopped');

        service.shutdown();
    });

    test('clearRetryState cancels a pending scheduled retry so it never fires', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const output = db.getOutput('out1');
        const createOutputService = loadOutputService(t, proc, { progressStallMs: 60_000 });
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        // Crash: schedules a retry ~1s out via RETRY_DELAYS_MS[0].
        proc.emit('close', 1, null);
        assert.equal(service.getStats('out1').status, 'failed');
        assert.equal(service.getStats('out1').failures, 1);

        service.clearRetryState('out1');
        output.desiredState = 'stopped';
        // Give the (cancelled) retry timer a chance to fire if it wasn't
        // actually cancelled — if it fires, tryStart would spawn a 2nd proc.
        await sleep(30);

        assert.equal(service.getStats('out1').status, 'failed');

        service.shutdown();
    });
});

describe('restartPipelineOutputs', () => {
    beforeEach(() => {
        process.chdir(tempDir);
    });

    afterEach(() => {
        process.chdir(originalCwd);
        delete require.cache[require.resolve('../src/services/outputs')];
        delete require.cache[require.resolve('../src/utils/appConfig')];
    });

    function makeMultiDb(outputs) {
        const byId = new Map(outputs.map((o) => [o.id, o]));
        return {
            lastError: null,
            lastErrorKind: null,
            getPipeline(id) {
                return id === 1
                    ? { id: 1, name: 'Live', streamKey: 'stream-key', streamKeyId: 1 }
                    : null;
            },
            getOutput(id) {
                return byId.get(id) ?? null;
            },
            listOutputsForPipeline(pipelineId) {
                return outputs.filter((o) => o.pipelineId === pipelineId);
            },
            setOutputLastError(_id, message, kind) {
                this.lastError = `${Date.now()}\n${message}`;
                this.lastErrorKind = kind;
            },
        };
    }

    function makeOutput(id, overrides = {}) {
        return {
            id,
            pipelineId: 1,
            seq: 1,
            name: id,
            desiredState: 'running',
            videoEncoding: 'copy',
            url: 'rtmp://youtube.example/live/key',
            audioEncoding: 'copy',
            lastError: null,
            ...overrides,
        };
    }

    test('only schedules outputs whose desiredState is running, and returns that count', async (t) => {
        const spawned = [];
        const createOutputService = loadOutputService(
            t,
            () => {
                const p = new FakeFfmpeg(1000 + spawned.length);
                spawned.push(p);
                return p;
            },
            { progressStallMs: 60_000 },
        );
        const db = makeMultiDb([
            makeOutput('a', { desiredState: 'running' }),
            makeOutput('b', { desiredState: 'stopped' }),
            makeOutput('c', { desiredState: 'running' }),
        ]);
        const service = createOutputService(db, makeReadyInputState());

        const scheduled = service.restartPipelineOutputs(1, 0);
        assert.equal(scheduled, 2);

        await sleep(700);
        assert.equal(service.getStats('a').status, 'running');
        assert.equal(service.getStats('b').status, 'stopped');
        assert.equal(service.getStats('c').status, 'running');

        service.shutdown();
    });

    test('skips outputs already actively running instead of double-spawning', async (t) => {
        const spawned = [];
        const createOutputService = loadOutputService(
            t,
            () => {
                const p = new FakeFfmpeg(1000 + spawned.length);
                spawned.push(p);
                return p;
            },
            { progressStallMs: 60_000 },
        );
        const db = makeMultiDb([makeOutput('a', { desiredState: 'running' })]);
        const service = createOutputService(db, makeReadyInputState());

        await service.start('a');
        assert.equal(spawned.length, 1);

        const scheduled = service.restartPipelineOutputs(1, 0);
        assert.equal(scheduled, 0);

        await sleep(300);
        assert.equal(
            spawned.length,
            1,
            'must not spawn a second ffmpeg for an already-running output',
        );

        service.shutdown();
    });

    test('staggers restarts and resets each failure counter to 0', async (t) => {
        const spawned = [];
        const createOutputService = loadOutputService(
            t,
            () => {
                const p = new FakeFfmpeg(1000 + spawned.length);
                spawned.push(p);
                return p;
            },
            { progressStallMs: 60_000 },
        );
        const db = makeMultiDb([
            makeOutput('a', { desiredState: 'running' }),
            makeOutput('b', { desiredState: 'running' }),
        ]);
        const service = createOutputService(db, makeReadyInputState());

        // Give 'a' a prior failure (simulating an earlier crash, not a
        // deliberate stop) so we can confirm the restart resets its counter.
        await service.start('a');
        spawned[0].emit('close', 1, null);
        assert.equal(service.getStats('a').status, 'failed');
        assert.equal(service.getStats('a').failures, 1);

        const scheduled = service.restartPipelineOutputs(1, 0);
        assert.equal(scheduled, 2);

        // Immediately after scheduling, staggering means not everything has
        // spawned yet (spacing is on the order of hundreds of ms).
        await sleep(10);
        assert.ok(spawned.length < 3, 'restarts should be staggered, not instantaneous');

        await sleep(700);
        assert.equal(service.getStats('a').status, 'running');
        assert.equal(service.getStats('a').failures, 0);
        assert.equal(service.getStats('b').status, 'running');
        assert.equal(service.getStats('b').failures, 0);

        service.shutdown();
    });

    test('a nonexistent pipeline schedules nothing and does not throw', async (t) => {
        const proc = new FakeFfmpeg();
        const createOutputService = loadOutputService(t, proc);
        const db = makeMultiDb([]);
        const service = createOutputService(db, makeReadyInputState());

        const scheduled = service.restartPipelineOutputs(9999, 0);
        assert.equal(scheduled, 0);

        service.shutdown();
    });
});
