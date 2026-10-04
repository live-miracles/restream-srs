'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { rejectedVia, rejectedWhy } = require('../public/ts/core/rejected');

function entry(overrides) {
    return {
        label: 'key01',
        kind: 'publish',
        reason: 'unassigned',
        protocol: 'rtmp',
        ip: null,
        attempts: 1,
        lastAttemptAgoMs: 0,
        streams: 1,
        streamsCapped: false,
        ...overrides,
    };
}

describe('rejected attempt source', () => {
    test('names the remote address of an RTMP or direct SRT encoder', () => {
        assert.equal(rejectedVia(entry({ ip: '203.0.113.7' })), 'RTMP from 203.0.113.7');
        assert.equal(
            rejectedVia(entry({ protocol: 'srt', ip: '203.0.113.7' })),
            'SRT from 203.0.113.7',
        );
        assert.equal(rejectedVia(entry({ ip: null })), 'RTMP');
    });

    test('SRT from loopback is reported as coming via the relay', () => {
        for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', null]) {
            assert.equal(rejectedVia(entry({ protocol: 'srt', ip })), 'SRT (via relay)');
        }
    });

    test('returns plain text; escaping is left to the renderer', () => {
        assert.equal(rejectedVia(entry({ ip: '<b>' })), 'RTMP from <b>');
    });
});

describe('rejected attempt explanation', () => {
    test('explains each publish rejection reason', () => {
        assert.match(rejectedWhy(entry({ reason: 'unassigned' })), /not assigned to a pipeline/);
        assert.match(rejectedWhy(entry({ reason: 'unknown' })), /wrong secret/);
        assert.match(rejectedWhy(entry({ reason: 'unrecognized' })), /keyNN_ prefix/);
    });

    test('a play request points at the missing m=publish and keeps the key reason', () => {
        const why = rejectedWhy(entry({ kind: 'play', protocol: 'srt', reason: 'unknown' }));
        assert.match(why, /missing m=publish/);
        assert.match(why, /wrong secret/);
    });
});
