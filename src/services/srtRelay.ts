import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import type { Db, Pipeline } from '../types.js';

const FFMPEG_CMD = process.env.FFMPEG_PATH || 'ffmpeg';
const SRS_SRT_PORT = parseInt(process.env.SRS_SRT_PORT || '10080');
const RELAY_BASE_PORT = 11000;
const SIGKILL_DELAY_MS = 5000;
const STDERR_TAIL_BYTES = 3000;
const RESTART_DELAY_MS = 5000;

export interface SrtRelayStats {
    status: 'running' | 'stopping' | 'stopped' | 'failed';
    pid: number | null;
    startedAtMs: number | null;
    lastError: string | null;
}

export interface SrtRelayService {
    getPort(pipelineId: number): number;
    getStats(pipelineId: number): SrtRelayStats;
    start(pipelineId: number): void;
    stop(pipelineId: number): void;
    stopAndWait(pipelineId: number): Promise<void>;
    restartAll(): void;
    shutdown(): void;
}

export function createSrtRelayService(db: Db): SrtRelayService {
    const processes = new Map<number, ChildProcess>();
    const statuses = new Map<number, SrtRelayStats>();
    const stopRequested = new Set<number>();
    const pendingStart = new Set<number>();
    const timers = new Map<number, NodeJS.Timeout>();

    function getPort(pipelineId: number): number {
        return RELAY_BASE_PORT + pipelineId;
    }

    function getStats(pipelineId: number): SrtRelayStats {
        return (
            statuses.get(pipelineId) ?? {
                status: 'stopped',
                pid: null,
                startedAtMs: null,
                lastError: null,
            }
        );
    }

    function setStatus(pipelineId: number, stats: SrtRelayStats): void {
        statuses.set(pipelineId, stats);
    }

    function srtUrl(base: string, params: Record<string, string | number | boolean>): string {
        const qs = Object.entries(params)
            .map(([k, v]) => `${k}=${k === 'streamid' ? String(v) : encodeURIComponent(String(v))}`)
            .join('&');
        return `${base}?${qs}`;
    }

    function relayArgs(pipeline: Pipeline): string[] {
        const passphrase = db.getSetting('srtPassphrase') || null;
        // Input: listen for the encoder's bonded SRT group.
        // latency=240000 µs (240 ms) matches the AJA Bridge Live default; the SRT
        // handshake negotiates max(sender, receiver) so this is safe for lower values too.
        const inputParams: Record<string, string | number | boolean> = {
            mode: 'listener',
            groupconnect: 1,
            transtype: 'live',
            latency: 240000,
        };
        // Output: push to SRS only after ffmpeg has received input data.
        // ffmpeg probes the input before opening the output, so SRS never receives an
        // idle publisher connection — it only sees the connection once data is flowing,
        // which avoids SRS's hardcoded 5-second idle-publisher timeout.
        const outputParams: Record<string, string | number | boolean> = {
            streamid: `#!::r=live/${pipeline.streamKey},m=publish`,
            transtype: 'live',
            latency: 200000,
        };
        if (passphrase) {
            inputParams.passphrase = passphrase;
            inputParams.pbkeylen = 16;
            outputParams.passphrase = passphrase;
            outputParams.pbkeylen = 16;
        }
        return [
            '-loglevel',
            'warning',
            // Declare the input format so ffmpeg skips format probing entirely.
            // Without this, ffmpeg buffers ~5 s of data before opening the SRS
            // output, which stalls the stream and can cause the encoder to give up.
            '-f',
            'mpegts',
            '-i',
            srtUrl(`srt://0.0.0.0:${getPort(pipeline.id)}`, inputParams),
            '-c',
            'copy',
            '-f',
            'mpegts',
            srtUrl(`srt://127.0.0.1:${SRS_SRT_PORT}`, outputParams),
        ];
    }

    function clearTimer(pipelineId: number): void {
        const timer = timers.get(pipelineId);
        if (timer) clearTimeout(timer);
        timers.delete(pipelineId);
    }

    function scheduleRestart(pipelineId: number): void {
        clearTimer(pipelineId);
        const timer = setTimeout(() => {
            timers.delete(pipelineId);
            if (db.getPipeline(pipelineId)?.bondingEnabled) start(pipelineId);
        }, RESTART_DELAY_MS);
        timer.unref?.();
        timers.set(pipelineId, timer);
    }

    function killProcess(pipelineId: number, proc: ChildProcess): Promise<void> {
        stopRequested.add(pipelineId);
        return new Promise<void>((resolve) => {
            if (proc.exitCode !== null || proc.signalCode !== null) {
                resolve();
                return;
            }
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
            try {
                proc.kill('SIGTERM');
            } catch {
                clearTimeout(t);
                resolve();
            }
        });
    }

    function start(pipelineId: number): void {
        clearTimer(pipelineId);
        if (processes.has(pipelineId)) {
            if (stopRequested.has(pipelineId)) pendingStart.add(pipelineId);
            return;
        }
        pendingStart.delete(pipelineId);
        const pipeline = db.getPipeline(pipelineId);
        if (!pipeline) throw new Error('Pipeline not found');
        if (!pipeline.streamKey) throw new Error('Pipeline stream key is missing');

        const args = relayArgs(pipeline);
        const child = spawn(FFMPEG_CMD, args, {
            stdio: ['ignore', 'ignore', 'pipe'],
            env: process.env,
        });

        processes.set(pipeline.id, child);
        const startedAtMs = Date.now();
        setStatus(pipeline.id, {
            status: 'running',
            pid: child.pid ?? null,
            startedAtMs,
            lastError: null,
        });
        console.log(
            `[ffmpeg-relay] pipeline ${pipeline.id} listening on UDP ${getPort(pipeline.id)} pid=${child.pid}`,
        );

        let stderrTail = '';
        child.stderr?.on('data', (d: Buffer) => {
            stderrTail = (stderrTail + d.toString()).slice(-STDERR_TAIL_BYTES);
        });

        child.on('error', (err) => {
            const message = err.message;
            setStatus(pipeline.id, {
                status: 'failed',
                pid: null,
                startedAtMs: null,
                lastError: message,
            });
            console.warn(`[ffmpeg-relay] pipeline ${pipeline.id} error:`, message);
        });

        child.on('close', (code, signal) => {
            const wasStop = stopRequested.delete(pipeline.id);
            processes.delete(pipeline.id);
            const detail = stderrTail.trim();
            const exitStr = `exit=${code ?? signal}`;
            setStatus(pipeline.id, {
                status: wasStop ? 'stopped' : 'failed',
                pid: null,
                startedAtMs: null,
                lastError: wasStop ? null : detail ? `${exitStr}\n${detail}` : exitStr,
            });
            console.log(
                `[ffmpeg-relay] pipeline ${pipeline.id} exited code=${code} signal=${signal} status=${wasStop ? 'stopped' : 'failed'}`,
            );
            const wantsRelay = db.getPipeline(pipeline.id)?.bondingEnabled;
            if (wasStop && pendingStart.delete(pipeline.id) && wantsRelay) {
                start(pipeline.id);
            } else if (!wasStop && wantsRelay) {
                scheduleRestart(pipeline.id);
            }
        });
    }

    return {
        getPort,
        getStats,
        start,

        stop(pipelineId: number): void {
            clearTimer(pipelineId);
            const proc = processes.get(pipelineId);
            if (proc) {
                pendingStart.delete(pipelineId);
                setStatus(pipelineId, {
                    status: 'stopping',
                    pid: proc.pid ?? null,
                    startedAtMs: getStats(pipelineId).startedAtMs,
                    lastError: null,
                });
                void killProcess(pipelineId, proc);
            } else {
                setStatus(pipelineId, {
                    status: 'stopped',
                    pid: null,
                    startedAtMs: null,
                    lastError: null,
                });
            }
        },

        async stopAndWait(pipelineId: number): Promise<void> {
            clearTimer(pipelineId);
            const proc = processes.get(pipelineId);
            if (!proc) {
                setStatus(pipelineId, {
                    status: 'stopped',
                    pid: null,
                    startedAtMs: null,
                    lastError: null,
                });
                return;
            }
            pendingStart.delete(pipelineId);
            setStatus(pipelineId, {
                status: 'stopping',
                pid: proc.pid ?? null,
                startedAtMs: getStats(pipelineId).startedAtMs,
                lastError: null,
            });
            await killProcess(pipelineId, proc);
        },

        restartAll(): void {
            for (const pipeline of db.listBondingEnabledPipelines()) start(pipeline.id);
        },

        shutdown(): void {
            for (const timer of timers.values()) clearTimeout(timer);
            timers.clear();
            pendingStart.clear();
            for (const [pipelineId, proc] of processes) {
                stopRequested.add(pipelineId);
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
