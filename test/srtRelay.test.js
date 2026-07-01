'use strict';

const { after, before, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'restream-srt-relay-'));
const statePath = path.join(tmp, 'srt-bonding-relay.state');
process.env.SRT_BONDING_STATE_PATH = statePath;

const { createSrtRelayService } = require('../src/services/srtRelay');

after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = fn();
        if (value) return value;
        await sleep(25);
    }
    assert.fail('timed out waiting for condition');
}

describe('SRT relay service', () => {
    let service;

    before(() => {
        service = null;
    });

    after(() => {
        service?.shutdown();
        delete process.env.SRT_BONDING_STATE_PATH;
    });

    test('reports the relay as running when its state file is fresh', async () => {
        service = createSrtRelayService();
        const startedAtMs = Date.now() - 1000;
        fs.writeFileSync(
            statePath,
            JSON.stringify({
                pid: 12345,
                startedAtMs,
                updatedAtMs: Date.now(),
                activeStreamIds: ['#!::r=live/key01,m=publish'],
            }),
        );

        await waitFor(() => service.getStats().pid === 12345);
        assert.equal(service.getStats().status, 'running');
        assert.equal(service.getStats().startedAtMs, startedAtMs);
        assert.equal(service.isStreamActive('#!::r=live/key01,m=publish'), true);

        service.shutdown();
        service = null;
    });

    test('treats stale relay state as stopped and exposes the fixed port', () => {
        service = createSrtRelayService();
        fs.writeFileSync(
            statePath,
            JSON.stringify({
                pid: 999,
                startedAtMs: Date.now() - 20000,
                updatedAtMs: Date.now() - 20000,
                activeStreamIds: ['#!::r=live/key02,m=publish'],
            }),
        );

        assert.equal(service.getStats().status, 'stopped');
        assert.equal(service.getPort(), 10081);
        assert.equal(service.isStreamActive('#!::r=live/key02,m=publish'), false);

        service.shutdown();
        service = null;
    });
});
