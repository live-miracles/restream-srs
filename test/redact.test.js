'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { redactSecrets, redactUrl, secretTokensFromUrl } = require('../src/utils/redact');

// Captured from a real ffmpeg 7.1 run at -loglevel warning.
const OUTPUT_FAILURE = `[tcp @ 0x146f059e0] Connection to tcp://127.0.0.1:9?tcp_nodelay=0 failed: Connection refused
[rtmp @ 0x146e34910] Cannot open connection tcp://127.0.0.1:9?tcp_nodelay=0
[out#0/flv @ 0x146e30670] Error opening output rtmp://a.rtmp.youtube.com/live2/YT-SECRET-STREAMKEY-abcd: Connection refused
Error opening output file rtmp://a.rtmp.youtube.com/live2/YT-SECRET-STREAMKEY-abcd.
Error opening output files: Connection refused`;

const SRT_INPUT_FAILURE =
    '[srt @ 0x14ce31780] Connection to srt://127.0.0.1:10080?streamid=#!::r=live/key01_0123456789abcdef0123456789abcdef,m=request&latency=200000&transtype=live&timeout=1000000&passphrase=SECRETSRTPASS123&pbkeylen=16 failed: Operation timed out\n' +
    'Error opening input file srt://127.0.0.1:10080?streamid=#!::r=live/key01_0123456789abcdef0123456789abcdef,m=request&passphrase=SECRETSRTPASS123&pbkeylen=16.';

describe('redactSecrets', () => {
    test('keeps host and app of an RTMP destination but drops the stream key', () => {
        const out = redactSecrets(OUTPUT_FAILURE);

        assert.ok(!out.includes('YT-SECRET-STREAMKEY'));
        assert.ok(out.includes('rtmp://a.rtmp.youtube.com/live2/<redacted>: Connection refused'));
        assert.ok(out.includes('rtmp://a.rtmp.youtube.com/live2/<redacted>.\n'));
        // URLs with no secret in them are left alone.
        assert.ok(out.includes('tcp://127.0.0.1:9?tcp_nodelay=0'));
    });

    test('drops SRT passphrase and streamid values but keeps host, port and tuning params', () => {
        const out = redactSecrets(SRT_INPUT_FAILURE);

        assert.ok(!out.includes('SECRETSRTPASS123'));
        assert.ok(!out.includes('key01_0123456789abcdef'));
        assert.ok(out.includes('srt://127.0.0.1:10080?streamid=<redacted>&latency=200000'));
        assert.ok(out.includes('passphrase=<redacted>'));
        assert.ok(out.includes('Operation timed out'));
    });

    test('scrubs a bare internal stream key and a bare passphrase outside any URL', () => {
        const out = redactSecrets(
            'publish key07_aabbccddeeff00112233445566778899 ok passphrase=hunter2hunter2 done',
        );

        assert.equal(out, 'publish key07_<redacted> ok passphrase=<redacted> done');
    });

    test('scrubs known standalone tokens (a key echoed without its URL)', () => {
        const out = redactSecrets('server said: bad key abc-DEF-123-xyz', ['abc-DEF-123-xyz']);

        assert.equal(out, 'server said: bad key <redacted>');
    });

    test('ignores very short tokens so ordinary words are not mangled', () => {
        assert.equal(redactSecrets('live on air', ['live', 'on']), 'live on air');
    });

    test('drops userinfo and a key hidden in a query string', () => {
        assert.equal(
            redactUrl('rtmps://user:pw@ingest.example.com:443/app?key=SECRET'),
            'rtmps://ingest.example.com:443/app/<redacted>',
        );
    });

    test('leaves a URL that has only an app segment as is', () => {
        assert.equal(redactUrl('rtmp://host:1935/live'), 'rtmp://host:1935/live');
    });

    test('is a no-op on text without secrets', () => {
        const text = '[flv @ 0x1] Non-monotonous DTS in output stream 0:1; previous: 5, current: 3';
        assert.equal(redactSecrets(text), text);
    });
});

describe('secretTokensFromUrl', () => {
    test('returns the key segment and the passphrase/streamid values', () => {
        assert.deepEqual(secretTokensFromUrl('rtmp://h/live2/KEY-123456'), ['KEY-123456']);
        assert.deepEqual(
            secretTokensFromUrl('srt://h:9?streamid=abc123456&passphrase=pass123456&latency=1'),
            ['abc123456', 'pass123456'],
        );
        assert.deepEqual(secretTokensFromUrl('not a url'), []);
    });
});
