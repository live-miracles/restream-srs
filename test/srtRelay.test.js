'use strict';

const { after, before, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'restream-srt-relay-'));
const fakeRelay = path.join(tmp, 'srt-live-transmit');
fs.writeFileSync(
    fakeRelay,
    `#!/usr/bin/env bash
trap 'exit 0' TERM INT
while true; do sleep 0.1; done
`,
);
fs.chmodSync(fakeRelay, 0o755);

process.env.SRT_LIVE_TRANSMIT_PATH = fakeRelay;

const { createDb } = require('../src/db/index');
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
    });

    test('starts a relay and stopAndWait stops it', async () => {
        const db = createDb(':memory:');
        service = createSrtRelayService(db);
        const p = db.createPipeline();

        service.start(p.id);
        await waitFor(() => service.getStats(p.id).status === 'running');
        assert.ok(service.getStats(p.id).pid);

        await service.stopAndWait(p.id);
        assert.equal(service.getStats(p.id).status, 'stopped');
        assert.equal(service.getStats(p.id).pid, null);

        service.shutdown();
        service = null;
    });

    test('start requested while old relay is stopping starts a fresh process', async () => {
        const db = createDb(':memory:');
        service = createSrtRelayService(db);
        const p = db.createPipeline();

        db.setPipelineBondingEnabled(p.id, true);
        service.start(p.id);
        await waitFor(() => service.getStats(p.id).status === 'running');
        const firstPid = service.getStats(p.id).pid;
        assert.ok(firstPid);

        db.setPipelineBondingEnabled(p.id, false);
        service.stop(p.id);

        db.setPipelineBondingEnabled(p.id, true);
        service.start(p.id);

        await waitFor(() => {
            const stats = service.getStats(p.id);
            return stats.status === 'running' && stats.pid && stats.pid !== firstPid;
        });

        service.shutdown();
        service = null;
    });
});
