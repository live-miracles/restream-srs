'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

// Clear SRS env vars so module constants use their defaults
delete process.env.SRS_RTMP_HOST;
delete process.env.SRS_RTMP_PORT;

const { buildFfmpegArgs, validateOutputUrl } = require('../src/utils/ffmpeg');
const { rtmpPullUrl, rtmpPublishUrl, srtPublishUrl } = require('../src/utils/srs');

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
        const args = buildFfmpegArgs('rtmp://in', 'rtmp://out');
        assert.equal(args[args.indexOf('-i') + 1], 'rtmp://in');
    });

    test('source encoding uses -c copy', () => {
        const args = buildFfmpegArgs('rtmp://in', 'rtmp://out', 'source');
        assert.equal(args[args.indexOf('-c') + 1], 'copy');
    });

    test('unknown encoding falls back to source (copy)', () => {
        const args = buildFfmpegArgs('rtmp://in', 'rtmp://out', 'bogus');
        assert.ok(args.includes('copy'));
    });

    test('RTMP output uses -f flv', () => {
        const args = buildFfmpegArgs('rtmp://in', 'rtmp://out');
        assert.equal(args[args.lastIndexOf('-f') + 1], 'flv');
    });

    test('SRT output uses -f mpegts', () => {
        const args = buildFfmpegArgs('rtmp://in', 'srt://host:10080');
        assert.equal(args[args.lastIndexOf('-f') + 1], 'mpegts');
    });

    test('720p encoding includes 1280:720 scale', () => {
        const args = buildFfmpegArgs('rtmp://in', 'rtmp://out', '720p');
        assert.ok(args.some((a) => String(a).includes('1280:720')));
    });

    test('1080p encoding includes 1920:1080 scale', () => {
        const args = buildFfmpegArgs('rtmp://in', 'rtmp://out', '1080p');
        assert.ok(args.some((a) => String(a).includes('1920:1080')));
    });

    test('always includes -progress pipe:1 for bitrate monitoring', () => {
        const args = buildFfmpegArgs('rtmp://in', 'rtmp://out');
        assert.equal(args[args.indexOf('-progress') + 1], 'pipe:1');
    });
});

// ── URL builders ──────────────────────────────────────

describe('URL builders', () => {
    test('rtmpPullUrl uses default host and port', () => {
        assert.equal(rtmpPullUrl('mykey'), 'rtmp://localhost:1935/live/mykey');
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
