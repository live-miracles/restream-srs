import fs from 'fs';
import path from 'path';

const CONF_PATH = process.env.SRS_CONF_PATH ?? path.join(process.cwd(), 'srs.conf');

function quoteSrsString(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function writeSrsConf(latencyMs: number | null, passphrase?: string | null): void {
    const latencyLine = latencyMs != null ? `\n    latency         ${latencyMs};` : '';
    const passphraseLine = passphrase
        ? `\n    passphrase      ${quoteSrsString(passphrase)};\n    pbkeylen        16;`
        : '';
    const conf = `listen              1935;
max_connections     1000;
daemon              off;
srs_log_tank        console;

http_api {
    enabled         on;
    listen          1985;
}

http_server {
    enabled         off;
    listen          8080;
    dir             ./objs/nginx/html;
}

srt_server {
    enabled         on;
    listen          10080;${latencyLine}${passphraseLine}
}

vhost __defaultVhost__ {
    srt {
        enabled     on;
        srt_to_rtmp on;
    }

    http_hooks {
        enabled     on;
        on_publish  http://localhost:8080/api/srs/on_publish;
    }
}
`;
    fs.writeFileSync(CONF_PATH, conf, 'utf8');
}
