import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { buildFfmpegArgs, validateOutputUrl } from '../utils/ffmpeg.js';
import { rtmpPullUrl, srtPullUrl } from '../utils/srs.js';
import type { Db, Output } from '../types.js';

function hasValidSinks(output: Output): boolean {
    return output.sinks.length > 0 && output.sinks.every((s) => validateOutputUrl(s.url));
}

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];
// Outputs retry indefinitely — an input can be down for hours during a major
// incident and must come back on its own when it returns. While the input/SRS is
// not ready we only re-check (no ffmpeg spawned), so an idle retry is cheap.
const RECHECK_DELAY_MS = 5000;
const SIGKILL_DELAY_MS = 5000;
const STDERR_TAIL_BYTES = 3000;
const RESTART_STAGGER_MS = 200;
const FFMPEG_CMD = process.env.FFMPEG_PATH || 'ffmpeg';

interface OutputStats {
    status: 'running' | 'stopped' | 'failed';
    pid: number | null;
    bitrateKbps: number | null;
    startedAtMs: number | null;
}

export interface OutputService {
    getStats(outputId: string): OutputStats;
    start(outputId: string): Promise<void>;
    stop(outputId: string): void;
    stopAndWait(outputId: string): Promise<void>;
    restartPipelineOutputs(pipelineId: number, staggerBase?: number): number;
    clearRetryState(outputId: string): void;
    setInputReadyCheck(fn: (pipelineId: number) => boolean): void;
    shutdown(): void;
}

export function createOutputService(db: Db): OutputService {
    const processes = new Map<string, ChildProcess>();
    const statuses = new Map<
        string,
        { status: 'running' | 'stopped' | 'failed'; pid: number | null }
    >();
    const bitrates = new Map<string, number | null>();
    const startTimes = new Map<string, number>();
    const stopRequested = new Set<string>();
    const startLocks = new Set<string>();
    const retryState = new Map<string, { failures: number; timer: NodeJS.Timeout | null }>();

    // Whether an output's input is live and SRS is reachable. Wired up after
    // construction (the health service that knows this is created later). Defaults
    // to "ready" so behaviour is safe before wiring and in tests.
    let isInputReady: (pipelineId: number) => boolean = () => true;

    function getStats(outputId: string): OutputStats {
        const s = statuses.get(outputId) ?? { status: 'stopped' as const, pid: null };
        return {
            ...s,
            bitrateKbps: bitrates.get(outputId) ?? null,
            startedAtMs: startTimes.get(outputId) ?? null,
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
            bitrates.delete(outputId);
            startTimes.delete(outputId);
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
            if (!isInputReady(output.pipelineId)) {
                scheduleRecheck(outputId);
                return;
            }
            await startJob(output);
        } catch (err) {
            console.warn(`[outputs] ${outputId} auto-start failed:`, err);
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

    function killProcess(outputId: string, proc: ChildProcess): Promise<void> {
        stopRequested.add(outputId);
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
        if (!hasValidSinks(output)) throw new Error('Invalid output URL');

        const pipeline = db.getPipeline(output.pipelineId);
        if (!pipeline) throw new Error('Pipeline not found');
        // Pull the input over the configured protocol. SRT preserves every audio
        // track from a multitrack source; RTMP/FLV collapses to a single track.
        const inputUrl =
            output.pullMethod === 'srt'
                ? srtPullUrl(pipeline.streamKey)
                : rtmpPullUrl(pipeline.streamKey);
        const args = buildFfmpegArgs(inputUrl, output.sinks, output.videoEncoding);

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
        console.log(`[outputs] ${output.id} started pid=${child.pid}`);

        let buf = '';
        child.stdout?.on('data', (d: Buffer) => {
            buf += d.toString();
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';
            for (const line of lines) {
                if (line.startsWith('bitrate=')) {
                    bitrates.set(output.id, parseBitrateKbps(line));
                }
            }
        });

        let stderrTail = '';
        child.stderr?.on('data', (d: Buffer) => {
            stderrTail = (stderrTail + d.toString()).slice(-STDERR_TAIL_BYTES);
        });

        child.on('error', (err) => {
            console.warn(`[outputs] ${output.id} error:`, err.message);
        });

        child.on('close', (code, signal) => {
            const wasStop = stopRequested.delete(output.id);
            const status = wasStop ? 'stopped' : 'failed';
            processes.delete(output.id);
            setStatus(output.id, status, null);
            console.log(
                `[outputs] ${output.id} exited code=${code} signal=${signal} status=${status}`,
            );

            if (!wasStop) {
                try {
                    if (code !== 0 && stderrTail) {
                        db.appendOutputLog(
                            output.id,
                            'error',
                            `exit=${code ?? signal}\n${stderrTail.trim()}`,
                        );
                    } else if (code === 0) {
                        // FFmpeg exited cleanly without being asked to stop.
                        // This typically means the destination closed the connection
                        // (e.g. wrong stream key). Log a concise error so the UI
                        // shows red instead of silently cycling through retries.
                        const detail = stderrTail.trim();
                        db.appendOutputLog(
                            output.id,
                            'error',
                            detail ? `exit=0 (unexpected)\n${detail}` : 'exit=0 (unexpected)',
                        );
                    }
                } catch {
                    /* non-critical */
                }
            }

            if (!wasStop && db.getOutput(output.id)?.desiredState === 'running') {
                getRetry(output.id).failures++;
                scheduleRetry(output);
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
            if (!hasValidSinks(output)) throw new Error('Invalid output URL');
            clearRetry(outputId);
            getRetry(outputId).failures = 0;
            // Input not live yet — keep the output "running" (desiredState) but
            // don't spawn a doomed ffmpeg. The recheck loop starts it once the
            // input comes online.
            if (!isInputReady(output.pipelineId)) {
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
                    startTimes.set(output.id, Date.now());
                    continue;
                }
                try {
                    db.appendOutputLog(output.id, 'reconnect', 'Pipeline input reconnected');
                } catch {
                    /* non-critical */
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

        setInputReadyCheck(fn: (pipelineId: number) => boolean): void {
            isInputReady = fn;
        },

        shutdown(): void {
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
