import fs from 'fs';
import path from 'path';
import { getRelayConfigPath, readRelayConfig, renderRelayConfig } from './relayConfig.js';

const CONF_PATH = process.env.SRS_CONF_PATH ?? path.join(process.cwd(), 'srs.conf');
export const SRS_LOG_PATH = process.env.SRS_LOG_PATH ?? path.join(process.cwd(), 'objs', 'srs.log');

function writeFileAtomic(targetPath: string, contents: string): void {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const tmpPath = `${targetPath}.tmp`;
    fs.writeFileSync(tmpPath, contents, 'utf8');
    fs.renameSync(tmpPath, targetPath);
}

function quoteSrsString(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function renderSrsConf(passphrase?: string | null): string {
    let conf = fs.readFileSync(CONF_PATH, 'utf8');

    // Remove any previously injected passphrase/pbkeylen lines
    conf = conf.replace(/^[ \t]*passphrase[ \t]+[^\n]+\n?/gm, '');
    conf = conf.replace(/^[ \t]*pbkeylen[ \t]+[^\n]+\n?/gm, '');

    if (passphrase) {
        const lines = `    passphrase      ${quoteSrsString(passphrase)};\n    pbkeylen        16;\n`;
        const next = conf.replace(/(srt_server\s*\{[^}]*)(\})/s, `$1${lines}$2`);
        if (next === conf) {
            throw new Error(`srt_server block not found in ${CONF_PATH}`);
        }
        conf = next;
    }

    return conf;
}

function renderSrtBondingRelayConfig(passphrase?: string | null): string {
    return renderRelayConfig({
        ...readRelayConfig(),
        passphrase: passphrase ?? '',
    });
}

export function writeSrtRuntimeConfigs(passphrase?: string | null): void {
    writeFileAtomic(CONF_PATH, renderSrsConf(passphrase));
    writeFileAtomic(getRelayConfigPath(), renderSrtBondingRelayConfig(passphrase));
}
