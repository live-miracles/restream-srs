import fs from 'fs';
import path from 'path';
import { readAppConfig } from './appConfig.js';

export interface SrsConfigValues {
    apiUrl: string;
    rtmpHost: string;
    rtmpPort: number;
    srtPort: number;
    srtPassphrase: string | null;
    logPath: string;
}

const DEFAULT_RTMP_PORT = 1935;
const DEFAULT_SRT_PORT = 10080;
const DEFAULT_API_PORT = 1985;
const DEFAULT_RTMP_HOST = '127.0.0.1';
const DEFAULT_LOG_PATH = path.join(process.cwd(), 'objs', 'srs.log');

let cachedValues: SrsConfigValues | null = null;

function stripComments(conf: string): string {
    return conf
        .split('\n')
        .map((line) => line.replace(/#.*$/, ''))
        .join('\n');
}

function parsePort(value: string | undefined, fallback: number): number {
    const port = Number(value);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

function parseDirective(block: string, name: string): string | null {
    const match = block.match(new RegExp(`(?:^|\\n)\\s*${name}\\s+([^;]+);`));
    return match?.[1]?.trim() ?? null;
}

function parseBlock(conf: string, name: string): string {
    const match = conf.match(new RegExp(`${name}\\s*\\{([\\s\\S]*?)\\}`));
    return match?.[1] ?? '';
}

function topLevelOnly(conf: string): string {
    return conf.replace(/\b[a-zA-Z_][\w-]*\s*\{[\s\S]*?\}/g, '');
}

function resolveSrsPath(value: string | null, srsConfigPath: string, fallback: string): string {
    if (!value) return fallback;
    const unquoted = value.replace(/^"|"$/g, '');
    return path.isAbsolute(unquoted) ? unquoted : path.resolve(path.dirname(srsConfigPath), unquoted);
}

export function readSrsConfigValues(): SrsConfigValues {
    if (cachedValues) return cachedValues;

    const srsConfigPath = readAppConfig().srsConfigPath;
    let conf = '';
    try {
        conf = stripComments(fs.readFileSync(srsConfigPath, 'utf8'));
    } catch (err) {
        throw new Error(`Failed to read SRS config ${srsConfigPath}: ${String(err)}`);
    }

    const topLevelConf = topLevelOnly(conf);
    const rtmpPort = parsePort(
        parseDirective(topLevelConf, 'listen') ?? undefined,
        DEFAULT_RTMP_PORT,
    );
    const httpApiBlock = parseBlock(conf, 'http_api');
    const apiPort = parsePort(parseDirective(httpApiBlock, 'listen') ?? undefined, DEFAULT_API_PORT);
    const srtServerBlock = parseBlock(conf, 'srt_server');
    const srtPort = parsePort(
        parseDirective(srtServerBlock, 'listen') ?? undefined,
        DEFAULT_SRT_PORT,
    );
    const srtPassphrase = parseDirective(srtServerBlock, 'passphrase');
    const logPath = resolveSrsPath(
        parseDirective(topLevelConf, 'srs_log_file'),
        srsConfigPath,
        DEFAULT_LOG_PATH,
    );

    cachedValues = {
        apiUrl: `http://127.0.0.1:${apiPort}`,
        rtmpHost: DEFAULT_RTMP_HOST,
        rtmpPort,
        srtPort,
        srtPassphrase: srtPassphrase || null,
        logPath,
    };
    return cachedValues;
}
