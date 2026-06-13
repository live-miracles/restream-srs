import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { buildFfmpegArgs, validateOutputUrl } from '../utils/ffmpeg.js';
import { rtmpPullUrl, srtPullUrl } from '../utils/srs.js';
import type { Db, Output } from '../types.js';

function hasValidSinks(output: Output): boolean {
    return output.sinks.length > 0 && output.sinks.every((s) => validateOutputUrl(s.url));
}

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];
const MAX_RETRIES = 100;
const SIGKILL_DELAY_MS = 5000;
const FFMPEG_CMD = process.env.FFMPEG_PATH || 'ffmpeg';

interface OutputStats {
    status: 'running' | 'stopped' | 'failed';
    pid: number | null;
    bitrateKbps: number | null;
    retries: number;
    startedAtMs: number | null;
}

export interface OutputService {
    getStats(outputId: string): OutputStats;
    start(outputId: string): Promise<void>;
    stop(outputId: string): void;
    stopAndWait(outputId: string): Promise<void>;
    restartPipelineOutputs(pipelineId: number): void;
    clearRetryState(outputId: string): void;
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
    const exhausted = new Set<string>();

    function getStats(outputId: string): OutputStats {
        const s = statuses.get(outputId) ?? { status: 'stopped' as const, pid: null };
        return {
            ...s,
            bitrateKbps: bitrates.get(outputId) ?? null,
            retries: retryState.get(outputId)?.failures ?? 0,
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
        if (r.failures >= MAX_RETRIES) {
            console.log(`[outputs] ${output.id} max retries reached, giving up`);
            exhausted.add(output.id);
            return;
        }
        const delayMs = RETRY_DELAYS_MS[Math.min(r.failures - 1, RETRY_DELAYS_MS.length - 1)];
        if (r.timer) clearTimeout(r.timer);
        r.timer = setTimeout(() => {
            r.timer = null;
            void tryStart(output.id);
        }, delayMs);
        r.timer.unref?.();
    }

    async function tryStart(outputId: string): Promise<void> {
        if (startLocks.has(outputId)) return;
        if (exhausted.has(outputId)) return;
        startLocks.add(outputId);
        try {
            const output = db.getOutput(outputId);
            if (!output || output.desiredState !== 'running') return;
            if (statuses.get(outputId)?.status === 'running') return;
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

        const child: ChildProcess = spawn(FFMPEG_CMD, args, {
            stdio: ['ignore', 'pipe', 'ignore'],
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

        child.on('error', (err) => {
            console.warn(`[outputs] ${output.id} error:`, err.message);
        });

        child.on('close', (code, signal) => {
            const wasStop = stopRequested.delete(output.id);
            const status = wasStop || code === 0 ? 'stopped' : 'failed';
            processes.delete(output.id);
            setStatus(output.id, status, null);
            console.log(
                `[outputs] ${output.id} exited code=${code} signal=${signal} status=${status}`,
            );

            if (!wasStop && db.getOutput(output.id)?.desiredState === 'running') {
                getRetry(output.id).failures++;
                scheduleRetry(output);
            }
        });
    }

    return {
        getStats,

        async start(outputId: string): Promise<void> {
            if (startLocks.has(outputId)) return;
            if (statuses.get(outputId)?.status === 'running') return;
            const output = db.getOutput(outputId);
            if (!output) throw new Error('Output not found');
            if (!hasValidSinks(output)) throw new Error('Invalid output URL');
            exhausted.delete(outputId);
            clearRetry(outputId);
            getRetry(outputId).failures = 0;
            await startJob(output);
        },

        stop(outputId: string): void {
            exhausted.delete(outputId);
            clearRetry(outputId);
            const proc = processes.get(outputId);
            if (proc) {
                void killProcess(outputId, proc);
            } else {
                setStatus(outputId, 'stopped', null);
            }
        },

        async stopAndWait(outputId: string): Promise<void> {
            exhausted.delete(outputId);
            clearRetry(outputId);
            const proc = processes.get(outputId);
            if (!proc) {
                setStatus(outputId, 'stopped', null);
                return;
            }
            await killProcess(outputId, proc);
        },

        restartPipelineOutputs(pipelineId: number): void {
            const outputs = db.listOutputsForPipeline(pipelineId);
            outputs.forEach((output, i) => {
                if (output.desiredState !== 'running') return;
                if (exhausted.has(output.id)) return;
                if (statuses.get(output.id)?.status === 'running') {
                    startTimes.set(output.id, Date.now());
                    return;
                }
                const r = getRetry(output.id);
                r.failures = 0;
                if (r.timer) clearTimeout(r.timer);
                r.timer = setTimeout(() => {
                    r.timer = null;
                    void tryStart(output.id);
                }, i * 200);
                r.timer.unref?.();
            });
        },

        clearRetryState: clearRetry,

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
