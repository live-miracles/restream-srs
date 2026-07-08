'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { isProbeUsable, localSrtOutputTargetsStream } = require('../src/services/health');

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

describe('health local SRT output detection', () => {
    test('matches local SRS SRT outputs by stream resource', () => {
        assert.equal(
            localSrtOutputTargetsStream(
                'srt://127.0.0.1:10080?streamid=#!::r=live/key01,m=publish',
                'key01',
            ),
            true,
        );
        assert.equal(
            localSrtOutputTargetsStream(
                'srt://localhost:10080?streamid=%23!::r=live/key01,m=publish',
                'key01',
            ),
            true,
        );
        assert.equal(
            localSrtOutputTargetsStream(
                'srt://localhost:10080?streamid=%23%21%3A%3Ar%3Dlive%2Fkey01%2Cm%3Dpublish',
                'key01',
            ),
            true,
        );
    });

    test('ignores non-local, wrong-port, and different-stream SRT outputs', () => {
        assert.equal(
            localSrtOutputTargetsStream(
                'srt://192.0.2.10:10080?streamid=#!::r=live/key01,m=publish',
                'key01',
            ),
            false,
        );
        assert.equal(
            localSrtOutputTargetsStream(
                'srt://127.0.0.1:10081?streamid=#!::r=live/key01,m=publish',
                'key01',
            ),
            false,
        );
        assert.equal(
            localSrtOutputTargetsStream(
                'srt://127.0.0.1:10080?streamid=#!::r=live/key02,m=publish',
                'key01',
            ),
            false,
        );
    });
});
