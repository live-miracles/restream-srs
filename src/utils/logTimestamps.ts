// The dashboard's Server Logs view reads this service's journal tail with
// `journalctl -o cat` (src/api/srs.ts), which strips journald's own per-entry
// timestamp so SRS's ANSI color codes pass through untouched. SRS's own log
// lines self-timestamp (e.g. "[2026-07-14 11:32:56.465][WARN] ..."), so they
// stay readable regardless; ours didn't. This prefixes console.log/warn/error
// with a plain (uncolored) "[timestamp][LEVEL]" stamp in that same format, so
// `-o cat` output and raw journalctl are both readable during troubleshooting.
function timestamp(): string {
    const now = new Date();
    const pad = (n: number, width = 2) => String(n).padStart(width, '0');
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
    return `${date} ${time}`;
}

export function installLogTimestamps(): void {
    const originalLog = console.log.bind(console);
    const originalWarn = console.warn.bind(console);
    const originalError = console.error.bind(console);

    console.log = (...args: unknown[]) => originalLog(`[${timestamp()}][INFO]`, ...args);
    console.warn = (...args: unknown[]) => originalWarn(`[${timestamp()}][WARN]`, ...args);
    console.error = (...args: unknown[]) => originalError(`[${timestamp()}][ERROR]`, ...args);
}
