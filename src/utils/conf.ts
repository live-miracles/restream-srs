import fs from 'fs';
import path from 'path';

const CONF_PATH = process.env.SRS_CONF_PATH ?? path.join(process.cwd(), 'srs.conf');
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
