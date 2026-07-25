'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { Readable, Writable } = require('node:stream');

const { createDb } = require('../../src/db/index');
const { registerOutputApi } = require('../../src/api/outputs');

class MockRequest extends Readable {
    constructor(method, url, body) {
        super();
        this.method = method;
        this.url = url;
        this.headers =
            body === undefined
                ? {}
                : {
                      'content-type': 'application/json',
                      'content-length': Buffer.byteLength(JSON.stringify(body)),
                  };
        this.socket = { remoteAddress: '127.0.0.1' };
        this.connection = this.socket;
        this.body = body;
        this.bodyText = body === undefined ? '' : JSON.stringify(body);
    }

    _read() {
        this.push(this.bodyText);
        this.push(null);
        this.bodyText = '';
    }
}

class MockResponse extends Writable {
    constructor(resolve) {
        super();
        this.statusCode = 200;
        this.headers = {};
        this.chunks = [];
        this.resolve = resolve;
        this.setHeader = (name, value) => {
            this.headers[String(name).toLowerCase()] = value;
        };
        this.getHeader = (name) => this.headers[String(name).toLowerCase()];
        this.removeHeader = (name) => {
            delete this.headers[String(name).toLowerCase()];
        };
        this.writeHead = (statusCode, headers = {}) => {
            this.statusCode = statusCode;
            for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
            return this;
        };
        this.end = (chunk, encoding, callback) => {
            if (chunk) this.chunks.push(Buffer.from(chunk, encoding));
            const text = Buffer.concat(this.chunks).toString('utf8');
            this.resolve({
                status: this.statusCode,
                headers: this.headers,
                body: text ? JSON.parse(text) : undefined,
            });
            if (callback) callback();
            return this;
        };
    }

    _write(chunk, _encoding, callback) {
        this.chunks.push(Buffer.from(chunk));
        callback();
    }
}

function dispatch(app, method, route, body) {
    return new Promise((resolve, reject) => {
        const req = new MockRequest(method, route, body);
        const res = new MockResponse(resolve);
        app.handle(req, res, reject);
    });
}

// A fake process-management layer: fast, synchronous-ish, and lets tests
// force start() to fail to exercise the API's rollback-to-stopped path.
function makeFakeOutputService() {
    const statuses = new Map();
    let failNextStart = false;
    return {
        failNextStart(value = true) {
            failNextStart = value;
        },
        getStats(id) {
            return {
                status: statuses.get(id) ?? 'stopped',
                pid: null,
                bitrateKbps: null,
                startedAtMs: null,
                failures: 0,
                warningReason: null,
                memoryUsageBytes: null,
                memoryLimitBytes: null,
                cpuPercent: null,
            };
        },
        async start(id) {
            if (failNextStart) {
                failNextStart = false;
                throw new Error('boom: could not start');
            }
            statuses.set(id, 'running');
        },
        stop(id) {
            statuses.set(id, 'stopped');
        },
        async stopAndWait(id) {
            statuses.set(id, 'stopped');
        },
        restartPipelineOutputs() {
            return 0;
        },
        clearRetryState() {},
        shutdown() {},
    };
}

function createHarness() {
    const app = express();
    const db = createDb(':memory:');
    const outputService = makeFakeOutputService();
    registerOutputApi(app, db, outputService);
    return {
        db,
        outputService,
        request: (method, route, body) => dispatch(app, method, route, body),
    };
}

describe('Outputs API integration', () => {
    describe('POST /api/pipelines/:pipelineId/outputs', () => {
        test('creates an output with a valid rtmp destination', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();

            const res = await harness.request('POST', `/api/pipelines/${p.id}/outputs`, {
                name: 'YouTube',
                url: 'rtmp://a.rtmp.youtube.com/live2/key',
            });

            assert.equal(res.status, 201);
            assert.equal(res.body.name, 'YouTube');
            assert.equal(res.body.videoEncoding, 'copy');
            assert.equal(harness.db.listOutputsForPipeline(p.id).length, 1);
        });

        test('404s for a nonexistent pipeline', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/pipelines/9999/outputs', {
                name: 'X',
                url: 'rtmp://x',
            });
            assert.equal(res.status, 404);
        });

        test('400s for a non-numeric pipelineId', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/pipelines/abc/outputs', {
                name: 'X',
                url: 'rtmp://x',
            });
            assert.equal(res.status, 400);
        });

        test('rejects a missing name', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const res = await harness.request('POST', `/api/pipelines/${p.id}/outputs`, {
                url: 'rtmp://x',
            });
            assert.equal(res.status, 400);
        });

        test('rejects a blank (whitespace-only) name', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const res = await harness.request('POST', `/api/pipelines/${p.id}/outputs`, {
                name: '   ',
                url: 'rtmp://x',
            });
            assert.equal(res.status, 400);
        });

        test('rejects an unknown videoEncoding', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const res = await harness.request('POST', `/api/pipelines/${p.id}/outputs`, {
                name: 'X',
                url: 'rtmp://x',
                videoEncoding: '8k_ultra',
            });
            assert.equal(res.status, 400);
        });

        test('rejects a non-rtmp/srt destination url', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const res = await harness.request('POST', `/api/pipelines/${p.id}/outputs`, {
                name: 'X',
                url: 'http://example.com',
            });
            assert.equal(res.status, 400);
        });

        test('rejects multiple audio tracks on a non-SRT destination', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const res = await harness.request('POST', `/api/pipelines/${p.id}/outputs`, {
                name: 'X',
                url: 'rtmp://x',
                audioEncoding: '0,1',
            });
            assert.equal(res.status, 400);
        });

        test('allows multiple audio tracks on an SRT destination', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const res = await harness.request('POST', `/api/pipelines/${p.id}/outputs`, {
                name: 'X',
                url: 'srt://host:10080?streamid=test',
                audioEncoding: '0,1',
            });
            assert.equal(res.status, 201);
        });
    });

    describe('POST /api/pipelines/:pipelineId/outputs/bulk', () => {
        test('creates every valid output in the array', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const res = await harness.request('POST', `/api/pipelines/${p.id}/outputs/bulk`, {
                outputs: [
                    { name: 'A', url: 'rtmp://a' },
                    { name: 'B', url: 'rtmp://b' },
                ],
            });
            assert.equal(res.status, 201);
            assert.equal(res.body.length, 2);
            assert.equal(harness.db.listOutputsForPipeline(p.id).length, 2);
        });

        test('rejects an empty outputs array', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const res = await harness.request('POST', `/api/pipelines/${p.id}/outputs/bulk`, {
                outputs: [],
            });
            assert.equal(res.status, 400);
        });

        test('rejects a non-array outputs field', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const res = await harness.request('POST', `/api/pipelines/${p.id}/outputs/bulk`, {
                outputs: 'not-an-array',
            });
            assert.equal(res.status, 400);
        });

        test('creates nothing when one item in the batch is invalid', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const res = await harness.request('POST', `/api/pipelines/${p.id}/outputs/bulk`, {
                outputs: [
                    { name: 'A', url: 'rtmp://a' },
                    { name: 'B', url: 'not-a-valid-url' },
                ],
            });
            assert.equal(res.status, 400);
            assert.equal(harness.db.listOutputsForPipeline(p.id).length, 0);
        });
    });

    describe('start-all / stop-all', () => {
        test('start-all flips desired state to running for every output', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const a = harness.db.createOutput({ pipelineId: p.id, name: 'A', url: 'rtmp://a' });
            const b = harness.db.createOutput({ pipelineId: p.id, name: 'B', url: 'rtmp://b' });

            const res = await harness.request(
                'POST',
                `/api/pipelines/${p.id}/outputs/start-all`,
                {},
            );
            assert.equal(res.status, 200);
            assert.equal(harness.db.getOutput(a.id).desiredState, 'running');
            assert.equal(harness.db.getOutput(b.id).desiredState, 'running');
        });

        test('stop-all flips desired state to stopped and calls stop on every output', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const a = harness.db.createOutput({ pipelineId: p.id, name: 'A', url: 'rtmp://a' });
            harness.db.setOutputDesiredState(a.id, 'running');

            const res = await harness.request(
                'POST',
                `/api/pipelines/${p.id}/outputs/stop-all`,
                {},
            );
            assert.equal(res.status, 200);
            assert.equal(harness.db.getOutput(a.id).desiredState, 'stopped');
        });

        test('start-all 404s for a nonexistent pipeline', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/pipelines/9999/outputs/start-all', {});
            assert.equal(res.status, 404);
        });
    });

    describe('POST /api/pipelines/:pipelineId/outputs/:outId (edit)', () => {
        test('edits a stopped output', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const o = harness.db.createOutput({ pipelineId: p.id, name: 'Old', url: 'rtmp://old' });

            const res = await harness.request('POST', `/api/pipelines/${p.id}/outputs/${o.id}`, {
                name: 'New',
                url: 'rtmp://new',
            });
            assert.equal(res.status, 200);
            assert.equal(res.body.name, 'New');
            assert.equal(res.body.url, 'rtmp://new');
        });

        test('409s when the output is running in the process layer even if desiredState is stopped', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const o = harness.db.createOutput({ pipelineId: p.id, name: 'X', url: 'rtmp://x' });
            // Simulate a stale-running process the DB doesn't know about yet.
            await harness.outputService.start(o.id);

            const res = await harness.request('POST', `/api/pipelines/${p.id}/outputs/${o.id}`, {
                name: 'New',
                url: 'rtmp://new',
            });
            assert.equal(res.status, 409);
        });

        test('409s when desiredState is running', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const o = harness.db.createOutput({ pipelineId: p.id, name: 'X', url: 'rtmp://x' });
            harness.db.setOutputDesiredState(o.id, 'running');

            const res = await harness.request('POST', `/api/pipelines/${p.id}/outputs/${o.id}`, {
                name: 'New',
                url: 'rtmp://new',
            });
            assert.equal(res.status, 409);
        });

        test('404s when the output belongs to a different pipeline', async () => {
            const harness = createHarness();
            const p1 = harness.db.createPipeline();
            const p2 = harness.db.createPipeline();
            const o = harness.db.createOutput({ pipelineId: p1.id, name: 'X', url: 'rtmp://x' });

            const res = await harness.request('POST', `/api/pipelines/${p2.id}/outputs/${o.id}`, {
                name: 'New',
                url: 'rtmp://new',
            });
            assert.equal(res.status, 404);
        });

        test('rejects an invalid destination on edit', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const o = harness.db.createOutput({ pipelineId: p.id, name: 'X', url: 'rtmp://x' });

            const res = await harness.request('POST', `/api/pipelines/${p.id}/outputs/${o.id}`, {
                name: 'New',
                url: 'ftp://bad',
            });
            assert.equal(res.status, 400);
        });
    });

    describe('DELETE /api/pipelines/:pipelineId/outputs (clear all)', () => {
        test('deletes every stopped output', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            harness.db.createOutput({ pipelineId: p.id, name: 'A', url: 'rtmp://a' });
            harness.db.createOutput({ pipelineId: p.id, name: 'B', url: 'rtmp://b' });

            const res = await harness.request('DELETE', `/api/pipelines/${p.id}/outputs`);
            assert.equal(res.status, 200);
            assert.equal(harness.db.listOutputsForPipeline(p.id).length, 0);
        });

        test('409s and deletes nothing if any output is still running', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const a = harness.db.createOutput({ pipelineId: p.id, name: 'A', url: 'rtmp://a' });
            harness.db.createOutput({ pipelineId: p.id, name: 'B', url: 'rtmp://b' });
            harness.db.setOutputDesiredState(a.id, 'running');

            const res = await harness.request('DELETE', `/api/pipelines/${p.id}/outputs`);
            assert.equal(res.status, 409);
            assert.equal(harness.db.listOutputsForPipeline(p.id).length, 2);
        });
    });

    describe('DELETE /api/pipelines/:pipelineId/outputs/:outId', () => {
        test('stops and deletes the output', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const o = harness.db.createOutput({ pipelineId: p.id, name: 'X', url: 'rtmp://x' });
            harness.db.setOutputDesiredState(o.id, 'running');
            await harness.outputService.start(o.id);

            const res = await harness.request('DELETE', `/api/pipelines/${p.id}/outputs/${o.id}`);
            assert.equal(res.status, 200);
            assert.equal(harness.db.getOutput(o.id), null);
            assert.equal(harness.outputService.getStats(o.id).status, 'stopped');
        });

        test('404s for an unknown output id', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const res = await harness.request('DELETE', `/api/pipelines/${p.id}/outputs/nope-1`);
            assert.equal(res.status, 404);
        });
    });

    describe('GET /api/pipelines/:pipelineId/outputs/:outId/errors', () => {
        test('returns the error history', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const o = harness.db.createOutput({ pipelineId: p.id, name: 'X', url: 'rtmp://x' });
            harness.db.setOutputLastError(o.id, 'boom', 'crash');

            const res = await harness.request(
                'GET',
                `/api/pipelines/${p.id}/outputs/${o.id}/errors`,
            );
            assert.equal(res.status, 200);
            assert.equal(res.body.length, 1);
            assert.equal(res.body[0].message, 'boom');
        });

        test('404s for a mismatched pipeline/output pair', async () => {
            const harness = createHarness();
            const p1 = harness.db.createPipeline();
            const p2 = harness.db.createPipeline();
            const o = harness.db.createOutput({ pipelineId: p1.id, name: 'X', url: 'rtmp://x' });

            const res = await harness.request(
                'GET',
                `/api/pipelines/${p2.id}/outputs/${o.id}/errors`,
            );
            assert.equal(res.status, 404);
        });
    });

    describe('POST /api/pipelines/:pipelineId/outputs/:outId/start', () => {
        test('starts the output and sets desiredState to running', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const o = harness.db.createOutput({ pipelineId: p.id, name: 'X', url: 'rtmp://x' });

            const res = await harness.request(
                'POST',
                `/api/pipelines/${p.id}/outputs/${o.id}/start`,
            );
            assert.equal(res.status, 200);
            assert.equal(res.body.status.status, 'running');
            assert.equal(harness.db.getOutput(o.id).desiredState, 'running');
        });

        test('rolls desiredState back to stopped when the process layer fails to start', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const o = harness.db.createOutput({ pipelineId: p.id, name: 'X', url: 'rtmp://x' });
            harness.outputService.failNextStart();

            const res = await harness.request(
                'POST',
                `/api/pipelines/${p.id}/outputs/${o.id}/start`,
            );
            assert.equal(res.status, 400);
            assert.match(res.body.error, /boom/);
            assert.equal(harness.db.getOutput(o.id).desiredState, 'stopped');
        });

        test('404s for an unknown output', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const res = await harness.request(
                'POST',
                `/api/pipelines/${p.id}/outputs/nope-1/start`,
            );
            assert.equal(res.status, 404);
        });
    });

    describe('POST /api/pipelines/:pipelineId/outputs/:outId/stop', () => {
        test('stops the output and sets desiredState to stopped', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const o = harness.db.createOutput({ pipelineId: p.id, name: 'X', url: 'rtmp://x' });
            harness.db.setOutputDesiredState(o.id, 'running');
            await harness.outputService.start(o.id);

            const res = await harness.request(
                'POST',
                `/api/pipelines/${p.id}/outputs/${o.id}/stop`,
            );
            assert.equal(res.status, 200);
            assert.equal(harness.db.getOutput(o.id).desiredState, 'stopped');
            assert.equal(harness.outputService.getStats(o.id).status, 'stopped');
        });
    });
});
