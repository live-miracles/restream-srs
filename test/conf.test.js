'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restream-srs-conf-'));
process.env.SRS_CONF_PATH = path.join(tempDir, 'srs.conf');
process.env.SRT_BONDING_RELAY_ENV_PATH = path.join(tempDir, 'srt-bonding-relay.env');

// writeSrsConf patches an existing file, so seed a minimal conf with the
// srt_server block that the passphrase injection regex targets.
fs.writeFileSync(
    process.env.SRS_CONF_PATH,
    'srt_server {\n    enabled     on;\n    listen      10080;\n}\n',
    'utf8',
);

const { writeSrtRuntimeConfigs } = require('../src/utils/conf');

describe('SRS config generation', () => {
    test('does not enable SRT encryption without a passphrase', () => {
        writeSrtRuntimeConfigs();

        const conf = fs.readFileSync(process.env.SRS_CONF_PATH, 'utf8');
        const relayEnv = fs.readFileSync(process.env.SRT_BONDING_RELAY_ENV_PATH, 'utf8');
        assert.doesNotMatch(conf, /passphrase\s+/);
        assert.doesNotMatch(conf, /pbkeylen\s+/);
        assert.doesNotMatch(relayEnv, /passphrase=/);
        assert.doesNotMatch(relayEnv, /pbkeylen=16/);
        assert.doesNotMatch(relayEnv, /SRT_BONDING_STATE_PATH=/);
    });

    test('writes configured SRT passphrase to both runtime configs', () => {
        writeSrtRuntimeConfigs('secret-value');

        const conf = fs.readFileSync(process.env.SRS_CONF_PATH, 'utf8');
        const relayEnv = fs.readFileSync(process.env.SRT_BONDING_RELAY_ENV_PATH, 'utf8');
        assert.match(conf, /passphrase\s+"secret-value";/);
        assert.match(conf, /pbkeylen\s+16;/);
        assert.match(relayEnv, /passphrase=secret-value/);
        assert.match(relayEnv, /pbkeylen=16/);
    });

    test('throws when enabling SRT passphrase without an srt_server block', () => {
        fs.writeFileSync(process.env.SRS_CONF_PATH, 'listen 1935;\n', 'utf8');
        assert.throws(() => writeSrtRuntimeConfigs('secret-value'), /srt_server block not found/);
    });
});
