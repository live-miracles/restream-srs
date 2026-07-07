'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { hasUsableSrsVideo, isProbeUsable } = require('../src/services/health');

describe('health media probe validation', () => {
    test('accepts video with codec and dimensions', () => {
        assert.equal(
            isProbeUsable({
                video: {
                    codec: 'h264',
                    width: 1920,
                    height: 1080,
                    fps: 50,
                    profile: 'Main',
                    level: '4.2',
                    fieldOrder: 'progressive',
                },
                audio: null,
                audioTracks: [],
            }),
            true,
        );
    });

    test('rejects missing or dimensionless video', () => {
        assert.equal(isProbeUsable(null), false);
        assert.equal(isProbeUsable({ video: null, audio: null, audioTracks: [] }), false);
        assert.equal(
            isProbeUsable({
                video: {
                    codec: 'h264',
                    width: 0,
                    height: 0,
                    fps: null,
                    profile: '',
                    level: '',
                    fieldOrder: null,
                },
                audio: null,
                audioTracks: [],
            }),
            false,
        );
    });
});

describe('SRS stream media validation', () => {
    test('accepts stream stats with codec, dimensions, and positive fps', () => {
        assert.equal(
            hasUsableSrsVideo({
                video: {
                    codec: 'h264',
                    width: 1920,
                    height: 1080,
                    fps: 50,
                    profile: 'Main',
                    level: '4.2',
                },
            }),
            true,
        );
    });

    test('rejects stream stats without positive fps', () => {
        assert.equal(
            hasUsableSrsVideo({
                video: {
                    codec: 'h264',
                    width: 1920,
                    height: 1080,
                    fps: null,
                    profile: 'Main',
                    level: '4.2',
                },
            }),
            false,
        );
    });
});
