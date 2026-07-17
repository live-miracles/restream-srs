import fs from 'fs';

const CLK_TCK = 100; // USER_HZ; the near-universal Linux default (no portable sysconf() from Node)

// procfs reads of small single files; cheap enough for a 5-10s poll per process
// (page-cache hit, no real disk I/O).
export function readProcRssBytes(pid: number): number | null {
    try {
        const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
        const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
        return match ? parseInt(match[1], 10) * 1024 : null;
    } catch {
        return null;
    }
}

function readProcCpuTicks(pid: number): number | null {
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        // comm (2nd field) can contain spaces/parens, so split after its closing
        // ')' rather than trusting fixed whitespace-separated offsets from the start.
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const utime = parseInt(fields[11], 10); // utime is the 14th field overall
        const stime = parseInt(fields[12], 10); // stime is the 15th field overall
        return Number.isFinite(utime) && Number.isFinite(stime) ? utime + stime : null;
    } catch {
        return null;
    }
}

// Scans /proc for running processes whose argv[0] is exactly execPath. Used at
// startup to find ffmpeg children orphaned by a previous instance of this
// process (killed by 'tsx watch', a crash, OOM, ...) — the '-progress pipe:1'
// SIGPIPE self-exit ffmpeg is meant to trigger once our stdout pipe closes
// isn't reliable enough to depend on alone.
export function findPidsByExecutable(
    execPath: string,
    matchesArgs: (args: string[]) => boolean = () => true,
): number[] {
    let entries: string[];
    try {
        entries = fs.readdirSync('/proc');
    } catch {
        return []; // no /proc (non-Linux dev machine)
    }
    const pids: number[] = [];
    for (const entry of entries) {
        if (!/^\d+$/.test(entry)) continue;
        let cmdline: string;
        try {
            cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8');
        } catch {
            continue; // process exited mid-scan
        }
        const args = cmdline.split('\0').filter(Boolean);
        if (args[0] === execPath && matchesArgs(args.slice(1))) pids.push(Number(entry));
    }
    return pids;
}

export interface ProcCpuTracker {
    // %CPU relative to a single core (ps/top convention), not normalized by core
    // count. Returns null on the first sample for a key, and again on the first
    // sample after its pid changes (process restart reusing the same key), since
    // there's no prior tick count yet to diff against.
    sample(key: string | number, pid: number): number | null;
    delete(key: string | number): void;
}

export function createProcCpuTracker(): ProcCpuTracker {
    const prev = new Map<string | number, { pid: number; ts: number; ticks: number }>();
    return {
        sample(key, pid) {
            const ticks = readProcCpuTicks(pid);
            if (ticks == null) {
                prev.delete(key);
                return null;
            }
            const now = Date.now();
            const last = prev.get(key);
            prev.set(key, { pid, ts: now, ticks });
            if (!last || last.pid !== pid || ticks < last.ticks) return null;
            const dtSeconds = (now - last.ts) / 1000;
            return dtSeconds > 0
                ? Math.round(((ticks - last.ticks) / CLK_TCK / dtSeconds) * 100)
                : null;
        },
        delete(key) {
            prev.delete(key);
        },
    };
}
