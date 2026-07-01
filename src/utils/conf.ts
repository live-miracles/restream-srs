import fs from 'fs';
import path from 'path';

const CONF_PATH = process.env.SRS_CONF_PATH ?? path.join(process.cwd(), 'srs.conf');
const SRS_SRT_PORT = parseInt(process.env.SRS_SRT_PORT || '10080');
const SRT_BONDING_PORT = parseInt(process.env.SRT_BONDING_PORT || '10081');
const RELAY_ENV_PATH =
    process.env.SRT_BONDING_RELAY_ENV_PATH ??
    path.join(path.dirname(CONF_PATH), 'srt-bonding-relay.env');
const SRT_BONDING_STATE_PATH =
    process.env.SRT_BONDING_STATE_PATH ||
    path.join(process.cwd(), 'objs', 'srt-bonding-relay.state');
export const SRS_LOG_PATH = process.env.SRS_LOG_PATH ?? path.join(process.cwd(), 'objs', 'srs.log');

function quoteSrsString(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function writeSrsConf(passphrase?: string | null): void {
    let conf = fs.readFileSync(CONF_PATH, 'utf8');

    // Remove any previously injected passphrase/pbkeylen lines
    conf = conf.replace(/^[ \t]*passphrase[ \t]+[^\n]+\n?/gm, '');
    conf = conf.replace(/^[ \t]*pbkeylen[ \t]+[^\n]+\n?/gm, '');

    if (passphrase) {
        const lines = `    passphrase      ${quoteSrsString(passphrase)};\n    pbkeylen        16;\n`;
        conf = conf.replace(/(srt_server\s*\{[^}]*)(\})/s, `$1${lines}$2`);
    }

    fs.writeFileSync(CONF_PATH, conf, 'utf8');
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

export function writeSrtBondingRelayEnv(passphrase?: string | null): void {
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

    fs.mkdirSync(path.dirname(RELAY_ENV_PATH), { recursive: true });
    fs.writeFileSync(
        RELAY_ENV_PATH,
        `SRT_BONDING_INPUT_URI=${quoteEnv(inputUri)}\n` +
            `SRT_BONDING_OUTPUT_URI=${quoteEnv(outputUri)}\n` +
            `SRT_BONDING_STATE_PATH=${quoteEnv(SRT_BONDING_STATE_PATH)}\n`,
        'utf8',
    );
}
