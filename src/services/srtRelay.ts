import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import type { Db, Pipeline } from '../types.js';

const SRS_SRT_PORT = parseInt(process.env.SRS_SRT_PORT || '10080');
const RELAY_BASE_PORT = 11000;  // encoder-facing listener ports
const SIGKILL_DELAY_MS = 5000;
const STDERR_TAIL_BYTES = 3000;
const RESTART_DELAY_MS = 5000;

function resolveSrtGroupRecv(): string {
    if (process.env.SRT_GROUP_RECV_PATH) return process.env.SRT_GROUP_RECV_PATH;
    for (const p of ['./objs/srt-group-recv', '/usr/local/bin/srt-group-recv']) {
        if (existsSync(p)) return p;
    }
    return 'srt-group-recv';
}

const SRT_GROUP_RECV_CMD = resolveSrtGroupRecv();

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
    const procs = new Map<number, ChildProcess>();
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

    function isRunning(pipelineId: number): boolean {
        return procs.has(pipelineId);
    }

    function srtUrl(base: string, params: Record<string, string | number | boolean>): string {
        const qs = Object.entries(params)
            .map(([k, v]) => `${k}=${k === 'streamid' ? String(v) : encodeURIComponent(String(v))}`)
            .join('&');
        return `${base}?${qs}`;
    }

    // srt-group-recv: accepts the bonded SRT group from the encoder and forwards
    // directly to SRS as a plain SRT caller. The SRS connection is opened only when
    // the encoder connects, so SRS's idle-publisher timeout is never triggered.
    function relayArgs(pipeline: Pipeline): string[] {
        const passphrase = db.getSetting('srtPassphrase') || null;
        const relayPort = getPort(pipeline.id);

        const inputParams: Record<string, string | number | boolean> = {
            mode: 'listener',
            groupconnect: 1,
            transtype: 'live',
            latency: 240,  // milliseconds (SRTO_LATENCY unit since SRT 1.3.0)
        };
        if (passphrase) {
            inputParams.passphrase = passphrase;
            inputParams.pbkeylen = 16;
        }

        const outputParams: Record<string, string | number | boolean> = {
            streamid: `#!::r=live/${pipeline.streamKey},m=publish`,
            transtype: 'live',
            latency: 200,  // milliseconds
        };
        if (passphrase) {
            outputParams.passphrase = passphrase;
            outputParams.pbkeylen = 16;
        }

        return [
            srtUrl(`srt://0.0.0.0:${relayPort}`, inputParams),
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

    function killProc(proc: ChildProcess): Promise<void> {
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
        if (isRunning(pipelineId)) {
            if (stopRequested.has(pipelineId)) pendingStart.add(pipelineId);
            return;
        }
        pendingStart.delete(pipelineId);

        const pipeline = db.getPipeline(pipelineId);
        if (!pipeline) throw new Error('Pipeline not found');
        if (!pipeline.streamKey) throw new Error('Pipeline stream key is missing');

        const relayPort = getPort(pipelineId);

        const proc = spawn(SRT_GROUP_RECV_CMD, relayArgs(pipeline), {
            stdio: ['ignore', 'ignore', 'pipe'],
            env: process.env,
        });
        procs.set(pipelineId, proc);

        const startedAtMs = Date.now();
        setStatus(pipelineId, {
            status: 'running',
            pid: proc.pid ?? null,
            startedAtMs,
            lastError: null,
        });
        console.log(
            `[srt-relay] pipeline ${pipelineId} listening on SRT :${relayPort} → SRS :${SRS_SRT_PORT} (pid=${proc.pid})`,
        );

        let stderr = '';
        proc.stderr?.on('data', (d: Buffer) => {
            stderr = (stderr + d.toString()).slice(-STDERR_TAIL_BYTES);
        });

        proc.on('error', (err) => {
            console.warn(`[srt-relay] pipeline ${pipelineId} error:`, err.message);
        });

        proc.on('close', (code, signal) => {
            console.log(`[srt-relay] pipeline ${pipelineId} exited code=${code} signal=${signal}`);
            procs.delete(pipelineId);

            const wasStop = stopRequested.delete(pipelineId);
            const wantsRelay = db.getPipeline(pipelineId)?.bondingEnabled;
            const exitStr = `exit=${code ?? signal}`;

            setStatus(pipelineId, {
                status: wasStop ? 'stopped' : 'failed',
                pid: null,
                startedAtMs: null,
                lastError: wasStop ? null : stderr.trim() ? `${exitStr}\n${stderr.trim()}` : exitStr,
            });
            console.log(
                `[srt-relay] pipeline ${pipelineId} relay down status=${wasStop ? 'stopped' : 'failed'}`,
            );

            if (wasStop && pendingStart.delete(pipelineId) && wantsRelay) {
                start(pipelineId);
            } else if (!wasStop && wantsRelay) {
                scheduleRestart(pipelineId);
            }
        });
    }

    return {
        getPort,
        getStats,
        start,

        stop(pipelineId: number): void {
            clearTimer(pipelineId);
            if (isRunning(pipelineId)) {
                pendingStart.delete(pipelineId);
                stopRequested.add(pipelineId);
                const { pid, startedAtMs } = getStats(pipelineId);
                setStatus(pipelineId, { status: 'stopping', pid, startedAtMs, lastError: null });
                const proc = procs.get(pipelineId);
                if (proc) void killProc(proc);
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
            if (!isRunning(pipelineId)) {
                setStatus(pipelineId, {
                    status: 'stopped',
                    pid: null,
                    startedAtMs: null,
                    lastError: null,
                });
                return;
            }
            pendingStart.delete(pipelineId);
            stopRequested.add(pipelineId);
            const { pid, startedAtMs } = getStats(pipelineId);
            setStatus(pipelineId, { status: 'stopping', pid, startedAtMs, lastError: null });
            const proc = procs.get(pipelineId);
            if (proc) await killProc(proc);
        },

        restartAll(): void {
            for (const pipeline of db.listBondingEnabledPipelines()) start(pipeline.id);
        },

        shutdown(): void {
            for (const timer of timers.values()) clearTimeout(timer);
            timers.clear();
            pendingStart.clear();
            for (const pipelineId of procs.keys()) stopRequested.add(pipelineId);
            for (const proc of procs.values()) {
                try {
                    proc.kill('SIGKILL');
                } catch {
                    /* already gone */
                }
            }
            procs.clear();
        },
    };
}
