import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { rtmpPullUrl, srtPullUrl } from '../utils/srs.js';
import type { Db } from '../types.js';

const FFMPEG_CMD = process.env.FFMPEG_PATH || 'ffmpeg';
const STDERR_TAIL_BYTES = 2000;
const STOP_WAIT_MS = 200;

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
        await new Promise((r) => setTimeout(r, STOP_WAIT_MS));
    }
    throw new Error('Preview timed out — no active input stream on this pipeline');
}

export interface PreviewService {
    start(pipelineId: number, audioTrackCount?: number): Promise<{ hlsUrl: string }>;
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

    async function start(pipelineId: number, audioTrackCount = 1): Promise<{ hlsUrl: string }> {
        const playlistName = audioTrackCount > 1 ? 'master.m3u8' : 'index.m3u8';
        const hlsUrl = `/hls/${pipelineId}/${playlistName}`;
        if (procs.has(pipelineId)) return { hlsUrl };

        const pipeline = db.getPipeline(pipelineId);
        if (!pipeline) throw new Error('Pipeline not found');

        const outDir = path.join(baseDir, String(pipelineId));
        fs.mkdirSync(outDir, { recursive: true });

        // RTMP/FLV only carries the first audio track, so a source with multiple audio
        // tracks must be pulled via SRT to expose them all. The SRT pull is a raw
        // MPEG-TS that often starts mid-GOP, so stream-copying video yields keyframe-
        // misaligned HLS segments that stall the player — transcode with forced 2 s
        // keyframes on that path only. Single-track sources take the cheap RTMP copy
        // path with no extra encoding.
        const multiTrack = audioTrackCount > 1;
        const inputUrl = multiTrack
            ? srtPullUrl(pipeline.streamKey)
            : rtmpPullUrl(pipeline.streamKey);

        const videoArgs = multiTrack
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

        // SRT/MPEG-TS sources — including anything SRS remuxes from SRT to RTMP via
        // srt_to_rtmp — deliver audio with jittery, occasionally discontinuous
        // timestamps (PCR rounding + SRT packet-loss gaps). Re-encoding those 1:1
        // yields gaps and crackle ("breaking" audio). aresample=async=1 fills small
        // gaps with silence and soft-compensates drift so the AAC output stays
        // continuous. Clean RTMP inputs have well-behaved timestamps, so it's a no-op
        // for them — safe to apply on every preview.
        const audioArgs = ['-af', 'aresample=async=1', '-c:a', 'aac', '-ac', '2', '-ar', '48000'];
        const hlsCommon = [
            '-f',
            'hls',
            '-hls_time',
            '2',
            '-hls_list_size',
            '10',
            '-hls_flags',
            'delete_segments+independent_segments',
        ];

        // The playlist whose appearance means the stream is live, and the URL the
        // browser loads. For multi-track we emit a master playlist that exposes each
        // audio track as a switchable EXT-X-MEDIA rendition (hls.js will not surface
        // audio tracks that are merely muxed into a single media playlist), so the
        // browser switches tracks natively. Single-track stays a plain media playlist.
        let outputArgs: string[];
        let readyPlaylist: string;
        if (multiTrack) {
            const audioMaps = Array.from({ length: audioTrackCount }, (_, i) => [
                '-map',
                `0:a:${i}`,
            ]).flat();
            const varStreamMap = [
                'v:0,agroup:aud',
                ...Array.from(
                    { length: audioTrackCount },
                    (_, i) =>
                        `a:${i},agroup:aud,name:track${i + 1}${i === 0 ? ',default:yes' : ''}`,
                ),
            ].join(' ');
            outputArgs = [
                '-map',
                '0:v:0?',
                ...audioMaps,
                ...videoArgs,
                ...audioArgs,
                ...hlsCommon,
                '-hls_segment_filename',
                path.join(outDir, 'v%v_%d.ts'),
                '-master_pl_name',
                'master.m3u8',
                '-var_stream_map',
                varStreamMap,
                path.join(outDir, 'v%v.m3u8'),
            ];
            readyPlaylist = path.join(outDir, 'v0.m3u8');
        } else {
            outputArgs = [
                '-map',
                '0:v:0?',
                '-map',
                '0:a:0?',
                ...videoArgs,
                ...audioArgs,
                ...hlsCommon,
                path.join(outDir, 'index.m3u8'),
            ];
            readyPlaylist = path.join(outDir, 'index.m3u8');
        }

        const proc = spawn(FFMPEG_CMD, ['-fflags', '+genpts', '-i', inputUrl, ...outputArgs], {
            stdio: ['ignore', 'ignore', 'pipe'],
            env: process.env,
        });

        procs.set(pipelineId, proc);
        console.log(
            `[preview] ${pipelineId} started pid=${proc.pid} multiTrack=${multiTrack} tracks=${audioTrackCount}`,
        );

        let stderrTail = '';
        proc.stderr?.on('data', (d: Buffer) => {
            stderrTail = (stderrTail + d.toString()).slice(-STDERR_TAIL_BYTES);
        });

        proc.on('exit', (code, signal) => {
            if (procs.get(pipelineId) === proc) procs.delete(pipelineId);
            // Clean up this pipeline's HLS dir unless a newer preview now owns it
            // (covers both a user stop, which clears the map entry first, and a crash).
            if (!procs.has(pipelineId)) {
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
            await waitForPlaylist(readyPlaylist, 10_000);
        } catch (err) {
            doStop(pipelineId);
            throw err;
        }

        return { hlsUrl };
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
