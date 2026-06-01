'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restream-srs-conf-'));
process.env.SRS_CONF_PATH = path.join(tempDir, 'srs.conf');

const { writeSrsConf } = require('../src/utils/conf');

describe('SRS config generation', () => {
    test('does not enable SRT encryption without a passphrase', () => {
        writeSrsConf(null);

        const conf = fs.readFileSync(process.env.SRS_CONF_PATH, 'utf8');
        assert.doesNotMatch(conf, /passphrase\s+/);
        assert.doesNotMatch(conf, /pbkeylen\s+/);
    });

    test('writes configured SRT latency and passphrase', () => {
        writeSrsConf(750, 'secret-value');

        const conf = fs.readFileSync(process.env.SRS_CONF_PATH, 'utf8');
        assert.match(conf, /latency\s+750;/);
        assert.match(conf, /passphrase\s+"secret-value";/);
        assert.match(conf, /pbkeylen\s+16;/);
    });
});
