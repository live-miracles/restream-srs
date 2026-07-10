import fs from 'fs';
import path from 'path';

export interface AppConfig {
    port: number;
    databasePath: string;
    srsConfigPath: string;
    ffmpegPath: string;
    ffprobePath: string;
    outputWatchdog: OutputWatchdogConfig;
}

export interface OutputWatchdogConfig {
    warmupMs: number;
    stallMs: number;
    intervalMs: number;
    socketWarmupMs: number;
    socketGraceMs: number;
    memoryLimitMb: number;
    memoryLimitMbByEncoding: Record<string, number>;
}

interface RawAppConfig {
    port?: unknown;
    database_path?: unknown;
    srs_config_path?: unknown;
    ffmpeg_path?: unknown;
    ffprobe_path?: unknown;
    output_watchdog?: unknown;
}

const CONFIG_PATH = path.join(process.cwd(), 'restream.json');
const DEFAULT_WATCHDOG_CONFIG: OutputWatchdogConfig = {
    warmupMs: 90_000,
    stallMs: 45_000,
    intervalMs: 5_000,
    socketWarmupMs: 15_000,
    socketGraceMs: 30_000,
    // ~2-3x the ~65-90MB a healthy 'copy' (stream-copy, no transcode) output
    // runs at. Sized off the 2026-07-10 incident: a corrupt-input-triggered leak
    // took ~40min to cross the old 500MB limit from baseline, well before the
    // ~1.5-1.6GB anon-rss the kernel OOM killer struck at — see
    // fail-reports/2026-07-10-pipeline1-output-oom-cascade.md. Applies to 'copy'
    // and any videoEncoding not listed in memoryLimitMbByEncoding below.
    memoryLimitMb: 200,
    // libx264 transcode profiles run at a much higher legitimate baseline than
    // 'copy' (scale filter + encoder buffers), so they need their own limits —
    // measured baselines on 2026-07-10: vertical_rotate ~254MB, 720p ~373MB,
    // 1080p ~590MB. Each limit here is ~1.7-1.8x its measured baseline.
    memoryLimitMbByEncoding: {
        vertical_rotate: 450,
        '720p': 650,
        '1080p': 950,
    },
};
const DEFAULT_RAW_CONFIG = {
    port: 8080,
    database_path: './db.sqlite',
    srs_config_path: './srs.conf',
    ffmpeg_path: 'ffmpeg',
    ffprobe_path: 'ffprobe',
} as const;

let cachedConfig: AppConfig | null = null;

function asPort(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535
        ? value
        : fallback;
}

function asString(value: unknown, fallback: string): string {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function asPositiveNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function asMemoryLimitMbByEncoding(value: unknown): Record<string, number> {
    const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    const result: Record<string, number> = { ...DEFAULT_WATCHDOG_CONFIG.memoryLimitMbByEncoding };
    for (const [encoding, limit] of Object.entries(raw)) {
        const fallback = result[encoding] ?? DEFAULT_WATCHDOG_CONFIG.memoryLimitMb;
        result[encoding] = asPositiveNumber(limit, fallback);
    }
    return result;
}

function readWatchdogConfig(value: unknown): OutputWatchdogConfig {
    const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    return {
        warmupMs: asPositiveNumber(raw.warmup_ms, DEFAULT_WATCHDOG_CONFIG.warmupMs),
        stallMs: asPositiveNumber(raw.stall_ms, DEFAULT_WATCHDOG_CONFIG.stallMs),
        intervalMs: asPositiveNumber(raw.interval_ms, DEFAULT_WATCHDOG_CONFIG.intervalMs),
        socketWarmupMs: asPositiveNumber(
            raw.socket_warmup_ms,
            DEFAULT_WATCHDOG_CONFIG.socketWarmupMs,
        ),
        socketGraceMs: asPositiveNumber(raw.socket_grace_ms, DEFAULT_WATCHDOG_CONFIG.socketGraceMs),
        memoryLimitMb: asPositiveNumber(raw.memory_limit_mb, DEFAULT_WATCHDOG_CONFIG.memoryLimitMb),
        memoryLimitMbByEncoding: asMemoryLimitMbByEncoding(raw.memory_limit_mb_by_encoding),
    };
}

function resolveFilePath(value: string, configDir: string): string {
    return path.isAbsolute(value) ? value : path.resolve(configDir, value);
}

function resolveCommand(value: string, configDir: string): string {
    if (path.isAbsolute(value) || value.startsWith('./') || value.startsWith('../')) {
        return resolveFilePath(value, configDir);
    }
    return value;
}

export function readAppConfig(): AppConfig {
    if (cachedConfig) return cachedConfig;

    const configDir = process.cwd();
    let raw: RawAppConfig = {};
    try {
        raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
        throw new Error(`Failed to read app config ${CONFIG_PATH}: ${String(err)}`);
    }

    cachedConfig = {
        port: asPort(raw.port, DEFAULT_RAW_CONFIG.port as number),
        databasePath: resolveFilePath(
            asString(raw.database_path, DEFAULT_RAW_CONFIG.database_path as string),
            configDir,
        ),
        srsConfigPath: resolveFilePath(
            asString(raw.srs_config_path, DEFAULT_RAW_CONFIG.srs_config_path as string),
            configDir,
        ),
        ffmpegPath: resolveCommand(
            asString(raw.ffmpeg_path, DEFAULT_RAW_CONFIG.ffmpeg_path as string),
            configDir,
        ),
        ffprobePath: resolveCommand(
            asString(raw.ffprobe_path, DEFAULT_RAW_CONFIG.ffprobe_path as string),
            configDir,
        ),
        outputWatchdog: readWatchdogConfig(raw.output_watchdog),
    };
    return cachedConfig;
}
