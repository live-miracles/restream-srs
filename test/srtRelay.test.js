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
                            forwardedPackets: 42,
                            forwardedBytes: 65536,
                            lastPacketAt: startedAtMs + 900,
                            lastInputPacketAt: startedAtMs + 900,
                            recvPacketsTotal: 120,
                            recvUniquePacketsTotal: 118,
                            recvLossTotal: 2,
                            recvDropTotal: 0,
                            retransTotal: 3,
                            rttMs: 4.25,
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
            forwardedPackets: 42,
            forwardedBytes: 65536,
            lastPacketAt: startedAtMs + 900,
            lastInputPacketAt: startedAtMs + 900,
            recvPacketsTotal: 120,
            recvUniquePacketsTotal: 118,
            recvLossTotal: 2,
            recvDropTotal: 0,
            retransTotal: 3,
            rttMs: 4.25,
            lastErrorAt,
            lastError: null,
        });
    });

    test('matches stream status by resource path when encoder streamid includes extra fields', async () => {
        global.fetch = async () =>
            new Response(
                JSON.stringify({
                    pid: 12345,
                    startedAtMs: Date.now() - 1000,
                    updatedAtMs: Date.now(),
                    activeStreamIds: ['#!::u=bridge,h=encoder.example,r=live/key01,m=publish'],
                    lastError: null,
                    streamStates: [
                        {
                            streamId: '#!::u=bridge,h=encoder.example,r=live/key01,m=publish',
                            inputActive: true,
                            outputConnected: true,
                            retryFailures: 0,
                            forwardedPackets: 0,
                            forwardedBytes: 0,
                            lastPacketAt: null,
                            lastInputPacketAt: null,
                            recvPacketsTotal: 0,
                            recvUniquePacketsTotal: 0,
                            recvLossTotal: 0,
                            recvDropTotal: 0,
                            retransTotal: 0,
                            rttMs: null,
                            lastErrorAt: null,
                            lastError: null,
                        },
                    ],
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            );

        const service = createSrtRelayService();
        cleanup.push(async () => service.shutdown());
        service.start();

        await waitFor(() => service.getStats().status === 'running');
        assert.deepEqual(service.getStreamStatus('#!::r=live/key01,m=publish'), {
            inputActive: true,
            outputConnected: true,
            retryFailures: 0,
            forwardedPackets: 0,
            forwardedBytes: 0,
            lastPacketAt: null,
            lastInputPacketAt: null,
            recvPacketsTotal: 0,
            recvUniquePacketsTotal: 0,
            recvLossTotal: 0,
            recvDropTotal: 0,
            retransTotal: 0,
            rttMs: null,
            lastErrorAt: null,
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

    test('clears stale per-stream errors after the relay restarts', async () => {
        const erroredState = {
            streamId: '#!::r=live/key03,m=publish',
            inputActive: false,
            outputConnected: false,
            retryFailures: 4,
            forwardedPackets: 900,
            forwardedBytes: 1310720,
            lastPacketAt: Date.now() - 5000,
            lastInputPacketAt: Date.now() - 1000,
            recvPacketsTotal: 950,
            recvUniquePacketsTotal: 940,
            recvLossTotal: 10,
            recvDropTotal: 2,
            retransTotal: 6,
            rttMs: 12.5,
            lastErrorAt: Date.now() - 4000,
            lastError: 'Relay output error: broken pipe',
        };

        global.fetch = async () =>
            new Response(
                JSON.stringify({
                    pid: 1001,
                    startedAtMs: Date.now() - 10000,
                    updatedAtMs: Date.now(),
                    activeStreamIds: [],
                    lastError: 'srt_sendmsg2: broken pipe',
                    streamStates: [erroredState],
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            );

        const firstService = createSrtRelayService();
        cleanup.push(async () => firstService.shutdown());
        firstService.start();

        await waitFor(() => firstService.getStats().pid === 1001);
        assert.equal(
            firstService.getStreamStatus(erroredState.streamId).lastError,
            erroredState.lastError,
        );

        firstService.shutdown();

        global.fetch = async () =>
            new Response(
                JSON.stringify({
                    pid: 1002,
                    startedAtMs: Date.now() - 500,
                    updatedAtMs: Date.now(),
                    activeStreamIds: [],
                    lastError: null,
                    streamStates: [],
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            );

        const restartedService = createSrtRelayService();
        cleanup.push(async () => restartedService.shutdown());
        restartedService.start();

        await waitFor(() => restartedService.getStats().pid === 1002);
        assert.deepEqual(restartedService.getStreamStatus(erroredState.streamId), {
            inputActive: false,
            outputConnected: false,
            retryFailures: 0,
            forwardedPackets: 0,
            forwardedBytes: 0,
            lastPacketAt: null,
            lastInputPacketAt: null,
            recvPacketsTotal: 0,
            recvUniquePacketsTotal: 0,
            recvLossTotal: 0,
            recvDropTotal: 0,
            retransTotal: 0,
            rttMs: null,
            lastErrorAt: null,
            lastError: null,
        });
    });

    test('keeps per-stream status lookup stable with 20 concurrent streams', async () => {
        const streamStates = Array.from({ length: 20 }, (_, idx) => {
            const streamNum = String(idx + 1).padStart(2, '0');
            return {
                streamId: `#!::u=bridge-${streamNum},r=live/key${streamNum},m=publish`,
                inputActive: true,
                outputConnected: idx % 2 === 0,
                retryFailures: idx % 3,
                forwardedPackets: (idx + 1) * 100,
                forwardedBytes: (idx + 1) * 1456 * 100,
                lastPacketAt: Date.now() - idx * 100,
                lastInputPacketAt: Date.now() - idx * 100,
                recvPacketsTotal: (idx + 1) * 120,
                recvUniquePacketsTotal: (idx + 1) * 118,
                recvLossTotal: idx,
                recvDropTotal: idx % 2,
                retransTotal: idx + 2,
                rttMs: 2.5 + idx / 10,
                lastErrorAt: idx % 4 === 0 ? Date.now() - 1000 : null,
                lastError: idx % 4 === 0 ? `intermittent error ${streamNum}` : null,
            };
        });

        global.fetch = async () =>
            new Response(
                JSON.stringify({
                    pid: 3030,
                    startedAtMs: Date.now() - 2000,
                    updatedAtMs: Date.now(),
                    activeStreamIds: streamStates.map((s) => s.streamId),
                    lastError: null,
                    streamStates,
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            );

        const service = createSrtRelayService();
        cleanup.push(async () => service.shutdown());
        service.start();

        await waitFor(() => service.getStats().pid === 3030);
        assert.equal(service.isStreamActive('#!::u=bridge-20,r=live/key20,m=publish'), true);
        assert.deepEqual(service.getStreamStatus('#!::r=live/key20,m=publish'), {
            inputActive: true,
            outputConnected: false,
            retryFailures: 1,
            forwardedPackets: 2000,
            forwardedBytes: 2912000,
            lastPacketAt: streamStates[19].lastPacketAt,
            lastInputPacketAt: streamStates[19].lastInputPacketAt,
            recvPacketsTotal: 2400,
            recvUniquePacketsTotal: 2360,
            recvLossTotal: 19,
            recvDropTotal: 1,
            retransTotal: 21,
            rttMs: 4.4,
            lastErrorAt: null,
            lastError: null,
        });
    });
});
