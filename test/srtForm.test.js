'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { buildSrtOutputUrl, isSrtHostRequired } = require('../public/ts/core/srt');

describe('SRT output form rules', () => {
    test('listener mode allows an empty host and binds the default interfaces', () => {
        assert.equal(isSrtHostRequired('listener'), false);
        assert.equal(
            buildSrtOutputUrl({
                mode: 'listener',
                host: '',
                port: 10000,
                latencyMs: null,
                passphrase: '',
                pbKeyLen: null,
                streamId: '',
            }),
            'srt://:10000?mode=listener',
        );
    });

    test('caller mode still requires a host', () => {
        assert.equal(isSrtHostRequired('caller'), true);
    });
});
