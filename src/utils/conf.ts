import fs from 'fs';
import path from 'path';

const CONF_PATH = process.env.SRS_CONF_PATH ?? path.join(process.cwd(), 'srs.conf');
const SRS_SRT_PORT = parseInt(process.env.SRS_SRT_PORT || '10080');
const SRT_BONDING_PORT = parseInt(process.env.SRT_BONDING_PORT || '10081');
const RELAY_ENV_PATH =
    process.env.SRT_BONDING_RELAY_ENV_PATH ??
    path.join(path.dirname(CONF_PATH), 'srt-bonding-relay.env');
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

function srtUrl(base: string, params: Record<string, string | number | boolean>): string {
    const qs = Object.entries(params)
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
        .join('&');
    return `${base}?${qs}`;
}

function quoteEnv(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function renderSrtBondingRelayEnv(passphrase?: string | null): string {
    const inputParams: Record<string, string | number | boolean> = {
        mode: 'listener',
        groupconnect: 1,
        transtype: 'live',
        latency: 240,
    };
    const outputParams: Record<string, string | number | boolean> = {
        transtype: 'live',
        latency: 200,
    };

    if (passphrase) {
        inputParams.passphrase = passphrase;
        inputParams.pbkeylen = 16;
        outputParams.passphrase = passphrase;
        outputParams.pbkeylen = 16;
    }

    const inputUri = srtUrl(`srt://0.0.0.0:${SRT_BONDING_PORT}`, inputParams);
    const outputUri = srtUrl(`srt://127.0.0.1:${SRS_SRT_PORT}`, outputParams);

    return (
        `SRT_BONDING_INPUT_URI=${quoteEnv(inputUri)}\n` +
        `SRT_BONDING_OUTPUT_URI=${quoteEnv(outputUri)}\n`
    );
}

export function writeSrtRuntimeConfigs(passphrase?: string | null): void {
    writeFileAtomic(CONF_PATH, renderSrsConf(passphrase));
    writeFileAtomic(RELAY_ENV_PATH, renderSrtBondingRelayEnv(passphrase));
}
