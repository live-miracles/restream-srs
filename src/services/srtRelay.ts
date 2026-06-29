import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import type { Db, Pipeline } from '../types.js';

function resolveSrtLiveTransmitCmd(): string {
    if (process.env.SRT_LIVE_TRANSMIT_PATH) return process.env.SRT_LIVE_TRANSMIT_PATH;
    const local = path.join(process.cwd(), 'objs', 'srt-live-transmit');
    if (existsSync(local)) return local;
    if (existsSync('/usr/local/bin/srt-live-transmit')) return '/usr/local/bin/srt-live-transmit';
    return 'srt-live-transmit';
}

const SRT_LIVE_TRANSMIT_CMD = resolveSrtLiveTransmitCmd();
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
        const relayParams: Record<string, string | number | boolean> = { groupconnect: 1 };
        const publishParams: Record<string, string | number | boolean> = {
            streamid: `#!::r=live/${pipeline.streamKey},m=publish`,
        };
        if (passphrase) {
            relayParams.passphrase = passphrase;
            relayParams.pbkeylen = 16;
            publishParams.passphrase = passphrase;
            publishParams.pbkeylen = 16;
        }
        return [
            srtUrl(`srt://:${getPort(pipeline.id)}`, relayParams),
            srtUrl(`srt://127.0.0.1:${SRS_SRT_PORT}`, publishParams),
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
        const child = spawn(SRT_LIVE_TRANSMIT_CMD, args, {
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
            `[srt-relay] pipeline ${pipeline.id} listening on UDP ${getPort(pipeline.id)} pid=${child.pid}`,
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
            console.warn(`[srt-relay] pipeline ${pipeline.id} error:`, message);
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
                `[srt-relay] pipeline ${pipeline.id} exited code=${code} signal=${signal} status=${wasStop ? 'stopped' : 'failed'}`,
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
