import os from 'os';
import fs from 'fs';
import { execFile } from 'child_process';
import type { Express } from 'express';

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

updateDiskStats();
setInterval(updateDiskStats, 30_000).unref();
updateNetStats();
setInterval(updateNetStats, 3_000).unref();

export function registerMetricsApi(app: Express): void {
    app.get('/api/metrics/system', (_req, res) => {
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        res.json({
            cpu: { cores: os.cpus().length, percent: getCpuPercent() },
            ram: { usedBytes: totalMem - freeMem, totalBytes: totalMem },
            disk: diskStats,
            net: netStats,
        });
    });
}
