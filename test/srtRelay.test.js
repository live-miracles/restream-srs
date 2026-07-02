'use strict';

const { afterEach, describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { createSrtRelayService } = require('../src/services/srtRelay');

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
    const cleanup = [];

    afterEach(async () => {
        while (cleanup.length) {
            await cleanup.pop()();
        }
        delete process.env.SRT_BONDING_STATUS_URL;
        global.fetch = originalFetch;
    });

    const originalFetch = global.fetch;

    test('reports the relay as running when the status endpoint responds', async () => {
        const startedAtMs = Date.now() - 1000;
        const lastErrorAt = Date.now() - 500;
        global.fetch = async () =>
            new Response(
                JSON.stringify({
                    pid: 12345,
                    startedAtMs,
                    updatedAtMs: Date.now(),
                    activeStreamIds: ['#!::r=live/key01,m=publish'],
                    lastError: null,
                    streamStates: [
                        {
                            streamId: '#!::r=live/key01,m=publish',
                            inputActive: true,
                            outputConnected: true,
                            retryFailures: 0,
                            lastErrorAt,
                            lastError: null,
                        },
                    ],
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            );

        const service = createSrtRelayService();
        cleanup.push(async () => service.shutdown());
        service.start();

        await waitFor(() => service.getStats().pid === 12345);
        assert.equal(service.getStats().status, 'running');
        assert.equal(service.getStats().startedAtMs, startedAtMs);
        assert.equal(service.isStreamActive('#!::r=live/key01,m=publish'), true);
        assert.deepEqual(service.getStreamStatus('#!::r=live/key01,m=publish'), {
            inputActive: true,
            outputConnected: true,
            retryFailures: 0,
            lastErrorAt,
            lastError: null,
        });
    });

    test('reports an unreachable relay as stopped before any successful poll', async () => {
        global.fetch = async () => {
            throw new Error('connect ECONNREFUSED 127.0.0.1:10082');
        };
        const service = createSrtRelayService();
        cleanup.push(async () => service.shutdown());
        service.start();

        await waitFor(() => service.getStats().lastError);
        assert.equal(service.getStats().status, 'stopped');
        assert.equal(service.getPort(), 10081);
        assert.equal(service.isStreamActive('#!::r=live/key02,m=publish'), false);
    });

    test('reports a previously reachable relay as failed when the endpoint goes away', async () => {
        let calls = 0;
        global.fetch = async () => {
            calls += 1;
            if (calls === 1) {
                return new Response(
                    JSON.stringify({
                        pid: 222,
                        startedAtMs: Date.now() - 5000,
                        updatedAtMs: Date.now(),
                        activeStreamIds: [],
                        lastError: null,
                        streamStates: [],
                    }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                );
            }
            throw new Error('connect ECONNREFUSED 127.0.0.1:10082');
        };
        const service = createSrtRelayService();
        cleanup.push(async () => service.shutdown());
        service.start();

        await waitFor(() => service.getStats().status === 'running');
        await waitFor(() => service.getStats().status === 'failed', 8000);
        assert.match(service.getStats().lastError || '', /fetch|connect|ECONNREFUSED/i);
    });
});
