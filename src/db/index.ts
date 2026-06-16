import BetterSqlite3 from 'better-sqlite3';
import crypto from 'crypto';
import path from 'path';
import { setupDatabaseSchema } from './schema.js';
import type {
    Pipeline,
    Output,
    OutputLog,
    PipelineLog,
    OutputSink,
    PullMethod,
    SinkInput,
    StreamKey,
    Db,
} from '../types.js';

const PIPELINE_SELECT = `
    SELECT p.id, p.name, p.stream_key_id, COALESCE(sk.key, '') as stream_key
    FROM pipelines p
    LEFT JOIN stream_keys sk ON sk.id = p.stream_key_id
`;

const STREAM_KEY_SLOTS = 99;
const LOG_RETENTION_LIMIT = 50;

function rowToPipeline(row: Record<string, unknown>): Pipeline {
    return {
        id: row.id as number,
        name: row.name as string,
        streamKey: row.stream_key as string,
        streamKeyId: row.stream_key_id as number,
    };
}

function rowToStreamKey(row: Record<string, unknown>): StreamKey {
    return { id: row.id as number, slot: row.slot as number, key: row.key as string };
}

export function createDb(dbPath?: string): Db {
    const resolvedPath = dbPath ?? process.env.DB_PATH ?? path.join(process.cwd(), 'data.db');
    const sqlite = new BetterSqlite3(resolvedPath);
    setupDatabaseSchema(sqlite);

    // Seed stream key slots 1–99 if missing
    for (let slot = 1; slot <= STREAM_KEY_SLOTS; slot++) {
        const existing = sqlite.prepare('SELECT id FROM stream_keys WHERE slot = ?').get(slot);
        if (!existing) {
            const key = `key${String(slot).padStart(2, '0')}_${crypto.randomBytes(16).toString('hex')}`;
            sqlite.prepare('INSERT INTO stream_keys (slot, key) VALUES (?, ?)').run(slot, key);
        }
    }

    // Read prepared statements — load entire tables, combine in JS.
    // The dataset is small (~30 pipelines / 500 sinks) so full-table reads
    // are cheaper and simpler than maintaining targeted per-entity queries.
    const stmtLoadPipelines = sqlite.prepare(`${PIPELINE_SELECT} ORDER BY p.id`);
    const stmtLoadOutputs = sqlite.prepare('SELECT * FROM outputs ORDER BY pipeline_id, seq');
    const stmtLoadSinks = sqlite.prepare(
        'SELECT output_id, seq, url, audio_encoding FROM output_sinks ORDER BY output_id, seq',
    );

    // Write prepared statements
    const stmtDeleteSinks = sqlite.prepare('DELETE FROM output_sinks WHERE output_id = ?');
    const stmtInsertSink = sqlite.prepare(
        'INSERT INTO output_sinks (id, output_id, seq, url, audio_encoding) VALUES (?, ?, ?, ?, ?)',
    );
    const stmtInsertOutputLog = sqlite.prepare(
        'INSERT INTO output_logs (output_id, ts, event, message) VALUES (?, ?, ?, ?)',
    );
    const stmtPruneOutputLogs = sqlite.prepare(
        `DELETE FROM output_logs WHERE output_id = ? AND id NOT IN (
            SELECT id FROM output_logs WHERE output_id = ? ORDER BY id DESC LIMIT ${LOG_RETENTION_LIMIT}
        )`,
    );
    const stmtGetOutputLogs = sqlite.prepare(
        'SELECT id, output_id, ts, event, message FROM output_logs WHERE output_id = ? ORDER BY id DESC LIMIT ?',
    );
    const stmtInsertPipelineLog = sqlite.prepare(
        'INSERT INTO pipeline_logs (pipeline_id, ts, event, message) VALUES (?, ?, ?, ?)',
    );
    const stmtPrunePipelineLogs = sqlite.prepare(
        `DELETE FROM pipeline_logs WHERE pipeline_id = ? AND id NOT IN (
            SELECT id FROM pipeline_logs WHERE pipeline_id = ? ORDER BY id DESC LIMIT ${LOG_RETENTION_LIMIT}
        )`,
    );
    const stmtGetPipelineLogs = sqlite.prepare(
        'SELECT id, pipeline_id, ts, event, message FROM pipeline_logs WHERE pipeline_id = ? ORDER BY id DESC LIMIT ?',
    );
    const stmtCreateSession = sqlite.prepare(
        'INSERT OR REPLACE INTO sessions (token, created_at) VALUES (?, ?)',
    );
    const stmtDeleteSession = sqlite.prepare('DELETE FROM sessions WHERE token = ?');
    const stmtListSessions = sqlite.prepare('SELECT token FROM sessions');
    const stmtPruneExpiredSessions = sqlite.prepare('DELETE FROM sessions WHERE created_at < ?');

    function loadAllPipelines(): Pipeline[] {
        return (stmtLoadPipelines.all() as Record<string, unknown>[]).map(rowToPipeline);
    }

    function loadAllOutputs(): Output[] {
        const outputRows = stmtLoadOutputs.all() as Record<string, unknown>[];
        const sinkRows = stmtLoadSinks.all() as Record<string, unknown>[];

        const sinksMap = new Map<string, OutputSink[]>();
        for (const r of sinkRows) {
            const id = r.output_id as string;
            if (!sinksMap.has(id)) sinksMap.set(id, []);
            sinksMap.get(id)!.push({
                seq: r.seq as number,
                url: r.url as string,
                audioEncoding: (r.audio_encoding as string) || 'copy',
            });
        }

        return outputRows.map((row) => {
            const id = row.id as string;
            return {
                id,
                pipelineId: row.pipeline_id as number,
                seq: row.seq as number,
                name: row.name as string,
                desiredState: row.desired_state as 'running' | 'stopped',
                videoEncoding: (row.encoding as string) || 'copy',
                pullMethod: (row.pull_method as PullMethod) || 'rtmp',
                sinks: sinksMap.get(id) ?? [],
            };
        });
    }

    function insertSinks(outputId: string, sinks: SinkInput[]): void {
        sinks.forEach((s, i) => {
            const seq = i + 1;
            stmtInsertSink.run(
                `${outputId}:${seq}`,
                outputId,
                seq,
                s.url,
                s.audioEncoding ?? 'copy',
            );
        });
    }

    function nextPipelineId(): number {
        const existing = loadAllPipelines();
        let id = 1;
        while (existing.some((p) => p.id === id)) id++;
        return id;
    }

    return {
        getSetting(key: string): string | null {
            const row = sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
                | { value: string }
                | undefined;
            return row?.value ?? null;
        },

        setSetting(key: string, value: string): void {
            sqlite
                .prepare(
                    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
                )
                .run(key, value);
        },

        listStreamKeys(): StreamKey[] {
            return (
                sqlite
                    .prepare(
                        'SELECT id, slot, key FROM stream_keys WHERE slot IS NOT NULL ORDER BY slot',
                    )
                    .all() as Record<string, unknown>[]
            ).map(rowToStreamKey);
        },

        regenerateStreamKeys(): StreamKey[] {
            const rows = sqlite
                .prepare('SELECT id, slot FROM stream_keys WHERE slot IS NOT NULL ORDER BY slot')
                .all() as { id: number; slot: number }[];
            sqlite.transaction(() => {
                for (const row of rows) {
                    const newKey = `key${String(row.slot).padStart(2, '0')}_${crypto.randomBytes(16).toString('hex')}`;
                    sqlite
                        .prepare('UPDATE stream_keys SET key = ? WHERE id = ?')
                        .run(newKey, row.id);
                }
            })();
            return (
                sqlite
                    .prepare(
                        'SELECT id, slot, key FROM stream_keys WHERE slot IS NOT NULL ORDER BY slot',
                    )
                    .all() as Record<string, unknown>[]
            ).map(rowToStreamKey);
        },

        createPipeline(): Pipeline {
            const id = nextPipelineId();
            const keyRow = sqlite
                .prepare(
                    `SELECT sk.id FROM stream_keys sk
                     WHERE sk.slot IS NOT NULL
                     AND sk.id NOT IN (SELECT stream_key_id FROM pipelines WHERE stream_key_id IS NOT NULL)
                     ORDER BY sk.slot LIMIT 1`,
                )
                .get() as { id: number } | undefined;
            if (!keyRow) throw new Error('No unassigned stream keys available');
            sqlite
                .prepare('INSERT INTO pipelines (id, name, stream_key_id) VALUES (?, ?, ?)')
                .run(id, `Pipeline ${id}`, keyRow.id);
            return loadAllPipelines().find((p) => p.id === id)!;
        },

        getPipeline(id: number): Pipeline | undefined {
            return loadAllPipelines().find((p) => p.id === id);
        },

        listPipelines(): Pipeline[] {
            return loadAllPipelines();
        },

        updatePipeline(id: number, name: string, streamKeyId?: number): Pipeline | null {
            if (streamKeyId !== undefined) {
                sqlite
                    .prepare('UPDATE pipelines SET name = ?, stream_key_id = ? WHERE id = ?')
                    .run(name, streamKeyId, id);
            } else {
                sqlite.prepare('UPDATE pipelines SET name = ? WHERE id = ?').run(name, id);
            }
            return loadAllPipelines().find((p) => p.id === id) ?? null;
        },

        deletePipeline(id: number): boolean {
            const result = sqlite.prepare('DELETE FROM pipelines WHERE id = ?').run(id);
            return result.changes > 0;
        },

        createOutput({
            pipelineId,
            name,
            videoEncoding = 'copy',
            pullMethod = 'rtmp',
            sinks,
        }): Output {
            const seqRow = sqlite
                .prepare(
                    'SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM outputs WHERE pipeline_id = ?',
                )
                .get(pipelineId) as { next_seq: number };
            const seq = seqRow.next_seq;
            const id = `${pipelineId}-${seq}`;
            sqlite.transaction(() => {
                sqlite
                    .prepare(
                        'INSERT INTO outputs (id, pipeline_id, seq, name, desired_state, encoding, pull_method) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    )
                    .run(id, pipelineId, seq, name, 'stopped', videoEncoding, pullMethod);
                insertSinks(id, sinks);
            })();
            return loadAllOutputs().find((o) => o.id === id)!;
        },

        listOutputs(): Output[] {
            return loadAllOutputs();
        },

        listOutputsForPipeline(pipelineId: number): Output[] {
            return loadAllOutputs().filter((o) => o.pipelineId === pipelineId);
        },

        updateOutput(id: string, { name, videoEncoding, pullMethod, sinks }): Output | null {
            sqlite.transaction(() => {
                sqlite
                    .prepare(
                        'UPDATE outputs SET name = ?, encoding = ?, pull_method = ? WHERE id = ?',
                    )
                    .run(name, videoEncoding, pullMethod, id);
                stmtDeleteSinks.run(id);
                insertSinks(id, sinks);
            })();
            return loadAllOutputs().find((o) => o.id === id) ?? null;
        },

        setOutputDesiredState(id: string, desiredState: 'running' | 'stopped'): Output | null {
            sqlite
                .prepare('UPDATE outputs SET desired_state = ? WHERE id = ?')
                .run(desiredState, id);
            return loadAllOutputs().find((o) => o.id === id) ?? null;
        },

        deleteOutput(id: string): boolean {
            const result = sqlite.prepare('DELETE FROM outputs WHERE id = ?').run(id);
            return result.changes > 0;
        },

        appendOutputLog(outputId: string, event: string, message: string): void {
            stmtInsertOutputLog.run(outputId, Date.now(), event, message);
            stmtPruneOutputLogs.run(outputId, outputId);
        },

        getOutputLogs(outputId: string, limit = LOG_RETENTION_LIMIT): OutputLog[] {
            return (stmtGetOutputLogs.all(outputId, limit) as Record<string, unknown>[]).map(
                (r) => ({
                    id: r.id as number,
                    outputId: r.output_id as string,
                    ts: r.ts as number,
                    event: r.event as string,
                    message: r.message as string,
                }),
            );
        },

        appendPipelineLog(pipelineId: number, event: string, message: string): void {
            stmtInsertPipelineLog.run(pipelineId, Date.now(), event, message);
            stmtPrunePipelineLogs.run(pipelineId, pipelineId);
        },

        getPipelineLogs(pipelineId: number, limit = LOG_RETENTION_LIMIT): PipelineLog[] {
            return (stmtGetPipelineLogs.all(pipelineId, limit) as Record<string, unknown>[]).map(
                (r) => ({
                    id: r.id as number,
                    pipelineId: r.pipeline_id as number,
                    ts: r.ts as number,
                    event: r.event as string,
                    message: r.message as string,
                }),
            );
        },

        createSession(token: string): void {
            stmtCreateSession.run(token, Date.now());
        },

        deleteSession(token: string): void {
            stmtDeleteSession.run(token);
        },

        listSessions(): string[] {
            return (stmtListSessions.all() as { token: string }[]).map((r) => r.token);
        },

        pruneExpiredSessions(maxAgeMs: number): void {
            stmtPruneExpiredSessions.run(Date.now() - maxAgeMs);
        },
    };
}
