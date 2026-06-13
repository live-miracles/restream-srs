import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { rtmpPullUrl } from '../utils/srs.js';
import type { Db } from '../types.js';

const FFMPEG_CMD = process.env.FFMPEG_PATH || 'ffmpeg';

function resolveBaseDir(): string {
    const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'data.db');
    return path.join(path.dirname(dbPath), 'hls');
}

async function waitForPlaylist(m3u8Path: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const content = fs.readFileSync(m3u8Path, 'utf8');
            if (content.includes('.ts')) return;
        } catch {
            /* not yet */
        }
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('Preview timed out — no active input stream on this pipeline');
}

export interface PreviewService {
    start(pipelineId: number): Promise<{ hlsUrl: string }>;
    stop(pipelineId: number): void;
    shutdown(): void;
    baseDir: string;
}

export function createPreviewService(db: Db): PreviewService {
    const baseDir = resolveBaseDir();
    const procs = new Map<number, ChildProcess>();

    function doStop(pipelineId: number): void {
        const proc = procs.get(pipelineId);
        if (!proc) return;
        procs.delete(pipelineId);
        proc.kill('SIGTERM');
        console.log(`[preview] ${pipelineId} stopping`);
    }

    async function start(pipelineId: number): Promise<{ hlsUrl: string }> {
        if (procs.has(pipelineId)) return { hlsUrl: `/hls/${pipelineId}/index.m3u8` };

        const pipeline = db.getPipeline(pipelineId);
        if (!pipeline) throw new Error('Pipeline not found');

        const outDir = path.join(baseDir, String(pipelineId));
        fs.mkdirSync(outDir, { recursive: true });

        const m3u8Path = path.join(outDir, 'index.m3u8');

        const proc = spawn(
            FFMPEG_CMD,
            [
                '-i',
                rtmpPullUrl(pipeline.streamKey),
                '-c',
                'copy',
                '-f',
                'hls',
                '-hls_time',
                '2',
                '-hls_list_size',
                '10',
                '-hls_flags',
                'delete_segments',
                m3u8Path,
            ],
            { stdio: 'ignore', env: process.env },
        );

        procs.set(pipelineId, proc);
        console.log(`[preview] ${pipelineId} started pid=${proc.pid}`);

        proc.on('exit', () => {
            procs.delete(pipelineId);
            fs.rm(outDir, { recursive: true, force: true }, () => {});
            console.log(`[preview] ${pipelineId} exited`);
        });

        try {
            await waitForPlaylist(m3u8Path, 10_000);
        } catch (err) {
            doStop(pipelineId);
            throw err;
        }

        return { hlsUrl: `/hls/${pipelineId}/index.m3u8` };
    }

    function shutdown(): void {
        for (const proc of procs.values()) {
            try {
                proc.kill('SIGKILL');
            } catch {
                /* already gone */
            }
        }
        procs.clear();
    }

    return { start, stop: doStop, shutdown, baseDir };
}
