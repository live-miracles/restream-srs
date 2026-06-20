'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

// Clear SRS env vars so module constants use their defaults
delete process.env.SRS_RTMP_HOST;
delete process.env.SRS_RTMP_PORT;
delete process.env.SRS_SRT_PORT;

const {
    buildFfmpegArgs,
    validateOutputUrl,
    validateAudioEncoding,
} = require('../src/utils/ffmpeg');
const { rtmpPullUrl, srtPullUrl, rtmpPublishUrl, srtPublishUrl } = require('../src/utils/srs');

const sink = (url, audioEncoding = 'copy') => ({ url, audioEncoding });

// ── validateOutputUrl ─────────────────────────────────

describe('validateOutputUrl', () => {
    test('accepts rtmp://', () =>
        assert.ok(validateOutputUrl('rtmp://a.rtmp.youtube.com/live2/key')));
    test('accepts rtmps://', () =>
        assert.ok(validateOutputUrl('rtmps://live-api-s.facebook.com:443/rtmp/key')));
    test('accepts srt://', () => assert.ok(validateOutputUrl('srt://host:10080?streamid=test')));
    test('rejects http://', () => assert.ok(!validateOutputUrl('http://example.com')));
    test('rejects plain string', () => assert.ok(!validateOutputUrl('notaurl')));
    test('rejects empty string', () => assert.ok(!validateOutputUrl('')));
});

// ── buildFfmpegArgs ───────────────────────────────────

describe('buildFfmpegArgs', () => {
    test('includes input URL after -i', () => {
        const args = buildFfmpegArgs('rtmp://in', [sink('rtmp://out')]);
        assert.equal(args[args.indexOf('-i') + 1], 'rtmp://in');
    });

    test('copy encoding copies video only (-c:v copy)', () => {
        const args = buildFfmpegArgs('rtmp://in', [sink('rtmp://out')], 'copy');
        assert.equal(args[args.indexOf('-c:v') + 1], 'copy');
    });

    test('unknown encoding falls back to video copy', () => {
        const args = buildFfmpegArgs('rtmp://in', [sink('rtmp://out')], 'bogus');
        assert.equal(args[args.indexOf('-c:v') + 1], 'copy');
    });

    test('FLV sinks normalize audio timestamps (asetpts+aac), SRT sinks copy', () => {
        const flv = buildFfmpegArgs('rtmp://in', [sink('rtmp://out')], 'copy');
        const srt = buildFfmpegArgs('rtmp://in', [sink('srt://host:10080')], 'copy');
        // FLV: re-encode with timestamp normalization
        assert.ok(flv.includes('-af'));
        assert.ok(flv.some((a) => String(a).includes('asetpts')));
        assert.equal(flv[flv.indexOf('-c:a') + 1], 'aac');
        // SRT: copy (mpegts handles jitter without re-encoding)
        assert.ok(!srt.includes('-af'));
        assert.equal(srt[srt.indexOf('-c:a') + 1], 'copy');
    });

    test('tee path normalizes audio for FLV sinks', () => {
        const mixed = buildFfmpegArgs(
            'rtmp://in',
            [sink('rtmp://out1'), sink('srt://out2:10080')],
            '720p',
        );
        // has FLV sink → normalize
        assert.ok(mixed.some((a) => String(a).includes('asetpts')));
        assert.equal(mixed[mixed.indexOf('-c:a') + 1], 'aac');
    });

    test('tee path copies audio when all sinks are SRT', () => {
        const args = buildFfmpegArgs(
            'rtmp://in',
            [sink('srt://out1:10080'), sink('srt://out2:10080')],
            '720p',
        );
        assert.ok(!args.includes('-af'));
        assert.equal(args[args.indexOf('-c:a') + 1], 'copy');
    });

    test('RTMP sink uses -f flv', () => {
        const args = buildFfmpegArgs('rtmp://in', [sink('rtmp://out')]);
        assert.equal(args[args.lastIndexOf('-f') + 1], 'flv');
    });

    test('SRT sink uses -f mpegts', () => {
        const args = buildFfmpegArgs('rtmp://in', [sink('srt://host:10080')]);
        assert.equal(args[args.lastIndexOf('-f') + 1], 'mpegts');
    });

    test('720p encoding includes 1280:720 scale', () => {
        const args = buildFfmpegArgs('rtmp://in', [sink('rtmp://out')], '720p');
        assert.ok(args.some((a) => String(a).includes('1280:720')));
    });

    test('1080p encoding includes 1920:1080 scale', () => {
        const args = buildFfmpegArgs('rtmp://in', [sink('rtmp://out')], '1080p');
        assert.ok(args.some((a) => String(a).includes('1920:1080')));
    });

    test('always includes -progress pipe:1 for bitrate monitoring', () => {
        const args = buildFfmpegArgs('rtmp://in', [sink('rtmp://out')]);
        assert.equal(args[args.indexOf('-progress') + 1], 'pipe:1');
    });

    test('sets a 10-minute -rw_timeout before -i so a dead input exits', () => {
        const args = buildFfmpegArgs('rtmp://in', [sink('rtmp://out')]);
        const i = args.indexOf('-rw_timeout');
        assert.ok(i >= 0 && i < args.indexOf('-i'));
        assert.equal(args[i + 1], String(10 * 60 * 1_000_000));
    });

    test('suppresses ffmpeg stderr stats spam (-nostats -loglevel warning)', () => {
        const args = buildFfmpegArgs('rtmp://in', [sink('rtmp://out')]);
        assert.ok(args.includes('-nostats'));
        assert.equal(args[args.indexOf('-loglevel') + 1], 'warning');
    });

    test('FLV copy audio maps track 0 explicitly (not ffmpeg default selection)', () => {
        const args = buildFfmpegArgs('rtmp://in', [sink('rtmp://out', 'copy')]);
        const maps = args.filter((a, i) => args[i - 1] === '-map');
        assert.deepEqual(maps, ['0:v:0?', '0:a:0?']);
    });

    test('SRT copy audio adds no -map (ffmpeg default selection)', () => {
        const args = buildFfmpegArgs('rtmp://in', [sink('srt://out:10080', 'copy')]);
        assert.ok(!args.includes('-map'));
    });

    test('selecting a track on an FLV sink maps video + that audio stream', () => {
        const args = buildFfmpegArgs('rtmp://in', [sink('rtmp://out', '1')]);
        const maps = args.filter((a, i) => args[i - 1] === '-map');
        assert.deepEqual(maps, ['0:v:0?', '0:a:1?']);
    });

    test('fans out to multiple sinks in one command (copy encoding, per-output args)', () => {
        const args = buildFfmpegArgs('rtmp://in', [
            sink('rtmp://en', '0'),
            sink('srt://fr:10080', '1'),
        ]);
        // input options precede -i, which precedes the fan-out sink URLs
        assert.ok(args.indexOf('-rw_timeout') < args.indexOf('-i'));
        assert.ok(args.indexOf('-i') < args.indexOf('rtmp://en'));
        assert.ok(args.includes('rtmp://en'));
        assert.ok(args.includes('srt://fr:10080'));
        // one flv output and one mpegts output
        assert.equal(args.filter((a) => a === 'flv').length, 1);
        assert.equal(args.filter((a) => a === 'mpegts').length, 1);
        // FLV sink maps a single track explicitly; SRT sink keeps its own map
        assert.deepEqual(
            args.filter((a, i) => args[i - 1] === '-map'),
            ['0:v:0?', '0:a:0?', '0:v:0', '0:a:1'],
        );
    });

    test('multiple sinks with non-copy encoding and uniform audio use tee muxer', () => {
        const args = buildFfmpegArgs(
            'rtmp://in',
            [sink('rtmp://out1'), sink('srt://out2:10080')],
            '720p',
        );
        // tee muxer: exactly one -f tee
        const fIndices = args.reduce((acc, a, i) => (a === '-f' ? [...acc, i] : acc), []);
        assert.equal(fIndices.length, 1);
        assert.equal(args[fIndices[0] + 1], 'tee');
        // tee spec contains both URLs with correct formats
        const teeSpec = args[args.length - 1];
        assert.ok(teeSpec.includes('[f=flv]rtmp://out1'));
        assert.ok(teeSpec.includes('[f=mpegts]srt://out2:10080'));
        // encoding args appear only once
        assert.equal(args.filter((a) => a === 'libx264').length, 1);
        assert.ok(args.some((a) => String(a).includes('1280:720')));
    });

    test('multiple sinks with non-copy encoding and different audio fall back to per-output args', () => {
        const args = buildFfmpegArgs(
            'rtmp://in',
            [sink('rtmp://out1', '0'), sink('rtmp://out2', '1')],
            '720p',
        );
        // no tee muxer
        assert.ok(!args.includes('tee'));
        assert.ok(args.includes('rtmp://out1'));
        assert.ok(args.includes('rtmp://out2'));
        // encoding applied per sink
        assert.equal(args.filter((a) => a === 'libx264').length, 2);
    });

    test('single sink with non-copy encoding does not use tee', () => {
        const args = buildFfmpegArgs('rtmp://in', [sink('rtmp://out')], '1080p');
        assert.ok(!args.includes('tee'));
        assert.ok(args.some((a) => String(a).includes('1920:1080')));
    });
});

// ── validateAudioEncoding ─────────────────────────────

describe('validateAudioEncoding', () => {
    test('defaults empty/copy to copy', () => {
        assert.equal(validateAudioEncoding(undefined), 'copy');
        assert.equal(validateAudioEncoding(''), 'copy');
        assert.equal(validateAudioEncoding('copy'), 'copy');
    });
    test('accepts single and comma track lists', () => {
        assert.equal(validateAudioEncoding('0'), '0');
        assert.equal(validateAudioEncoding('0, 1 ,2'), '0,1,2');
    });
    test('rejects non-numeric values', () => {
        assert.equal(validateAudioEncoding('a'), null);
        assert.equal(validateAudioEncoding('0,x'), null);
    });
});

// ── URL builders ──────────────────────────────────────

describe('URL builders', () => {
    test('rtmpPullUrl uses default host and port', () => {
        assert.equal(rtmpPullUrl('mykey'), 'rtmp://localhost:1935/live/mykey');
    });

    test('srtPullUrl uses default host and SRT port', () => {
        assert.equal(
            srtPullUrl('mykey'),
            'srt://localhost:10080?streamid=#!::r=live/mykey,m=request',
        );
    });

    test('rtmpPublishUrl', () => {
        assert.equal(rtmpPublishUrl('mykey', 'myhost'), 'rtmp://myhost:1935/live/mykey');
    });

    test('srtPublishUrl', () => {
        assert.equal(
            srtPublishUrl('mykey', 'myhost'),
            'srt://myhost:10080?streamid=#!::r=live/mykey,m=publish',
        );
    });

    test('srtPublishUrl includes passphrase settings when configured', () => {
        assert.equal(
            srtPublishUrl('mykey', 'myhost', 'secret value'),
            'srt://myhost:10080?streamid=#!::r=live/mykey,m=publish&passphrase=secret%20value&pbkeylen=16',
        );
    });
});
