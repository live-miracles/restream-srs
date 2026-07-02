import fs from 'fs';
import path from 'path';

const CONF_PATH = process.env.SRS_CONF_PATH ?? path.join(process.cwd(), 'srs.conf');
const SRS_SRT_PORT = parseInt(process.env.SRS_SRT_PORT || '10080');
const SRT_BONDING_PORT = parseInt(process.env.SRT_BONDING_PORT || '10081');
const RELAY_CONFIG_PATH =
    process.env.SRT_BONDING_RELAY_CONFIG_PATH ??
    path.join(path.dirname(CONF_PATH), 'srt-bonding-relay.json');
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

function renderSrtBondingRelayConfig(passphrase?: string | null): string {
    return JSON.stringify(
        {
            input_host: '0.0.0.0',
            input_port: SRT_BONDING_PORT,
            output_host: '127.0.0.1',
            output_port: SRS_SRT_PORT,
            status_port: parseInt(process.env.SRT_BONDING_STATUS_PORT || '10082'),
            passphrase: passphrase ?? '',
        },
        null,
        2,
    ).concat('\n');
}

export function writeSrtRuntimeConfigs(passphrase?: string | null): void {
    writeFileAtomic(CONF_PATH, renderSrsConf(passphrase));
    writeFileAtomic(RELAY_CONFIG_PATH, renderSrtBondingRelayConfig(passphrase));
}
