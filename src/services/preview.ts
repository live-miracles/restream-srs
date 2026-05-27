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

export interface PreviewService {
    start(pipelineId: number): { hlsUrl: string };
    stop(pipelineId: number): void;
    baseDir: string;
}

export function createPreviewService(db: Db): PreviewService {
    const baseDir = resolveBaseDir();
    const procs = new Map<number, ChildProcess>();

    function start(pipelineId: number): { hlsUrl: string } {
        if (procs.has(pipelineId)) return { hlsUrl: `/hls/${pipelineId}/index.m3u8` };

        const pipeline = db.getPipeline(pipelineId);
        if (!pipeline) throw new Error('Pipeline not found');

        const outDir = path.join(baseDir, String(pipelineId));
        fs.mkdirSync(outDir, { recursive: true });

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
                '5',
                '-hls_flags',
                'delete_segments',
                path.join(outDir, 'index.m3u8'),
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

        return { hlsUrl: `/hls/${pipelineId}/index.m3u8` };
    }

    function stop(pipelineId: number): void {
        const proc = procs.get(pipelineId);
        if (!proc) return;
        procs.delete(pipelineId);
        proc.kill('SIGTERM');
        console.log(`[preview] ${pipelineId} stopping`);
    }

    return { start, stop, baseDir };
}
