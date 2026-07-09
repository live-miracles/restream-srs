'use strict';

const { after, describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restream-srs-preview-'));
const originalCwd = process.cwd();

after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

class FakeFfmpeg extends EventEmitter {
    constructor(pid = 4321) {
        super();
        this.pid = pid;
        this.stderr = new PassThrough();
        this.killSignals = [];
    }

    kill(signal) {
        this.killSignals.push(signal);
        queueMicrotask(() => {
            this.emit('exit', null, signal);
        });
        return true;
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeDb() {
    return {
        getPipeline(id) {
            return id === 1
                ? { id: 1, name: 'Live', streamKey: 'stream-key', streamKeyId: 1 }
                : undefined;
        },
    };
}

function makeInputState() {
    return {
        getProtocol() {
            return 'rtmp';
        },
        pullUrl(_pipelineId, streamKey) {
            return `rtmp://127.0.0.1:1935/live/${streamKey}`;
        },
    };
}

function loadPreviewService(t, spawnImpl) {
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

    t.mock.method(childProcess, 'spawn', spawnImpl);
    delete require.cache[require.resolve('../src/services/preview')];
    return require('../src/services/preview').createPreviewService;
}

// start() resolves only once the playlist exists with a segment reference, so
// write it shortly after the (mocked) ffmpeg is spawned.
async function startWithPlaylist(service, pipelineId, audioTrackCount) {
    const startPromise = service.start(pipelineId, audioTrackCount);
    const playlist =
        audioTrackCount > 1
            ? path.join(tempDir, 'hls', String(pipelineId), 'v0.m3u8')
            : path.join(tempDir, 'hls', String(pipelineId), 'index.m3u8');
    await sleep(20);
    fs.writeFileSync(playlist, '#EXTM3U\nseg0.ts\n', 'utf8');
    return startPromise;
}

describe('preview lifecycle', () => {
    beforeEach(() => {
        process.chdir(tempDir);
    });

    afterEach(async () => {
        // Drain the async fs.rm cleanup triggered by process-exit handlers so
        // it cannot delete the HLS dir the next test just created.
        await sleep(30);
        process.chdir(originalCwd);
        delete require.cache[require.resolve('../src/services/preview')];
        delete require.cache[require.resolve('../src/utils/appConfig')];
    });

    test('passes -rw_timeout to the preview ffmpeg input', async (t) => {
        const proc = new FakeFfmpeg();
        let spawnArgs = null;
        const createPreviewService = loadPreviewService(t, (_cmd, args) => {
            spawnArgs = args;
            return proc;
        });
        const service = createPreviewService(makeDb(), makeInputState());

        const { hlsUrl } = await startWithPlaylist(service, 1, 1);

        assert.equal(hlsUrl, '/hls/1/index.m3u8');
        const rwIdx = spawnArgs.indexOf('-rw_timeout');
        const inIdx = spawnArgs.indexOf('-i');
        assert.notEqual(rwIdx, -1, 'ffmpeg args should include -rw_timeout');
        assert.ok(rwIdx < inIdx, '-rw_timeout must precede -i to apply to the input');

        service.shutdown();
    });

    // TTL values must exceed start()'s playlist-poll cadence (200ms) so the
    // preview is fully started before the reaper is allowed to consider it.
    test('reaps a preview that receives no keepalive within the TTL', async (t) => {
        const proc = new FakeFfmpeg();
        const createPreviewService = loadPreviewService(t, () => proc);
        const service = createPreviewService(makeDb(), makeInputState(), {
            ttlMs: 400,
            reapIntervalMs: 50,
        });

        await startWithPlaylist(service, 1, 1);
        assert.equal(service.keepalive(1), true);

        await sleep(700);

        assert.deepEqual(proc.killSignals, ['SIGTERM']);
        assert.equal(service.keepalive(1), false);

        service.shutdown();
    });

    test('keepalives keep a preview running past the TTL', async (t) => {
        const proc = new FakeFfmpeg();
        const createPreviewService = loadPreviewService(t, () => proc);
        const service = createPreviewService(makeDb(), makeInputState(), {
            ttlMs: 400,
            reapIntervalMs: 50,
        });

        await startWithPlaylist(service, 1, 1);
        for (let i = 0; i < 8; i++) {
            await sleep(100);
            assert.equal(service.keepalive(1), true);
        }

        assert.deepEqual(proc.killSignals, []);

        service.shutdown();
    });

    test('second start returns the running preview URL, not a recomputed one', async (t) => {
        const proc = new FakeFfmpeg();
        let spawnCount = 0;
        const createPreviewService = loadPreviewService(t, () => {
            spawnCount++;
            return proc;
        });
        const service = createPreviewService(makeDb(), makeInputState());

        const first = await startWithPlaylist(service, 1, 1);
        assert.equal(first.hlsUrl, '/hls/1/index.m3u8');

        // A second client asks for a multi-track preview while the single-track
        // one is still running: it must get the playlist the running ffmpeg
        // actually writes, and no second process may be spawned.
        const second = await service.start(1, 3);
        assert.equal(second.hlsUrl, '/hls/1/index.m3u8');
        assert.equal(spawnCount, 1);

        service.shutdown();
    });
});
