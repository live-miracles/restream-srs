'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { createDb } = require('../src/db/index');

// Each helper creates a fresh isolated in-memory DB
const makeDb = () => createDb(':memory:');

// ── Stream keys ───────────────────────────────────────

describe('Stream keys', () => {
    test('seeds exactly 99 slots on init', () => {
        assert.equal(makeDb().listStreamKeys().length, 99);
    });

    test('all keys match expected format', () => {
        for (const k of makeDb().listStreamKeys()) {
            assert.match(k.key, /^key\d{2}_[a-f0-9]{32}$/);
        }
    });

    test('keys are ordered by slot 1–99', () => {
        const keys = makeDb().listStreamKeys();
        assert.equal(keys[0].slot, 1);
        assert.equal(keys[98].slot, 99);
    });
});

// ── Pipeline CRUD ─────────────────────────────────────

describe('Pipeline CRUD', () => {
    test('createPipeline returns a pipeline with a stream key', () => {
        const p = makeDb().createPipeline();
        assert.ok(p.id > 0);
        assert.ok(p.streamKey.startsWith('key'));
        assert.ok(p.streamKeyId > 0);
    });

    test('getPipeline returns the created pipeline', () => {
        const db = makeDb();
        const p = db.createPipeline();
        const got = db.getPipeline(p.id);
        assert.equal(got?.name, p.name);
        assert.equal(got?.streamKey, p.streamKey);
    });

    test('getPipeline returns undefined for unknown id', () => {
        assert.equal(makeDb().getPipeline(9999), undefined);
    });

    test('listPipelines returns all created pipelines', () => {
        const db = makeDb();
        db.createPipeline();
        db.createPipeline();
        assert.equal(db.listPipelines().length, 2);
    });

    test('updatePipeline changes name', () => {
        const db = makeDb();
        const p = db.createPipeline();
        db.updatePipeline(p.id, 'Renamed');
        assert.equal(db.getPipeline(p.id)?.name, 'Renamed');
    });

    test('two pipelines receive different stream keys', () => {
        const db = makeDb();
        const p1 = db.createPipeline();
        const p2 = db.createPipeline();
        assert.notEqual(p1.streamKey, p2.streamKey);
    });

    test('deletePipeline removes the pipeline', () => {
        const db = makeDb();
        const p = db.createPipeline();
        assert.ok(db.deletePipeline(p.id));
        assert.equal(db.getPipeline(p.id), undefined);
    });

    test('deleted pipeline key becomes available for a new pipeline', () => {
        const db = makeDb();
        const p1 = db.createPipeline();
        db.deletePipeline(p1.id);
        // Fill all 99 slots — should succeed since one key was freed
        for (let i = 0; i < 99; i++) db.createPipeline();
    });

    test('createPipeline throws when all 99 keys are assigned', () => {
        const db = makeDb();
        for (let i = 0; i < 99; i++) db.createPipeline();
        assert.throws(() => db.createPipeline(), /No unassigned stream keys/);
    });
});

// ── Output CRUD ───────────────────────────────────────

describe('Output CRUD', () => {
    test('createOutput and getOutput round-trip', () => {
        const db = makeDb();
        const p = db.createPipeline();
        const o = db.createOutput({
            pipelineId: p.id,
            name: 'YouTube',
            sinks: [{ url: 'rtmp://a.rtmp.youtube.com/live2/key' }],
        });
        const got = db.listOutputs().find((out) => out.id === o.id);
        assert.equal(got?.name, 'YouTube');
        assert.equal(got?.sinks.length, 1);
        assert.equal(got?.sinks[0].url, 'rtmp://a.rtmp.youtube.com/live2/key');
        assert.equal(got?.sinks[0].audioEncoding, 'copy');
        assert.equal(got?.desiredState, 'stopped');
        assert.equal(got?.videoEncoding, 'copy');
        assert.equal(got?.pullMethod, 'rtmp');
    });

    test('createOutput persists multiple sinks with per-sink audio encoding', () => {
        const db = makeDb();
        const p = db.createPipeline();
        const o = db.createOutput({
            pipelineId: p.id,
            name: 'Split',
            pullMethod: 'srt',
            sinks: [
                { url: 'rtmp://en', audioEncoding: '0' },
                { url: 'rtmp://fr', audioEncoding: '1' },
            ],
        });
        const got = db.listOutputs().find((out) => out.id === o.id);
        assert.equal(got?.pullMethod, 'srt');
        assert.equal(got?.sinks.length, 2);
        assert.deepEqual(
            got?.sinks.map((s) => [s.url, s.audioEncoding]),
            [
                ['rtmp://en', '0'],
                ['rtmp://fr', '1'],
            ],
        );
    });

    test('listOutputsForPipeline scopes to the right pipeline', () => {
        const db = makeDb();
        const p1 = db.createPipeline();
        const p2 = db.createPipeline();
        db.createOutput({ pipelineId: p1.id, name: 'A', sinks: [{ url: 'rtmp://a' }] });
        db.createOutput({ pipelineId: p2.id, name: 'B', sinks: [{ url: 'rtmp://b' }] });
        const outs = db.listOutputsForPipeline(p1.id);
        assert.equal(outs.length, 1);
        assert.equal(outs[0].name, 'A');
    });

    test('multiple outputs on same pipeline get sequential seq numbers', () => {
        const db = makeDb();
        const p = db.createPipeline();
        const o1 = db.createOutput({ pipelineId: p.id, name: 'A', sinks: [{ url: 'rtmp://a' }] });
        const o2 = db.createOutput({ pipelineId: p.id, name: 'B', sinks: [{ url: 'rtmp://b' }] });
        assert.equal(o1.seq, 1);
        assert.equal(o2.seq, 2);
    });

    test('setOutputDesiredState persists the change', () => {
        const db = makeDb();
        const p = db.createPipeline();
        const o = db.createOutput({ pipelineId: p.id, name: 'X', sinks: [{ url: 'rtmp://x' }] });
        db.setOutputDesiredState(o.id, 'running');
        assert.equal(db.listOutputs().find((out) => out.id === o.id)?.desiredState, 'running');
    });

    test('updateOutput persists name, encoding, pullMethod, and sink changes', () => {
        const db = makeDb();
        const p = db.createPipeline();
        const o = db.createOutput({
            pipelineId: p.id,
            name: 'Old',
            sinks: [{ url: 'rtmp://old' }],
        });
        db.updateOutput(o.id, {
            name: 'New',
            videoEncoding: '720p',
            pullMethod: 'srt',
            sinks: [{ url: 'rtmp://new', audioEncoding: '2' }],
        });
        const got = db.listOutputs().find((out) => out.id === o.id);
        assert.equal(got?.name, 'New');
        assert.equal(got?.videoEncoding, '720p');
        assert.equal(got?.pullMethod, 'srt');
        assert.equal(got?.sinks.length, 1);
        assert.equal(got?.sinks[0].url, 'rtmp://new');
        assert.equal(got?.sinks[0].audioEncoding, '2');
    });

    test('updateOutput replaces sinks rather than appending', () => {
        const db = makeDb();
        const p = db.createPipeline();
        const o = db.createOutput({
            pipelineId: p.id,
            name: 'X',
            sinks: [{ url: 'rtmp://a' }, { url: 'rtmp://b' }],
        });
        db.updateOutput(o.id, {
            name: 'X',
            videoEncoding: 'copy',
            pullMethod: 'rtmp',
            sinks: [{ url: 'rtmp://only' }],
        });
        assert.equal(db.listOutputs().find((out) => out.id === o.id)?.sinks.length, 1);
    });

    test('deleteOutput removes the output', () => {
        const db = makeDb();
        const p = db.createPipeline();
        const o = db.createOutput({ pipelineId: p.id, name: 'X', sinks: [{ url: 'rtmp://x' }] });
        assert.ok(db.deleteOutput(o.id));
        assert.equal(
            db.listOutputs().find((out) => out.id === o.id),
            undefined,
        );
    });

    test('deleting a pipeline cascades to its outputs', () => {
        const db = makeDb();
        const p = db.createPipeline();
        const o = db.createOutput({ pipelineId: p.id, name: 'X', sinks: [{ url: 'rtmp://x' }] });
        db.deletePipeline(p.id);
        assert.equal(
            db.listOutputs().find((out) => out.id === o.id),
            undefined,
        );
    });
});

// ── Settings ──────────────────────────────────────────

describe('Settings', () => {
    test('getSetting returns null for unknown key', () => {
        assert.equal(makeDb().getSetting('nonexistent'), null);
    });

    test('setSetting and getSetting round-trip', () => {
        const db = makeDb();
        db.setSetting('serverName', 'My Server');
        assert.equal(db.getSetting('serverName'), 'My Server');
    });

    test('setSetting overwrites existing value', () => {
        const db = makeDb();
        db.setSetting('key', 'first');
        db.setSetting('key', 'second');
        assert.equal(db.getSetting('key'), 'second');
    });
});

// ── Config revision ───────────────────────────────────

describe('Config revision', () => {
    test('starts positive and is monotonic across config writes', () => {
        const db = makeDb();
        const rev0 = db.getConfigRev();
        assert.ok(rev0 > 0);

        const p = db.createPipeline();
        const rev1 = db.getConfigRev();
        assert.ok(rev1 > rev0);

        const o = db.createOutput({ pipelineId: p.id, name: 'A', sinks: [{ url: 'rtmp://a' }] });
        const rev2 = db.getConfigRev();
        assert.ok(rev2 > rev1);

        db.setOutputDesiredState(o.id, 'running');
        assert.ok(db.getConfigRev() > rev2);
    });

    test('does not bump on lastError or pipeline-log writes', () => {
        const db = makeDb();
        const p = db.createPipeline();
        const o = db.createOutput({ pipelineId: p.id, name: 'A', sinks: [{ url: 'rtmp://a' }] });
        const rev = db.getConfigRev();

        db.setOutputLastError(o.id, 'boom');
        db.clearOutputLastError(o.id);
        db.appendPipelineLog(p.id, 'online', 'connected');

        assert.equal(db.getConfigRev(), rev);
    });
});
