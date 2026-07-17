import { execFile, spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { INPUT_TIMEOUT_US, buildFfmpegArgs, validateOutputUrl } from '../utils/ffmpeg.js';
import { readAppConfig } from '../utils/appConfig.js';
import {
    readProcRssBytes,
    createProcCpuTracker,
    findPidsByExecutable,
} from '../utils/procStats.js';
import { red, yellow, green } from '../utils/ansiColor.js';
import type { Db, Output } from '../types.js';
import type { InputState } from './inputState.js';

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];
// Outputs retry indefinitely — an input can be down for hours during a major
// incident and must come back on its own when it returns. While the input/SRS is
// not ready we only re-check (no ffmpeg spawned), so an idle retry is cheap.
const RECHECK_DELAY_MS = 5000;
const SIGKILL_DELAY_MS = 5000;
const STDERR_TAIL_BYTES = 3000;
const RESTART_STAGGER_MS = 200;
const appConfig = readAppConfig();
const FFMPEG_CMD = appConfig.ffmpegPath;
const OUTPUT_WATCHDOG_WARMUP_MS = appConfig.outputWatchdog.warmupMs;
const OUTPUT_WATCHDOG_STALL_MS = appConfig.outputWatchdog.stallMs;
const OUTPUT_WATCHDOG_INTERVAL_MS = appConfig.outputWatchdog.intervalMs;
const OUTPUT_SOCKET_WARMUP_MS = appConfig.outputWatchdog.socketWarmupMs;
const OUTPUT_SOCKET_GRACE_MS = appConfig.outputWatchdog.socketGraceMs;
const SOCKET_SNAPSHOT_TIMEOUT_MS = 2000;
// Surface a UI warning once RSS crosses this fraction of the memory limit, well
// before the watchdog actually restarts the process at 100% — gives an early
// (yellow) signal that a leak may be building without waiting for the kill.
const MEMORY_WARNING_RATIO = 0.7;

// 'copy' (stream-copy) outputs run far leaner than libx264 transcode profiles
// (720p/1080p/vertical_rotate), which legitimately sit well above the base
// limit due to scale-filter + encoder buffers — see memoryLimitMbByEncoding
// in appConfig.ts for measured baselines.
//
// A 4K input decodes/copies much larger frames than the baselines above were
// measured against, so a 4K pipeline's outputs legitimately run higher RSS.
// HIGH_RES_MEMORY_MULTIPLIER is a placeholder guess (not a measured baseline
// like the others) — see live-miracles/restream-srs#11 to replace it with a
// real number once we have measured 4K RSS baselines.
const HIGH_RES_MEMORY_MULTIPLIER = 2;

function memoryLimitBytesFor(videoEncoding: string, highRes: boolean): number {
    const mb =
        appConfig.outputWatchdog.memoryLimitMbByEncoding[videoEncoding] ??
        appConfig.outputWatchdog.memoryLimitMb;
    const scaledMb = highRes ? mb * HIGH_RES_MEMORY_MULTIPLIER : mb;
    return scaledMb * 1024 * 1024;
}

const TCP_HEALTHY_STATES = new Set(['ESTAB', 'ESTABLISHED']);
const TCP_BAD_STATES = new Set([
    'CLOSE-WAIT',
    'CLOSING',
    'FIN-WAIT-1',
    'FIN-WAIT-2',
    'LAST-ACK',
    'TIME-WAIT',
]);

interface OutputStats {
    status: 'running' | 'stopped' | 'failed';
    pid: number | null;
    bitrateKbps: number | null;
    startedAtMs: number | null;
    failures: number;
    warningReason: string | null;
    memoryUsageBytes: number | null;
    memoryLimitBytes: number | null;
    cpuPercent: number | null;
}

interface OutputProgress {
    lastProgressAtMs: number;
    lastOutputProgressAtMs: number;
    lastOutTimeMs: number | null;
    lastTotalSize: number | null;
    lastBitrateKbps: number | null;
    stderrTail: string;
}

interface TcpSocket {
    state: string;
    peerAddress: string;
    peerPort: number;
}

interface SocketWarning {
    reason: string;
    badSinceMs: number;
}

export interface OutputService {
    getStats(outputId: string): OutputStats;
    start(outputId: string): Promise<void>;
    stop(outputId: string): void;
    stopAndWait(outputId: string): Promise<void>;
    restartPipelineOutputs(pipelineId: number, staggerBase?: number): number;
    clearRetryState(outputId: string): void;
    shutdown(): void;
}

// A fresh instance owns no ffmpeg processes yet, so anything already running
// our ffmpeg binary at construction time must be an orphan left behind by a
// previous instance. Give it a chance to exit cleanly; no need to wait or
// escalate to SIGKILL — an orphan that ignores SIGTERM is no worse off than
// before this ran, and the next restart will sweep it again.
function killOrphanedFfmpeg(): void {
    for (const pid of findPidsByExecutable(FFMPEG_CMD, (args) => {
        const progressIdx = args.indexOf('-progress');
        const timeoutIdx = args.indexOf('-rw_timeout');
        return (
            progressIdx >= 0 &&
            args[progressIdx + 1] === 'pipe:1' &&
            timeoutIdx >= 0 &&
            args[timeoutIdx + 1] === String(INPUT_TIMEOUT_US)
        );
    })) {
        console.warn(
            yellow(`[outputs] killing orphaned ffmpeg pid=${pid} left by a previous instance`),
        );
        try {
            process.kill(pid, 'SIGTERM');
        } catch {
            /* already gone */
        }
    }
}

export function createOutputService(db: Db, inputState: InputState): OutputService {
    const processes = new Map<string, ChildProcess>();
    const statuses = new Map<
        string,
        { status: 'running' | 'stopped' | 'failed'; pid: number | null }
    >();
    const startTimes = new Map<string, number>();
    const progress = new Map<string, OutputProgress>();
    const socketWarnings = new Map<string, SocketWarning>();
    const memoryWarnings = new Map<string, string>();
    const memoryUsage = new Map<string, { rssBytes: number; limitBytes: number }>();
    const cpuUsage = new Map<string, number>();
    const cpuTracker = createProcCpuTracker();
    let tcpSocketsByPid = new Map<number, TcpSocket[]>();
    let tcpSocketSnapshotUsable = false;
    let socketSnapshotInProgress = false;
    const stopRequested = new Set<string>();
    const watchdogKills = new Set<string>();
    const startLocks = new Set<string>();
    let shuttingDown = false;
    const retryState = new Map<string, { failures: number; timer: NodeJS.Timeout | null }>();
    const watchdogTimer = setInterval(checkOutputWatchdog, OUTPUT_WATCHDOG_INTERVAL_MS);
    watchdogTimer.unref?.();
    refreshTcpSocketSnapshot();
    killOrphanedFfmpeg();

    function getStats(outputId: string): OutputStats {
        const s = statuses.get(outputId) ?? { status: 'stopped' as const, pid: null };
        const usage = memoryUsage.get(outputId);
        return {
            ...s,
            bitrateKbps: progress.get(outputId)?.lastBitrateKbps ?? null,
            startedAtMs: startTimes.get(outputId) ?? null,
            failures: retryState.get(outputId)?.failures ?? 0,
            warningReason:
                socketWarnings.get(outputId)?.reason ?? memoryWarnings.get(outputId) ?? null,
            memoryUsageBytes: usage?.rssBytes ?? null,
            memoryLimitBytes: usage?.limitBytes ?? null,
            cpuPercent: cpuUsage.get(outputId) ?? null,
        };
    }

    function setStatus(
        outputId: string,
        status: 'running' | 'stopped' | 'failed',
        pid: number | null,
    ): void {
        statuses.set(outputId, { status, pid });
        if (status === 'running') {
            startTimes.set(outputId, Date.now());
        } else {
            startTimes.delete(outputId);
            progress.delete(outputId);
            socketWarnings.delete(outputId);
            memoryWarnings.delete(outputId);
            memoryUsage.delete(outputId);
            cpuUsage.delete(outputId);
            cpuTracker.delete(outputId);
        }
    }

    function getRetry(outputId: string) {
        if (!retryState.has(outputId)) retryState.set(outputId, { failures: 0, timer: null });
        return retryState.get(outputId)!;
    }

    function clearRetry(outputId: string): void {
        const r = retryState.get(outputId);
        if (r?.timer) {
            clearTimeout(r.timer);
            r.timer = null;
        }
        retryState.delete(outputId);
    }

    function scheduleRetry(output: Output): void {
        const r = getRetry(output.id);
        const delayMs = RETRY_DELAYS_MS[Math.min(r.failures - 1, RETRY_DELAYS_MS.length - 1)];
        console.warn(
            yellow(
                `[outputs] ${output.id} (${output.name}) retry ${r.failures} scheduled in ${delayMs}ms`,
            ),
        );
        scheduleTryStart(output.id, delayMs);
    }

    // Schedule a tryStart without counting a failure — used when the input/SRS is
    // not yet ready, so we keep checking cheaply until it is.
    function scheduleRecheck(outputId: string): void {
        scheduleTryStart(outputId, RECHECK_DELAY_MS);
    }

    function scheduleTryStart(outputId: string, delayMs: number): void {
        const r = getRetry(outputId);
        if (r.timer) clearTimeout(r.timer);
        r.timer = setTimeout(() => {
            r.timer = null;
            void tryStart(outputId);
        }, delayMs);
        r.timer.unref?.();
    }

    async function tryStart(outputId: string): Promise<void> {
        if (startLocks.has(outputId)) return;
        startLocks.add(outputId);
        try {
            const output = db.getOutput(outputId);
            if (!output || output.desiredState !== 'running') return;
            if (statuses.get(outputId)?.status === 'running') return;
            // Don't spawn a doomed ffmpeg against a dead input; re-check until ready.
            if (!inputState.isReady(output.pipelineId)) {
                scheduleRecheck(outputId);
                return;
            }
            await startJob(output);
        } catch (err) {
            console.warn(red(`[outputs] ${outputId} auto-start failed:`), err);
        } finally {
            startLocks.delete(outputId);
        }
    }

    function parseBitrateKbps(line: string): number | null {
        const val = line.slice('bitrate='.length).trim();
        if (val === 'N/A' || val === '0.0kbits/s') return null;
        const match = val.match(/^([\d.]+)kbits\/s$/);
        return match ? parseFloat(match[1]) : null;
    }

    function parseProgressNumber(line: string, prefix: string): number | null {
        if (!line.startsWith(prefix)) return null;
        const val = Number(line.slice(prefix.length).trim());
        return Number.isFinite(val) ? val : null;
    }

    function noteOutputProgress(outputId: string, line: string): void {
        const p = progress.get(outputId);
        if (!p) return;
        p.lastProgressAtMs = Date.now();

        const totalSize = parseProgressNumber(line, 'total_size=');
        if (totalSize != null && (p.lastTotalSize == null || totalSize > p.lastTotalSize)) {
            p.lastTotalSize = totalSize;
            p.lastOutputProgressAtMs = p.lastProgressAtMs;
            return;
        }

        // ffmpeg quirk: the '-progress' key is named out_time_ms but its value
        // is MICROSECONDS (same as out_time_us; kept for compatibility). The
        // watchdog only compares it monotonically so the unit doesn't affect
        // behavior, but error messages must label it as µs.
        const outTimeMs = parseProgressNumber(line, 'out_time_ms=');
        if (outTimeMs != null && (p.lastOutTimeMs == null || outTimeMs > p.lastOutTimeMs)) {
            p.lastOutTimeMs = outTimeMs;
            p.lastOutputProgressAtMs = p.lastProgressAtMs;
            return;
        }

        if (line.startsWith('bitrate=')) {
            p.lastBitrateKbps = parseBitrateKbps(line);
        }
    }

    function formatNullable(value: number | null): string {
        return value == null ? 'unknown' : String(value);
    }

    function buildWatchdogError(outputId: string, proc: ChildProcess, now: number): string {
        const p = progress.get(outputId);
        const stalledForSec = p
            ? Math.round((now - p.lastOutputProgressAtMs) / 1000)
            : Math.round(OUTPUT_WATCHDOG_STALL_MS / 1000);
        const progressAgeSec = p ? Math.round((now - p.lastProgressAtMs) / 1000) : null;
        const stderr = p?.stderrTail.trim();

        return [
            'watchdog: ffmpeg output stalled; restarting process',
            `pid=${proc.pid ?? 'unknown'}`,
            `no_output_progress_for=${stalledForSec}s`,
            `last_progress_line_age=${progressAgeSec == null ? 'unknown' : `${progressAgeSec}s`}`,
            `last_total_size=${formatNullable(p?.lastTotalSize ?? null)}`,
            `last_out_time_us=${formatNullable(p?.lastOutTimeMs ?? null)}`,
            `last_bitrate_kbps=${formatNullable(p?.lastBitrateKbps ?? null)}`,
            stderr ? `ffmpeg stderr tail:\n${stderr}` : 'ffmpeg stderr tail: <empty>',
            `Restarting output: no ffmpeg output progress for ${stalledForSec}s`,
        ].join('\n');
    }

    function buildSocketWatchdogError(
        outputId: string,
        proc: ChildProcess,
        reason: string,
    ): string {
        const p = progress.get(outputId);
        const sockets = proc.pid == null ? [] : (tcpSocketsByPid.get(proc.pid) ?? []);
        const socketSnapshot =
            sockets.length === 0
                ? 'socket_snapshot: <no sockets for pid>'
                : `socket_snapshot:\n${sockets
                      .map((s) => `  ${s.state} peer=${s.peerAddress}:${s.peerPort}`)
                      .join('\n')}`;
        return [
            'watchdog: ffmpeg destination socket unhealthy; restarting process',
            `pid=${proc.pid ?? 'unknown'}`,
            `socket_warning=${reason}`,
            socketSnapshot,
            `last_total_size=${formatNullable(p?.lastTotalSize ?? null)}`,
            `last_out_time_us=${formatNullable(p?.lastOutTimeMs ?? null)}`,
            `last_bitrate_kbps=${formatNullable(p?.lastBitrateKbps ?? null)}`,
            p?.stderrTail.trim()
                ? `ffmpeg stderr tail:\n${p.stderrTail.trim()}`
                : 'ffmpeg stderr tail: <empty>',
            `Restarting output: ${reason}`,
        ].join('\n');
    }

    function buildMemoryWatchdogError(
        outputId: string,
        proc: ChildProcess,
        rssBytes: number,
        limitBytes: number,
        now: number,
    ): string {
        const p = progress.get(outputId);
        const startedAtMs = startTimes.get(outputId);
        const uptimeSec = startedAtMs ? Math.round((now - startedAtMs) / 1000) : null;
        return [
            'watchdog: ffmpeg RSS exceeded memory limit; restarting process',
            `pid=${proc.pid ?? 'unknown'}`,
            `rss_mb=${Math.round(rssBytes / (1024 * 1024))}`,
            `limit_mb=${Math.round(limitBytes / (1024 * 1024))}`,
            `uptime_s=${uptimeSec == null ? 'unknown' : uptimeSec}`,
            p?.stderrTail.trim()
                ? `ffmpeg stderr tail:\n${p.stderrTail.trim()}`
                : 'ffmpeg stderr tail: <empty>',
            `Restarting output: RSS ${Math.round(rssBytes / (1024 * 1024))}MB exceeded ${Math.round(
                limitBytes / (1024 * 1024),
            )}MB limit`,
        ].join('\n');
    }

    function parseEndpoint(endpoint: string): { address: string; port: number } | null {
        const bracket = endpoint.match(/^\[([^\]]+)\]:(\d+)$/);
        if (bracket) return { address: bracket[1], port: Number(bracket[2]) };
        const idx = endpoint.lastIndexOf(':');
        if (idx === -1) return null;
        const port = Number(endpoint.slice(idx + 1));
        return Number.isFinite(port) ? { address: endpoint.slice(0, idx), port } : null;
    }

    function isLocalAddress(address: string): boolean {
        const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
        return (
            normalized === '::1' ||
            normalized === 'localhost' ||
            normalized.startsWith('127.') ||
            normalized === '::ffff:7f00:1' ||
            normalized.startsWith('::ffff:127.')
        );
    }

    function parseTcpSocketSnapshot(stdout: string): Map<number, TcpSocket[]> {
        const byPid = new Map<number, TcpSocket[]>();
        for (const line of stdout.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const parts = trimmed.split(/\s+/);
            if (parts.length < 5) continue;
            const state = parts[0];
            const peer = parseEndpoint(parts[4]);
            if (peer == null) continue;

            const pidMatches = [...trimmed.matchAll(/pid=(\d+)/g)];
            for (const match of pidMatches) {
                const pid = Number(match[1]);
                if (!Number.isFinite(pid)) continue;
                const sockets = byPid.get(pid) ?? [];
                sockets.push({ state, peerAddress: peer.address, peerPort: peer.port });
                byPid.set(pid, sockets);
            }
        }
        return byPid;
    }

    function refreshTcpSocketSnapshot(): void {
        if (socketSnapshotInProgress) return;
        if (![...processes.values()].some((proc) => proc.pid != null)) return;
        socketSnapshotInProgress = true;
        execFile(
            'ss',
            ['-H', '-tanp'],
            { timeout: SOCKET_SNAPSHOT_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 },
            (err, stdout) => {
                socketSnapshotInProgress = false;
                if (err) {
                    tcpSocketsByPid = new Map();
                    tcpSocketSnapshotUsable = false;
                    return;
                }
                tcpSocketsByPid = parseTcpSocketSnapshot(stdout);
                tcpSocketSnapshotUsable = true;
            },
        );
    }

    function requiredRtmpSocket(output: Output): { port: number; local: boolean } | null {
        const url = output.url;
        if (!url.startsWith('rtmp://') && !url.startsWith('rtmps://')) return null;
        let port: number;
        let local: boolean;
        try {
            const parsed = new URL(url);
            port = parsed.port ? Number(parsed.port) : parsed.protocol === 'rtmps:' ? 443 : 1935;
            local = isLocalAddress(parsed.hostname);
        } catch {
            port = url.startsWith('rtmps://') ? 443 : 1935;
            local = false;
        }
        // Local RTMP sockets are ambiguous: the ffmpeg input pull and output push
        // both connect to local SRS, so leave local relays to the progress watchdog.
        if (local) return null;
        return { port, local };
    }

    function socketMatchesRequirement(
        socket: TcpSocket,
        requirement: { port: number; local: boolean },
    ): boolean {
        return (
            socket.peerPort === requirement.port &&
            isLocalAddress(socket.peerAddress) === requirement.local
        );
    }

    function destinationSocketWarning(output: Output, proc: ChildProcess): string | null {
        if (!tcpSocketSnapshotUsable) return null;
        if (proc.pid == null) return null;
        const requirement = requiredRtmpSocket(output);
        if (requirement == null) return null;

        const sockets = tcpSocketsByPid.get(proc.pid) ?? [];
        const bad = sockets.find(
            (s) => socketMatchesRequirement(s, requirement) && TCP_BAD_STATES.has(s.state),
        );
        if (bad) return `RTMP socket ${bad.state} on destination port ${requirement.port}`;

        const healthy = sockets.some(
            (s) => socketMatchesRequirement(s, requirement) && TCP_HEALTHY_STATES.has(s.state),
        );
        if (!healthy) {
            return `RTMP socket missing (destination port ${requirement.port} not established)`;
        }

        return null;
    }

    function recordSocketWarning(outputId: string, reason: string, now: number): SocketWarning {
        const existing = socketWarnings.get(outputId);
        if (existing?.reason === reason) return existing;
        const next = { reason, badSinceMs: existing?.badSinceMs ?? now };
        socketWarnings.set(outputId, next);
        return next;
    }

    function maybeKillForSocketWarning(
        output: Output,
        proc: ChildProcess,
        reason: string,
        now: number,
    ): boolean {
        const outputId = output.id;
        const warning = recordSocketWarning(outputId, reason, now);
        if (now - warning.badSinceMs <= OUTPUT_SOCKET_GRACE_MS) return false;

        try {
            db.setOutputLastError(
                outputId,
                buildSocketWatchdogError(outputId, proc, reason),
                'crash',
            );
        } catch {
            /* non-critical; still restart the stuck process */
        }
        console.warn(
            yellow(
                `[outputs] ${outputId} (${output.name}) socket unhealthy: ${reason}, killing pid=${proc.pid}`,
            ),
        );
        watchdogKills.add(outputId);
        void killProcess(outputId, proc, false);
        return true;
    }

    function checkOutputWatchdog(): void {
        const now = Date.now();
        refreshTcpSocketSnapshot();
        for (const [outputId, proc] of processes) {
            if (watchdogKills.has(outputId)) continue;
            const output = db.getOutput(outputId);
            if (!output || output.desiredState !== 'running') continue;

            const startedAtMs = startTimes.get(outputId);
            const p = progress.get(outputId);
            if (!startedAtMs || !p) continue;
            if (!inputState.isReady(output.pipelineId)) continue;

            const rssBytes = proc.pid == null ? null : readProcRssBytes(proc.pid);
            const limitBytes = memoryLimitBytesFor(
                output.videoEncoding,
                inputState.isHighRes(output.pipelineId),
            );
            if (rssBytes != null) {
                memoryUsage.set(outputId, { rssBytes, limitBytes });
            } else {
                memoryUsage.delete(outputId);
            }

            const cpuPercent = proc.pid == null ? null : cpuTracker.sample(outputId, proc.pid);
            if (cpuPercent != null) {
                cpuUsage.set(outputId, cpuPercent);
            } else {
                cpuUsage.delete(outputId);
            }

            if (now - startedAtMs >= OUTPUT_SOCKET_WARMUP_MS) {
                const socketWarning = destinationSocketWarning(output, proc);
                if (socketWarning) {
                    if (maybeKillForSocketWarning(output, proc, socketWarning, now)) continue;
                } else {
                    socketWarnings.delete(outputId);
                }
            }

            if (now - startedAtMs >= OUTPUT_WATCHDOG_WARMUP_MS) {
                if (rssBytes != null && rssBytes >= limitBytes) {
                    try {
                        db.setOutputLastError(
                            outputId,
                            buildMemoryWatchdogError(outputId, proc, rssBytes, limitBytes, now),
                            'crash',
                        );
                    } catch {
                        /* non-critical; still restart the runaway process */
                    }
                    console.warn(
                        yellow(
                            `[outputs] ${outputId} (${output.name}) memory limit exceeded: rss=${Math.round(
                                rssBytes / (1024 * 1024),
                            )}MB (limit ${Math.round(
                                limitBytes / (1024 * 1024),
                            )}MB), killing pid=${proc.pid} for retry`,
                        ),
                    );
                    watchdogKills.add(outputId);
                    void killProcess(outputId, proc, false);
                    continue;
                }
                if (rssBytes != null && rssBytes >= limitBytes * MEMORY_WARNING_RATIO) {
                    const percent = Math.round((rssBytes / limitBytes) * 100);
                    memoryWarnings.set(
                        outputId,
                        `High memory usage: ${Math.round(rssBytes / (1024 * 1024))}MB / ${Math.round(
                            limitBytes / (1024 * 1024),
                        )}MB limit (${percent}%)`,
                    );
                } else {
                    memoryWarnings.delete(outputId);
                }
            }

            if (now - startedAtMs < OUTPUT_WATCHDOG_WARMUP_MS) continue;
            if (now - p.lastOutputProgressAtMs <= OUTPUT_WATCHDOG_STALL_MS) continue;

            try {
                db.setOutputLastError(outputId, buildWatchdogError(outputId, proc, now), 'crash');
            } catch {
                /* non-critical; still restart the stuck process */
            }
            console.warn(
                yellow(
                    `[outputs] ${outputId} (${output.name}) stalled: no output progress for ${Math.round(
                        (now - p.lastOutputProgressAtMs) / 1000,
                    )}s, killing pid=${proc.pid} for retry`,
                ),
            );
            watchdogKills.add(outputId);
            void killProcess(outputId, proc, false);
        }
    }

    function killProcess(
        outputId: string,
        proc: ChildProcess,
        requestedStop = true,
    ): Promise<void> {
        if (requestedStop) stopRequested.add(outputId);
        proc.kill('SIGTERM');
        return new Promise<void>((resolve) => {
            const t = setTimeout(() => {
                try {
                    proc.kill('SIGKILL');
                } catch {
                    /* already gone */
                }
            }, SIGKILL_DELAY_MS);
            proc.once('exit', () => {
                clearTimeout(t);
                resolve();
            });
        });
    }

    async function startJob(output: Output): Promise<void> {
        if (!validateOutputUrl(output.url)) throw new Error('Invalid output URL');

        const pipeline = db.getPipeline(output.pipelineId);
        if (!pipeline) throw new Error('Pipeline not found');
        // Pull the input back the same way it was published. Default to RTMP until known.
        const inputUrl = inputState.pullUrl(output.pipelineId, pipeline.streamKey);
        const args = buildFfmpegArgs(
            inputUrl,
            output.url,
            output.audioEncoding,
            output.videoEncoding,
        );

        // stdout and stderr must stay as 'pipe' (not 'ignore' or 'inherit').
        // When Node.js exits for any reason — including SIGKILL or a crash — the OS
        // closes the read ends of these pipes. ffmpeg writes to stdout every ~1s via
        // '-progress pipe:1', so it receives SIGPIPE within a second and exits.
        // Using 'ignore' (i.e. /dev/null) would break this coupling and leave
        // orphaned ffmpeg processes running after the parent dies.
        const child: ChildProcess = spawn(FFMPEG_CMD, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: process.env,
        });

        processes.set(output.id, child);
        setStatus(output.id, 'running', child.pid ?? null);
        progress.set(output.id, {
            lastProgressAtMs: Date.now(),
            lastOutputProgressAtMs: Date.now(),
            lastOutTimeMs: null,
            lastTotalSize: null,
            lastBitrateKbps: null,
            stderrTail: '',
        });
        console.log(green(`[outputs] ${output.id} (${output.name}) started pid=${child.pid}`));

        let buf = '';
        child.stdout?.on('data', (d: Buffer) => {
            buf += d.toString();
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';
            for (const line of lines) {
                noteOutputProgress(output.id, line);
            }
        });

        let stderrTail = '';
        child.stderr?.on('data', (d: Buffer) => {
            stderrTail = (stderrTail + d.toString()).slice(-STDERR_TAIL_BYTES);
            const p = progress.get(output.id);
            if (p) p.stderrTail = stderrTail;
        });

        child.on('error', (err) => {
            console.warn(red(`[outputs] ${output.id} error:`), err.message);
        });

        child.on('close', (code, signal) => {
            const wasStop = stopRequested.delete(output.id);
            const wasWatchdog = watchdogKills.delete(output.id);
            const status = wasStop ? 'stopped' : 'failed';
            processes.delete(output.id);
            setStatus(output.id, status, null);
            const exitColor = status === 'failed' ? red : green;
            console.log(
                exitColor(
                    `[outputs] ${output.id} (${output.name}) exited code=${code} signal=${signal} status=${status}`,
                ),
            );

            if (!wasStop) {
                try {
                    if (!wasWatchdog) {
                        const detail = stderrTail.trim();
                        const exitStr = `exit=${code ?? signal}`;
                        db.setOutputLastError(
                            output.id,
                            detail ? `${exitStr}\n${detail}` : exitStr,
                            'crash',
                        );
                    }
                } catch {
                    /* non-critical */
                }
            } else if (!shuttingDown) {
                // Deliberate stop, not a failure. Always record a 'stopped'
                // marker — even with empty stderr — so it becomes the newest
                // history entry and immediately supersedes any earlier crash
                // (db.rowToOutput only surfaces lastError when the *latest*
                // entry is a crash). When ffmpeg did print something, it's
                // also worth keeping as a diagnostic breadcrumb (e.g. a run
                // that never crashed but also never made progress, and got
                // stopped by hand before any watchdog would have caught it).
                // Skip during app shutdown, which stops every running output
                // at once and would otherwise flood each one's history with
                // routine stop markers on every restart/deploy.
                try {
                    db.setOutputLastError(output.id, stderrTail.trim(), 'stopped');
                } catch {
                    /* non-critical */
                }
            }

            if (shuttingDown) return;
            const desiredRunning = db.getOutput(output.id)?.desiredState === 'running';
            if (!wasStop && desiredRunning) {
                getRetry(output.id).failures++;
                scheduleRetry(output);
            } else if (wasStop && desiredRunning) {
                // A start arrived while this stop's kill was still in flight:
                // start() saw status 'running' and bailed, and a requested stop
                // schedules no retry — so without this, nothing would ever
                // respawn the process and the output would sit at
                // desired-running/actual-stopped until the next input
                // offline→online edge. Restart promptly; not a failure.
                scheduleTryStart(output.id, 0);
            }
        });
    }

    return {
        getStats,

        // Double-start safety here relies on startJob() being synchronous up to and
        // including spawn()+setStatus('running'): there is no await before the process
        // is registered, so a second concurrent start() always observes status
        // 'running' below and bails. If an await is ever introduced before spawn in
        // startJob, this check is no longer sufficient — add an explicit start lock
        // (as tryStart uses) to prevent racing spawns.
        async start(outputId: string): Promise<void> {
            if (startLocks.has(outputId)) return;
            if (statuses.get(outputId)?.status === 'running') return;
            const output = db.getOutput(outputId);
            if (!output) throw new Error('Output not found');
            if (!validateOutputUrl(output.url)) throw new Error('Invalid output URL');
            clearRetry(outputId);
            getRetry(outputId).failures = 0;
            // Input not live yet — keep the output "running" (desiredState) but
            // don't spawn a doomed ffmpeg. The recheck loop starts it once the
            // input comes online.
            if (!inputState.isReady(output.pipelineId)) {
                scheduleRecheck(outputId);
                return;
            }
            await startJob(output);
        },

        stop(outputId: string): void {
            clearRetry(outputId);
            const proc = processes.get(outputId);
            if (proc) {
                void killProcess(outputId, proc);
            } else {
                setStatus(outputId, 'stopped', null);
                // No live process to kill — e.g. stopped mid retry-backoff,
                // between one crash and the next scheduled attempt. The
                // close handler (which normally records the 'stopped'
                // marker) never fires in that case, so record it here
                // instead — otherwise an earlier crash stays the newest
                // history entry forever and keeps showing as current.
                try {
                    db.setOutputLastError(outputId, '', 'stopped');
                } catch {
                    /* non-critical */
                }
            }
        },

        async stopAndWait(outputId: string): Promise<void> {
            clearRetry(outputId);
            const proc = processes.get(outputId);
            if (!proc) {
                setStatus(outputId, 'stopped', null);
                return;
            }
            await killProcess(outputId, proc);
        },

        restartPipelineOutputs(pipelineId: number, staggerBase = 0): number {
            const outputs = db.listOutputsForPipeline(pipelineId);
            let scheduled = 0;
            for (const output of outputs) {
                if (output.desiredState !== 'running') continue;
                if (statuses.get(output.id)?.status === 'running') {
                    continue;
                }
                const r = getRetry(output.id);
                r.failures = 0;
                if (r.timer) clearTimeout(r.timer);
                r.timer = setTimeout(
                    () => {
                        r.timer = null;
                        void tryStart(output.id);
                    },
                    (staggerBase + scheduled) * RESTART_STAGGER_MS,
                );
                r.timer.unref?.();
                scheduled++;
            }
            return scheduled;
        },

        clearRetryState: clearRetry,

        shutdown(): void {
            shuttingDown = true;
            clearInterval(watchdogTimer);
            for (const r of retryState.values()) {
                if (r.timer) clearTimeout(r.timer);
            }
            for (const [outputId, proc] of processes) {
                stopRequested.add(outputId);
                try {
                    proc.kill('SIGKILL');
                } catch {
                    /* already gone */
                }
            }
            processes.clear();
        },
    };
}
