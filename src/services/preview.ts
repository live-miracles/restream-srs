import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { rtmpPullUrl, srtPullUrl } from '../utils/srs.js';
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
    start(pipelineId: number, audioTrack?: number | null): Promise<{ hlsUrl: string }>;
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

    async function start(
        pipelineId: number,
        audioTrack: number | null = null,
    ): Promise<{ hlsUrl: string }> {
        if (procs.has(pipelineId)) return { hlsUrl: `/hls/${pipelineId}/index.m3u8` };

        const pipeline = db.getPipeline(pipelineId);
        if (!pipeline) throw new Error('Pipeline not found');

        const outDir = path.join(baseDir, String(pipelineId));
        fs.mkdirSync(outDir, { recursive: true });

        const m3u8Path = path.join(outDir, 'index.m3u8');

        // To address a specific track we must pull via SRT (RTMP/FLV only exposes
        // the first audio track). Default preview uses the cheaper RTMP pull.
        const selectTrack = audioTrack !== null && audioTrack >= 0;
        const inputUrl = selectTrack
            ? srtPullUrl(pipeline.streamKey)
            : rtmpPullUrl(pipeline.streamKey);
        const audioMap = selectTrack ? `0:a:${audioTrack}?` : '0:a:0?';

        // The SRT pull arrives as a raw MPEG-TS that often starts mid-GOP, so video
        // stream-copy yields HLS segments that aren't keyframe-aligned and the player
        // stalls after a few seconds. Transcode video with forced 2s keyframes on the
        // SRT (track-select) path; the cheap RTMP single-track path can still copy.
        const videoArgs = selectTrack
            ? [
                  '-c:v',
                  'libx264',
                  '-preset',
                  'veryfast',
                  '-tune',
                  'zerolatency',
                  '-pix_fmt',
                  'yuv420p',
                  '-g',
                  '48',
                  '-keyint_min',
                  '48',
                  '-sc_threshold',
                  '0',
                  '-force_key_frames',
                  'expr:gte(t,n_forced*2)',
              ]
            : ['-c:v', 'copy'];

        const proc = spawn(
            FFMPEG_CMD,
            [
                '-fflags',
                '+genpts',
                '-i',
                inputUrl,
                // Always transcode audio to AAC stereo. The source may carry a codec
                // MPEG-TS/HLS can't stream-copy (PCM, Opus, FLAC, multitrack PCM),
                // which would otherwise kill ffmpeg on the first audio packet.
                '-map',
                '0:v:0?',
                '-map',
                audioMap,
                ...videoArgs,
                '-c:a',
                'aac',
                '-ac',
                '2',
                '-ar',
                '48000',
                '-f',
                'hls',
                '-hls_time',
                '2',
                '-hls_list_size',
                '10',
                '-hls_flags',
                'delete_segments+independent_segments',
                m3u8Path,
            ],
            { stdio: ['ignore', 'ignore', 'pipe'], env: process.env },
        );

        procs.set(pipelineId, proc);
        console.log(`[preview] ${pipelineId} started pid=${proc.pid}`);

        // Keep the tail of ffmpeg stderr so a failed preview reports why.
        let stderrTail = '';
        proc.stderr?.on('data', (d: Buffer) => {
            stderrTail = (stderrTail + d.toString()).slice(-2000);
        });

        proc.on('exit', (code, signal) => {
            // Only tear down if this proc is still the active one. A quick restart
            // (e.g. switching audio track) may have already replaced it; clobbering
            // the map/dir here would kill the new preview's freshly written segments.
            if (procs.get(pipelineId) === proc) {
                procs.delete(pipelineId);
                fs.rm(outDir, { recursive: true, force: true }, () => {});
            }
            if (code && code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGKILL') {
                console.warn(
                    `[preview] ${pipelineId} ffmpeg exited code=${code}:\n${stderrTail.trim()}`,
                );
            } else {
                console.log(`[preview] ${pipelineId} exited`);
            }
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
