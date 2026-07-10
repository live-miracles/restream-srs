'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { createInputState } = require('../src/services/inputState');

describe('input state', () => {
    test('requires both SRS reachability and live media for readiness', () => {
        const state = createInputState();

        state.setPipelineState(1, true, 'srt');
        assert.equal(state.isLive(1), true);
        assert.equal(state.isReady(1), false);
        assert.equal(state.getProtocol(1), 'srt');

        state.setSrsReachable(true);
        assert.equal(state.isReady(1), true);

        state.setPipelineState(1, false, 'rtmp');
        assert.equal(state.isLive(1), false);
        assert.equal(state.isReady(1), false);
        assert.equal(state.getProtocol(1), 'rtmp');

        state.clearPipeline(1);
        assert.equal(state.isLive(1), false);
        assert.equal(state.isReady(1), false);
        assert.equal(state.getProtocol(1), null);
    });

    test('flags 4K inputs by their larger dimension, including portrait sources', () => {
        const state = createInputState();

        assert.equal(state.isHighRes(1), false);

        state.setInputResolution(1, 3840, 2160);
        assert.equal(state.isHighRes(1), true);

        state.setInputResolution(1, 2160, 3840); // rotated/portrait 4K
        assert.equal(state.isHighRes(1), true);

        state.setInputResolution(1, 1920, 1080);
        assert.equal(state.isHighRes(1), false);

        state.setInputResolution(1, 3840, 2160);
        state.clearPipeline(1);
        assert.equal(state.isHighRes(1), false);

        state.setInputResolution(1, 3840, 2160);
        state.setInputResolution(1, null, null);
        assert.equal(state.isHighRes(1), false);
    });
});
