import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repoDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const buildScript = path.join(repoDir, 'scripts', 'build-srt-bonding-relay-local.sh');
const startScript = path.join(repoDir, 'scripts', 'srt-bonding-relay-start.sh');
const devInstallScript = path.join(repoDir, 'scripts', 'dev-server-install.sh');
const relayRepoDir = process.env.SRT_BONDING_RELAY_REPO_DIR
    ? path.resolve(process.env.SRT_BONDING_RELAY_REPO_DIR)
    : path.resolve(repoDir, '..', 'srt-bonding-relay');
const sourceFile = path.join(relayRepoDir, 'src', 'srt-bonding-relay.c');

let relayProc = null;
let rebuilding = false;
let queued = false;
let shuttingDown = false;

function runScript(script) {
    return new Promise((resolve) => {
        const proc = spawn('bash', [script], {
            cwd: repoDir,
            env: process.env,
            stdio: 'inherit',
        });
        proc.on('exit', (code, signal) => resolve({ code, signal }));
    });
}

function stopRelay() {
    return new Promise((resolve) => {
        if (!relayProc) return resolve();
        const proc = relayProc;
        relayProc = null;
        proc.once('exit', () => resolve());
        proc.kill('SIGTERM');
        setTimeout(() => {
            try {
                proc.kill('SIGKILL');
            } catch {}
        }, 3000).unref?.();
    });
}

function startRelay() {
    relayProc = spawn('bash', [startScript], {
        cwd: repoDir,
        env: process.env,
        stdio: 'inherit',
    });
    relayProc.on('exit', (code, signal) => {
        const expected = relayProc === null || shuttingDown;
        relayProc = null;
        if (!expected) {
            console.error(`[relay-dev] relay exited code=${code} signal=${signal}`);
        }
    });
}

async function rebuildAndRestart(reason) {
    if (rebuilding) {
        queued = true;
        return;
    }
    rebuilding = true;
    do {
        queued = false;
        console.log(`[relay-dev] ${reason}`);
        await stopRelay();
        const build = await runScript(buildScript);
        if (build.code === 0) {
            startRelay();
        } else {
            console.error('[relay-dev] build failed; waiting for next change');
        }
        reason = 'rebuilding relay after source change';
    } while (queued && !shuttingDown);
    rebuilding = false;
}

const ensure = await runScript(devInstallScript);
if (ensure.code !== 0) {
    console.error('[relay-dev] failed to prepare local SRS/relay development dependencies');
    process.exit(1);
}

fs.watchFile(sourceFile, { interval: 300 }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return;
    void rebuildAndRestart('rebuilding relay after source change');
});

process.on('SIGINT', async () => {
    shuttingDown = true;
    fs.unwatchFile(sourceFile);
    await stopRelay();
    process.exit(0);
});
process.on('SIGTERM', async () => {
    shuttingDown = true;
    fs.unwatchFile(sourceFile);
    await stopRelay();
    process.exit(0);
});

await rebuildAndRestart('initial relay build');
