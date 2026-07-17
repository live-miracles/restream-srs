'use strict';

const { after, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restream-srs-utils-'));
const originalCwd = process.cwd();
const srsConfPath = path.join(tempDir, 'srs.conf');
process.chdir(tempDir);
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
    srsConfPath,
    'listen 1935;\nsrs_log_file ./objs/srs.log;\nhttp_api {\n    enabled on;\n    listen 1985;\n}\nsrt_server {\n    enabled on;\n    listen 10080;\n}\n',
    'utf8',
);

const {
    buildFfmpegArgs,
    validateOutputUrl,
    validateAudioEncoding,
} = require('../src/utils/ffmpeg');
const { rtmpPullUrl, srtPullUrl, rtmpPublishUrl, srtPublishUrl } = require('../src/utils/srs');

after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

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
        const args = buildFfmpegArgs('rtmp://in', 'rtmp://out', 'copy');
        assert.equal(args[args.indexOf('-i') + 1], 'rtmp://in');
    });

    test('copy encoding copies video only (-c:v copy)', () => {
        const args = buildFfmpegArgs('rtmp://in', 'rtmp://out', 'copy', 'copy');
        assert.equal(args[args.indexOf('-c:v') + 1], 'copy');
    });

    test('unknown encoding falls back to video copy', () => {
        const args = buildFfmpegArgs('rtmp://in', 'rtmp://out', 'copy', 'bogus');
        assert.equal(args[args.indexOf('-c:v') + 1], 'copy');
    });

    test("'copy' always copies audio verbatim, regardless of origin/destination protocol", () => {
        const cases = [
            buildFfmpegArgs('rtmp://in', 'rtmp://out', 'copy', 'copy'),
            buildFfmpegArgs('srt://in:10080', 'rtmp://out', 'copy', 'copy'),
            buildFfmpegArgs('rtmp://in', 'srt://host:10080', 'copy', 'copy'),
            buildFfmpegArgs('srt://in:10080', 'srt://host:10080', 'copy', 'copy'),
        ];
        for (const args of cases) {
            assert.ok(!args.includes('-af'));
            assert.equal(args[args.indexOf('-c:a') + 1], 'copy');
        }
    });

    test("'aac' forces a transcode; SRT origin adds the jitter filter, RTMP origin doesn't", () => {
        const fromRtmp = buildFfmpegArgs('rtmp://in', 'rtmp://out', 'aac', 'copy');
        assert.ok(!fromRtmp.includes('-af'));
        assert.equal(fromRtmp[fromRtmp.indexOf('-c:a') + 1], 'aac');

        const fromSrt = buildFfmpegArgs('srt://in:10080', 'rtmp://out', 'aac', 'copy');
        assert.ok(fromSrt.includes('-af'));
        assert.ok(fromSrt.some((a) => String(a).includes('aresample')));
        assert.equal(fromSrt[fromSrt.indexOf('-c:a') + 1], 'aac');
    });

    test("'aac' forces a transcode even into an SRT destination", () => {
        const args = buildFfmpegArgs('srt://in:10080', 'srt://host:10080', 'aac', 'copy');
        assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
    });

    test('an explicit track selection also forces a transcode, regardless of origin', () => {
        const args = buildFfmpegArgs('rtmp://in', 'rtmp://out', '1', 'copy');
        assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
    });

    test('RTMP destination uses -f flv', () => {
        const args = buildFfmpegArgs('rtmp://in', 'rtmp://out', 'copy');
        assert.equal(args[args.lastIndexOf('-f') + 1], 'flv');
    });

    test('SRT destination uses -f mpegts', () => {
        const args = buildFfmpegArgs('rtmp://in', 'srt://host:10080', 'copy');
        assert.equal(args[args.lastIndexOf('-f') + 1], 'mpegts');
    });

    test('720p encoding includes 1280:720 scale', () => {
        const args = buildFfmpegArgs('rtmp://in', 'rtmp://out', 'copy', '720p');
        assert.ok(args.some((a) => String(a).includes('1280:720')));
    });

    test('1080p encoding includes 1920:1080 scale', () => {
        const args = buildFfmpegArgs('rtmp://in', 'rtmp://out', 'copy', '1080p');
        assert.ok(args.some((a) => String(a).includes('1920:1080')));
    });

    test('always includes -progress pipe:1 for bitrate monitoring', () => {
        const args = buildFfmpegArgs('rtmp://in', 'rtmp://out', 'copy');
        assert.equal(args[args.indexOf('-progress') + 1], 'pipe:1');
    });

    test('sets a 10-minute -rw_timeout before -i so a dead input exits', () => {
        const args = buildFfmpegArgs('rtmp://in', 'rtmp://out', 'copy');
        const i = args.indexOf('-rw_timeout');
        assert.ok(i >= 0 && i < args.indexOf('-i'));
        assert.equal(args[i + 1], String(10 * 60 * 1_000_000));
    });

    test('suppresses ffmpeg stderr stats spam (-nostats -loglevel warning)', () => {
        const args = buildFfmpegArgs('rtmp://in', 'rtmp://out', 'copy');
        assert.ok(args.includes('-nostats'));
        assert.equal(args[args.indexOf('-loglevel') + 1], 'warning');
    });

    test('FLV copy audio maps track 0 explicitly (not ffmpeg default selection)', () => {
        const args = buildFfmpegArgs('rtmp://in', 'rtmp://out', 'copy');
        const maps = args.filter((a, i) => args[i - 1] === '-map');
        assert.deepEqual(maps, ['0:v:0?', '0:a:0?']);
    });

    test('SRT copy audio adds no -map (ffmpeg default selection)', () => {
        const args = buildFfmpegArgs('rtmp://in', 'srt://out:10080', 'copy');
        assert.ok(!args.includes('-map'));
    });

    test("'aac' maps track 0 explicitly, same as 'copy' (it's a codec choice, not a track selector)", () => {
        const flv = buildFfmpegArgs('rtmp://in', 'rtmp://out', 'aac');
        assert.deepEqual(
            flv.filter((a, i) => flv[i - 1] === '-map'),
            ['0:v:0?', '0:a:0?'],
        );
        const srt = buildFfmpegArgs('rtmp://in', 'srt://out:10080', 'aac');
        assert.ok(!srt.includes('-map'));
    });

    test('selecting a track on an FLV destination maps video + that audio stream', () => {
        const args = buildFfmpegArgs('rtmp://in', 'rtmp://out', '1');
        const maps = args.filter((a, i) => args[i - 1] === '-map');
        assert.deepEqual(maps, ['0:v:0?', '0:a:1?']);
    });

    test('SRT destination URL parameters are passed through unchanged', () => {
        const url = 'srt://host:10080?mode=caller&latency=240000&streamid=x';
        const args = buildFfmpegArgs('rtmp://in', url, 'copy');
        assert.ok(args.includes(url));
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
    test("accepts 'aac' (explicit transcode opt-in)", () => {
        assert.equal(validateAudioEncoding('aac'), 'aac');
    });
    test('rejects non-numeric values', () => {
        assert.equal(validateAudioEncoding('a'), null);
        assert.equal(validateAudioEncoding('0,x'), null);
    });
});

// ── URL builders ──────────────────────────────────────

describe('URL builders', () => {
    test('rtmpPullUrl uses default host and port', () => {
        assert.equal(rtmpPullUrl('mykey'), 'rtmp://127.0.0.1:1935/live/mykey');
    });

    test('srtPullUrl uses default host and SRT port', () => {
        assert.equal(
            srtPullUrl('mykey'),
            'srt://127.0.0.1:10080?streamid=#!::r=live/mykey,m=request&latency=200000&transtype=live',
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

    test('SRT URLs use srs.conf srt_server listen port', () => {
        fs.writeFileSync(
            srsConfPath,
            'listen 1935;\nsrs_log_file ./objs/srs.log;\nhttp_api {\n    enabled on;\n    listen 1985;\n}\nsrt_server {\n    enabled on;\n    listen 12080;\n}\n',
            'utf8',
        );
        delete require.cache[require.resolve('../src/utils/srsConfig')];
        delete require.cache[require.resolve('../src/utils/srs')];
        const {
            srtPullUrl: configuredSrtPullUrl,
            srtPublishUrl: configuredSrtPublishUrl,
        } = require('../src/utils/srs');

        assert.equal(
            configuredSrtPullUrl('mykey'),
            'srt://127.0.0.1:12080?streamid=#!::r=live/mykey,m=request&latency=200000&transtype=live',
        );
        assert.equal(
            configuredSrtPublishUrl('mykey', 'myhost'),
            'srt://myhost:12080?streamid=#!::r=live/mykey,m=publish',
        );
    });

    test('srtPullUrl includes srt_server passphrase from srs.conf', () => {
        fs.writeFileSync(
            srsConfPath,
            'listen 1935;\nsrs_log_file ./objs/srs.log;\nhttp_api {\n    enabled on;\n    listen 1985;\n}\nsrt_server {\n    enabled on;\n    listen 10080;\n    passphrase supersecretpass;\n}\n',
            'utf8',
        );
        delete require.cache[require.resolve('../src/utils/srsConfig')];
        delete require.cache[require.resolve('../src/utils/srs')];
        const { srtPullUrl: configuredSrtPullUrl } = require('../src/utils/srs');

        assert.equal(
            configuredSrtPullUrl('mykey'),
            'srt://127.0.0.1:10080?streamid=#!::r=live/mykey,m=request&latency=200000&transtype=live&passphrase=supersecretpass&pbkeylen=16',
        );
    });
});
