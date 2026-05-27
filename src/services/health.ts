import type { Express } from 'express';
import {
    fetchSrsStreams,
    type SrsStream,
    type SrsStreamVideo,
    type SrsStreamAudio,
} from '../utils/srs.js';
import type { Db } from '../types.js';
import type { OutputService } from './outputs.js';

export interface InputHealth {
    live: boolean;
    recvBitrateKbps: number | null;
    sendBitrateKbps: number | null;
    readers: number;
    uptimeMs: number | null;
    video: SrsStreamVideo | null;
    audio: SrsStreamAudio | null;
}

interface PipelineHealth {
    input: InputHealth;
    outputs: Record<string, { status: string; pid: number | null; bitrateKbps: number | null }>;
}

export interface HealthSnapshot {
    generatedAt: string;
    srsReachable: boolean;
    pipelines: Record<string, PipelineHealth>;
}

export function createHealthService(db: Db, outputService: OutputService) {
    let snapshot: HealthSnapshot = {
        generatedAt: new Date().toISOString(),
        srsReachable: false,
        pipelines: {},
    };

    const inputLive = new Map<number, boolean>();

    function isInputLive(pipelineId: number): boolean {
        return inputLive.get(pipelineId) ?? false;
    }

    async function poll(): Promise<void> {
        const pipelines = db.listPipelines();
        const outputs = db.listOutputs();

        let streams: SrsStream[] = [];
        let srsReachable = true;
        try {
            streams = await fetchSrsStreams();
        } catch {
            srsReachable = false;
        }

        const liveByPath = new Map<string, SrsStream>();
        for (const s of streams) {
            if (s.publish?.active) {
                liveByPath.set(`${s.app}/${s.name}`, s);
            }
        }

        const pipelinesHealth: Record<string, PipelineHealth> = {};
        for (const pipeline of pipelines) {
            const path = `live/${pipeline.streamKey}`;
            const s = liveByPath.get(path);
            const wasLive = inputLive.get(pipeline.id) ?? false;
            const nowLive = !!s;
            inputLive.set(pipeline.id, nowLive);

            if (!wasLive && nowLive) {
                outputService.restartPipelineOutputs(pipeline.id);
            }

            const pipelineOutputs = outputs.filter((o) => o.pipelineId === pipeline.id);
            const outputsHealth: Record<
                string,
                { status: string; pid: number | null; bitrateKbps: number | null }
            > = {};
            for (const out of pipelineOutputs) {
                outputsHealth[out.id] = outputService.getStats(out.id);
            }

            pipelinesHealth[String(pipeline.id)] = {
                input: {
                    live: nowLive,
                    recvBitrateKbps: s?.kbps?.recv_30s ?? null,
                    sendBitrateKbps: s?.kbps?.send_30s ?? null,
                    readers: s ? Math.max(0, (s.clients ?? 0) - 1) : 0,
                    uptimeMs: s?.live_ms ?? null,
                    video: s?.video ?? null,
                    audio: s?.audio ?? null,
                },
                outputs: outputsHealth,
            };
        }

        snapshot = {
            generatedAt: new Date().toISOString(),
            srsReachable,
            pipelines: pipelinesHealth,
        };
    }

    function start(): void {
        void poll();
        setInterval(() => void poll(), 3000).unref();
    }

    function registerRoutes(app: Express): void {
        app.get('/health', (_req, res) => {
            res.json(snapshot);
        });
    }

    return { start, registerRoutes, isInputLive };
}
