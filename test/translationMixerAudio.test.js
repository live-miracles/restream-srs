'use strict';

// Every other translation-mixer test either checks buildTranslationMixerArgs'
// argument *shape* (utils.test.js) or drives the mixer service against a
// mocked child_process.spawn (translationMixer.test.js). Neither would catch
// a bug inside the actual filter_complex string itself — a wrong track index,
// a broken amix/adelay expression, or an accidentally-muted leg. These tests
// run the real production filter graph through a real ffmpeg process against
// synthetic audio and check the resulting file's actual signal, so a filter
// graph that silently drops one leg of the mix fails here even though every
// other test still passes.

const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildTranslationMixerArgs } = require('../src/utils/ffmpeg');

const ffmpegProbe = spawnSync('ffmpeg', ['-version']);
const ffmpegAvailable = !ffmpegProbe.error && ffmpegProbe.status === 0;
const skip = ffmpegAvailable ? false : 'ffmpeg is not available on PATH';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restream-srs-mixer-audio-'));
after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
});

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

// Renders a short synthetic clip via a real ffmpeg lavfi source: either a
// steady tone (a stand-in for "there is audio here") or true digital silence.
function renderClip(name, kind) {
    const outPath = path.join(tempDir, name);
    const source =
        kind === 'silence'
            ? 'anullsrc=r=48000:cl=stereo:d=1'
            : 'sine=frequency=440:duration=1:sample_rate=48000';
    const result = spawnSync('ffmpeg', [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        source,
        outPath,
    ]);
    assert.equal(result.status, 0, `failed to render ${name}: ${result.stderr}`);
    return outPath;
}

// Runs the real translation-mixer filter graph (the same function the mixer
// service calls) through a real ffmpeg process, with the same stdio shape
// production uses (fd 3 carries the astats/ametadata meter — draining it here
// mirrors the mixer service so ffmpeg never blocks writing to an unread pipe).
async function runMixer(sourcePath, translatorPath, outName) {
    const outPath = path.join(tempDir, outName);
    const controlPort = await getFreePort();
    const args = buildTranslationMixerArgs(sourcePath, translatorPath, outPath, {
        videoEncoding: 'copy',
        translationDelayMs: 0,
        voiceThresholdDb: -20,
        controlPort,
        duckVolumePercent: 6,
        duckDurationMs: 900,
        restoreSilenceMs: 2000,
        restoreVolumePercent: 50,
        restoreDurationMs: 5000,
    });
    await new Promise((resolve, reject) => {
        const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        child.stdio[3].on('data', () => {});
        child.stdout.on('data', () => {});
        child.once('error', reject);
        child.once('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`mixer ffmpeg exited ${code}\n${stderr.slice(-2000)}`));
        });
    });
    return outPath;
}

// True digital silence prints "-inf" for every RMS/Peak line; any real signal
// prints a finite dB value instead — a clean binary marker, unlike
// volumedetect's noisy noise-floor readings.
function hasAudioSignal(filePath) {
    const result = spawnSync('ffmpeg', [
        '-hide_banner',
        '-i',
        filePath,
        '-vn',
        '-af',
        'astats=metadata=0',
        '-f',
        'null',
        '-',
    ]);
    return /RMS level dB:\s*-?\d/.test(result.stderr.toString());
}

test('translator speech reaches the output even when the source is silent', { skip }, async () => {
    const source = renderClip('silent-source.wav', 'silence');
    const translator = renderClip('speaking-translator.wav', 'tone');
    const mixed = await runMixer(source, translator, 'translator-through.flv');
    assert.equal(hasAudioSignal(mixed), true, 'expected translator audio in the mixed output');
});

test(
    'the output stays audible when the translator is silent but the source is not',
    { skip },
    async () => {
        const source = renderClip('speaking-source.wav', 'tone');
        const translator = renderClip('silent-translator.wav', 'silence');
        const mixed = await runMixer(source, translator, 'source-through.flv');
        assert.equal(hasAudioSignal(mixed), true, 'expected source audio in the mixed output');
    },
);
