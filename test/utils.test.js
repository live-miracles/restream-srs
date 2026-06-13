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

    test('copy encoding uses -c copy', () => {
        const args = buildFfmpegArgs('rtmp://in', [sink('rtmp://out')], 'copy');
        assert.equal(args[args.indexOf('-c') + 1], 'copy');
    });

    test('unknown encoding falls back to copy', () => {
        const args = buildFfmpegArgs('rtmp://in', [sink('rtmp://out')], 'bogus');
        assert.ok(args.includes('copy'));
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

    test('copy audio adds no -map (ffmpeg default selection)', () => {
        const args = buildFfmpegArgs('rtmp://in', [sink('rtmp://out', 'copy')]);
        assert.ok(!args.includes('-map'));
    });

    test('selecting a track maps video + that audio stream', () => {
        const args = buildFfmpegArgs('rtmp://in', [sink('rtmp://out', '1')]);
        const maps = args.filter((a, i) => args[i - 1] === '-map');
        assert.deepEqual(maps, ['0:v:0', '0:a:1']);
    });

    test('fans out to multiple sinks in one command', () => {
        const args = buildFfmpegArgs('rtmp://in', [
            sink('rtmp://en', '0'),
            sink('srt://fr:10080', '1'),
        ]);
        assert.equal(args.indexOf('-i'), 0);
        assert.ok(args.includes('rtmp://en'));
        assert.ok(args.includes('srt://fr:10080'));
        // one flv output and one mpegts output
        assert.equal(args.filter((a) => a === 'flv').length, 1);
        assert.equal(args.filter((a) => a === 'mpegts').length, 1);
        assert.deepEqual(
            args.filter((a, i) => args[i - 1] === '-map'),
            ['0:v:0', '0:a:0', '0:v:0', '0:a:1'],
        );
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
