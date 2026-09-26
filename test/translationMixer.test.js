'use strict';

const { after, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restream-srs-translation-mixer-'));
const originalCwd = process.cwd();
process.chdir(tempDir);
fs.writeFileSync(
    path.join(tempDir, 'restream.json'),
    JSON.stringify(
        {
            port: 8080,
            database_path: './db.sqlite',
            srs_config_path: './srs.conf',
            ffmpeg_path: 'ffmpeg',
            ffprobe_path: 'ffprobe',
        },
        null,
        4,
    ),
    'utf8',
);
fs.writeFileSync(
    path.join(tempDir, 'srs.conf'),
    'listen 1935;\nhttp_api {\n    listen 1985;\n}\n',
    'utf8',
);

const { nextDebouncedMode, selectControlPort } = require('../src/services/translationMixer');

after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

// These constants mirror translationMixer.ts's MODE_SWITCH_*_GRACE_MS; kept in
// sync here rather than exported, since they're an implementation detail the
// tests only need to stay comfortably inside/outside of.
const DOWN_GRACE_MS = 12000;
const UP_GRACE_MS = 3000;

describe('nextDebouncedMode', () => {
    test('starts in translated mode when the translator is already live', () => {
        const { tracker, mode } = nextDebouncedMode(undefined, true, 0);
        assert.equal(mode, 'translated');
        assert.equal(tracker.effectiveLive, true);
    });

    test('starts in source-only mode when the translator is not live', () => {
        const { mode } = nextDebouncedMode(undefined, false, 0);
        assert.equal(mode, 'source-only');
    });

    test('a brief translator drop shorter than the down-grace window does not switch modes', () => {
        let state = nextDebouncedMode(undefined, true, 0);
        assert.equal(state.mode, 'translated');

        // Translator drops, but recovers well before the down-grace window elapses.
        state = nextDebouncedMode(state.tracker, false, 1000);
        assert.equal(state.mode, 'translated', 'must not flip on a momentary drop');

        state = nextDebouncedMode(state.tracker, true, 2000);
        assert.equal(state.mode, 'translated');
    });

    test('a translator drop sustained past the down-grace window switches to source-only', () => {
        let state = nextDebouncedMode(undefined, true, 0);
        state = nextDebouncedMode(state.tracker, false, 100);
        assert.equal(state.mode, 'translated', 'not yet — still inside the grace window');

        state = nextDebouncedMode(state.tracker, false, 100 + DOWN_GRACE_MS + 1);
        assert.equal(state.mode, 'source-only', 'grace window elapsed with translator still down');
    });

    test('recovery only switches back after the shorter up-grace window', () => {
        let state = nextDebouncedMode(undefined, false, 0);
        state = nextDebouncedMode(state.tracker, true, 100);
        assert.equal(state.mode, 'source-only', 'not yet — still inside the up-grace window');

        state = nextDebouncedMode(state.tracker, true, 100 + UP_GRACE_MS + 1);
        assert.equal(state.mode, 'translated');
    });

    test('a re-drop before the up-grace window elapses cancels the pending recovery', () => {
        let state = nextDebouncedMode(undefined, false, 0);
        state = nextDebouncedMode(state.tracker, true, 100);
        // Translator flickers back down before recovery would have completed.
        state = nextDebouncedMode(state.tracker, false, 100 + UP_GRACE_MS - 1);
        assert.equal(state.mode, 'source-only');

        // Since the "since" timestamp reset on the last flip, the down-grace
        // window (measured from the most recent change) must elapse again —
        // it must not still be counted as live since time 100.
        state = nextDebouncedMode(state.tracker, false, 100 + UP_GRACE_MS - 1 + 50);
        assert.equal(state.mode, 'source-only');
    });
});

describe('selectControlPort', () => {
    test('is stable for the same outputId when no ports are taken', () => {
        const a = selectControlPort('pipeline-1-out-1', new Set());
        const b = selectControlPort('pipeline-1-out-1', new Set());
        assert.equal(a, b);
    });

    test('picks a different port when the deterministic choice is already used', () => {
        const used = new Set();
        const first = selectControlPort('same-id', used);
        used.add(first);
        const second = selectControlPort('same-id', used);
        assert.notEqual(second, first, 'must not hand out an already-claimed port');
        assert.ok(!used.has(second));
    });

    test('never collides across a batch of different output ids', () => {
        const used = new Set();
        for (let i = 0; i < 50; i++) {
            const port = selectControlPort(`output-${i}`, used);
            assert.ok(!used.has(port), `port ${port} was already handed out`);
            used.add(port);
        }
        assert.equal(used.size, 50);
    });
});
