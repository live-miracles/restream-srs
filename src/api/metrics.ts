import os from 'os';
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

export function registerMetricsApi(app: Express): void {
    app.get('/metrics/system', (_req, res) => {
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        res.json({
            cpu: { percent: getCpuPercent() },
            ram: { usedBytes: usedMem, totalBytes: totalMem },
        });
    });
}
