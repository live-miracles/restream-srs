import os from 'os';
import fs from 'fs';
import { execFile } from 'child_process';
import type { Express } from 'express';

const DISK_STATS_INTERVAL_MS = 30_000;
const NET_STATS_INTERVAL_MS = 3_000;
const SAMPLE_INTERVAL_MS = 10_000;
const HISTORY_MAX = 720; // 2 hours at 10 s — client trims to desired window

let prevCpu = os.cpus().map((c) => c.times);

function getCpuPercent(): number {
    const cpus = os.cpus();
    const curr = cpus.map((c) => c.times);
    let totalIdle = 0,
        totalTick = 0;
    for (let i = 0; i < cpus.length; i++) {
        const prev = prevCpu[i];
        const cur = curr[i];
        const idleDelta = cur.idle - prev.idle;
        const totalDelta =
            Object.values(cur).reduce((a, b) => a + b, 0) -
            Object.values(prev).reduce((a, b) => a + b, 0);
        totalIdle += idleDelta;
        totalTick += totalDelta;
    }
    prevCpu = curr;
    return totalTick === 0 ? 0 : Math.round((1 - totalIdle / totalTick) * 100);
}

interface DiskStats {
    totalBytes: number;
    usedBytes: number;
}

let diskStats: DiskStats | null = null;

function updateDiskStats(): void {
    execFile('df', ['-B1', '/'], (_err, stdout) => {
        if (_err) return;
        const parts = stdout.trim().split('\n')[1]?.trim().split(/\s+/);
        if (!parts || parts.length < 3) return;
        const total = parseInt(parts[1], 10);
        const used = parseInt(parts[2], 10);
        if (!isNaN(total) && !isNaN(used)) diskStats = { totalBytes: total, usedBytes: used };
    });
}

interface NetStats {
    rxBytesPerSec: number;
    txBytesPerSec: number;
}

let netStats: NetStats = { rxBytesPerSec: 0, txBytesPerSec: 0 };
let prevNetBytes: { rx: number; tx: number } | null = null;
let prevNetTime = Date.now();

function updateNetStats(): void {
    try {
        const raw = fs.readFileSync('/proc/net/dev', 'utf8');
        let rx = 0,
            tx = 0;
        for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            const colon = trimmed.indexOf(':');
            if (colon < 0) continue;
            const iface = trimmed.slice(0, colon).trim();
            if (iface === 'lo') continue;
            const fields = trimmed
                .slice(colon + 1)
                .trim()
                .split(/\s+/);
            rx += parseInt(fields[0], 10) || 0;
            tx += parseInt(fields[8], 10) || 0;
        }
        const now = Date.now();
        if (prevNetBytes) {
            const dt = (now - prevNetTime) / 1000;
            if (dt > 0) {
                netStats = {
                    rxBytesPerSec: Math.max(0, (rx - prevNetBytes.rx) / dt),
                    txBytesPerSec: Math.max(0, (tx - prevNetBytes.tx) / dt),
                };
            }
        }
        prevNetBytes = { rx, tx };
        prevNetTime = now;
    } catch {
        // /proc/net/dev not available on this platform
    }
}

export interface MetricSample {
    ts: number;
    cpu: number;
    ramUsed: number;
    ramTotal: number;
    rxBps: number;
    txBps: number;
}

const metricsHistory: MetricSample[] = [];

function sampleMetrics(): void {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    metricsHistory.push({
        ts: Date.now(),
        cpu: getCpuPercent(),
        ramUsed: totalMem - freeMem,
        ramTotal: totalMem,
        rxBps: netStats.rxBytesPerSec,
        txBps: netStats.txBytesPerSec,
    });
    if (metricsHistory.length > HISTORY_MAX) metricsHistory.shift();
}

updateDiskStats();
setInterval(updateDiskStats, DISK_STATS_INTERVAL_MS).unref();
updateNetStats();
setInterval(updateNetStats, NET_STATS_INTERVAL_MS).unref();
sampleMetrics();
setInterval(sampleMetrics, SAMPLE_INTERVAL_MS).unref();

export function registerMetricsApi(app: Express): void {
    app.get('/api/metrics/system', (_req, res) => {
        const s = metricsHistory[metricsHistory.length - 1];
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        res.json({
            cpu: { cores: os.cpus().length, percent: s?.cpu ?? 0 },
            ram: {
                usedBytes: s?.ramUsed ?? totalMem - freeMem,
                totalBytes: s?.ramTotal ?? totalMem,
            },
            disk: diskStats,
            net: {
                rxBytesPerSec: s?.rxBps ?? 0,
                txBytesPerSec: s?.txBps ?? 0,
            },
        });
    });

    app.get('/api/metrics/history', (_req, res) => {
        res.json(metricsHistory);
    });
}
