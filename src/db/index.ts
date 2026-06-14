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

    const stmtGetPipeline = sqlite.prepare(`${PIPELINE_SELECT} WHERE p.id = ?`);
    const stmtGetOutput = sqlite.prepare('SELECT * FROM outputs WHERE id = ?');
    const stmtListSinks = sqlite.prepare(
        'SELECT seq, url, audio_encoding FROM output_sinks WHERE output_id = ? ORDER BY seq',
    );
    const stmtDeleteSinks = sqlite.prepare('DELETE FROM output_sinks WHERE output_id = ?');
    const stmtInsertSink = sqlite.prepare(
        'INSERT INTO output_sinks (id, output_id, seq, url, audio_encoding) VALUES (?, ?, ?, ?, ?)',
    );

    function sinksFor(outputId: string): OutputSink[] {
        return (stmtListSinks.all(outputId) as Record<string, unknown>[]).map((r) => ({
            seq: r.seq as number,
            url: r.url as string,
            audioEncoding: (r.audio_encoding as string) || 'copy',
        }));
    }

    function sinksForMany(outputIds: string[]): Map<string, OutputSink[]> {
        if (outputIds.length === 0) return new Map();
        const placeholders = outputIds.map(() => '?').join(',');
        const rows = sqlite
            .prepare(
                `SELECT output_id, seq, url, audio_encoding FROM output_sinks WHERE output_id IN (${placeholders}) ORDER BY output_id, seq`,
            )
            .all(...outputIds) as Record<string, unknown>[];
        const result = new Map<string, OutputSink[]>();
        for (const r of rows) {
            const id = r.output_id as string;
            if (!result.has(id)) result.set(id, []);
            result.get(id)!.push({
                seq: r.seq as number,
                url: r.url as string,
                audioEncoding: (r.audio_encoding as string) || 'copy',
            });
        }
        return result;
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

    function mapOutputFields(row: Record<string, unknown>) {
        return {
            id: row.id as string,
            pipelineId: row.pipeline_id as number,
            seq: row.seq as number,
            name: row.name as string,
            desiredState: row.desired_state as 'running' | 'stopped',
            videoEncoding: (row.encoding as string) || 'copy',
            pullMethod: (row.pull_method as PullMethod) || 'rtmp',
        };
    }

    function rowToOutput(row: Record<string, unknown>): Output {
        const base = mapOutputFields(row);
        return { ...base, sinks: sinksFor(base.id) };
    }

    function nextPipelineId(): number {
        const ids = new Set(
            (sqlite.prepare('SELECT id FROM pipelines').all() as { id: number }[]).map((r) => r.id),
        );
        let id = 1;
        while (ids.has(id)) id++;
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
                        `SELECT id, slot, key FROM stream_keys WHERE slot IS NOT NULL ORDER BY slot`,
                    )
                    .all() as Record<string, unknown>[]
            ).map(rowToStreamKey);
        },

        regenerateStreamKeys(): StreamKey[] {
            const rows = sqlite
                .prepare(`SELECT id, slot FROM stream_keys WHERE slot IS NOT NULL ORDER BY slot`)
                .all() as { id: number; slot: number }[];
            const doRegenerate = sqlite.transaction(() => {
                for (const row of rows) {
                    const newKey = `key${String(row.slot).padStart(2, '0')}_${crypto.randomBytes(16).toString('hex')}`;
                    sqlite
                        .prepare(`UPDATE stream_keys SET key = ? WHERE id = ?`)
                        .run(newKey, row.id);
                }
            });
            doRegenerate();
            return (
                sqlite
                    .prepare(
                        `SELECT id, slot, key FROM stream_keys WHERE slot IS NOT NULL ORDER BY slot`,
                    )
                    .all() as Record<string, unknown>[]
            ).map(rowToStreamKey);
        },

        createPipeline(): Pipeline {
            const id = nextPipelineId();
            const name = `Pipeline ${id}`;
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
                .run(id, name, keyRow.id);
            return rowToPipeline(stmtGetPipeline.get(id) as Record<string, unknown>);
        },

        getPipeline(id: number): Pipeline | undefined {
            const row = stmtGetPipeline.get(id) as Record<string, unknown> | undefined;
            return row ? rowToPipeline(row) : undefined;
        },

        listPipelines(): Pipeline[] {
            return (
                sqlite.prepare(`${PIPELINE_SELECT} ORDER BY p.id`).all() as Record<
                    string,
                    unknown
                >[]
            ).map(rowToPipeline);
        },

        updatePipeline(id: number, name: string, streamKeyId?: number): Pipeline | null {
            if (streamKeyId !== undefined) {
                sqlite
                    .prepare('UPDATE pipelines SET name = ?, stream_key_id = ? WHERE id = ?')
                    .run(name, streamKeyId, id);
            } else {
                sqlite.prepare('UPDATE pipelines SET name = ? WHERE id = ?').run(name, id);
            }
            const row = stmtGetPipeline.get(id) as Record<string, unknown> | undefined;
            return row ? rowToPipeline(row) : null;
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
            const create = sqlite.transaction(() => {
                sqlite
                    .prepare(
                        'INSERT INTO outputs (id, pipeline_id, seq, name, desired_state, encoding, pull_method) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    )
                    .run(id, pipelineId, seq, name, 'stopped', videoEncoding, pullMethod);
                insertSinks(id, sinks);
            });
            create();
            return rowToOutput(stmtGetOutput.get(id) as Record<string, unknown>);
        },

        getOutput(id: string): Output | undefined {
            const row = stmtGetOutput.get(id) as Record<string, unknown> | undefined;
            return row ? rowToOutput(row) : undefined;
        },

        listOutputs(): Output[] {
            const rows = sqlite
                .prepare('SELECT * FROM outputs ORDER BY pipeline_id, seq')
                .all() as Record<string, unknown>[];
            const sinksMap = sinksForMany(rows.map((r) => r.id as string));
            return rows.map((r) => ({
                ...mapOutputFields(r),
                sinks: sinksMap.get(r.id as string) ?? [],
            }));
        },

        listOutputsForPipeline(pipelineId: number): Output[] {
            const rows = sqlite
                .prepare('SELECT * FROM outputs WHERE pipeline_id = ? ORDER BY seq')
                .all(pipelineId) as Record<string, unknown>[];
            const sinksMap = sinksForMany(rows.map((r) => r.id as string));
            return rows.map((r) => ({
                ...mapOutputFields(r),
                sinks: sinksMap.get(r.id as string) ?? [],
            }));
        },

        updateOutput(id: string, { name, videoEncoding, pullMethod, sinks }): Output | null {
            const update = sqlite.transaction(() => {
                sqlite
                    .prepare(
                        'UPDATE outputs SET name = ?, encoding = ?, pull_method = ? WHERE id = ?',
                    )
                    .run(name, videoEncoding, pullMethod, id);
                stmtDeleteSinks.run(id);
                insertSinks(id, sinks);
            });
            update();
            const row = stmtGetOutput.get(id) as Record<string, unknown> | undefined;
            return row ? rowToOutput(row) : null;
        },

        setOutputDesiredState(id: string, desiredState: 'running' | 'stopped'): Output | null {
            sqlite
                .prepare('UPDATE outputs SET desired_state = ? WHERE id = ?')
                .run(desiredState, id);
            const row = stmtGetOutput.get(id) as Record<string, unknown> | undefined;
            return row ? rowToOutput(row) : null;
        },

        deleteOutput(id: string): boolean {
            const result = sqlite.prepare('DELETE FROM outputs WHERE id = ?').run(id);
            return result.changes > 0;
        },

        appendOutputLog(outputId: string, event: string, message: string): void {
            sqlite
                .prepare(
                    'INSERT INTO output_logs (output_id, ts, event, message) VALUES (?, ?, ?, ?)',
                )
                .run(outputId, Date.now(), event, message);
            // Keep at most 50 entries per output
            sqlite
                .prepare(
                    `DELETE FROM output_logs WHERE output_id = ? AND id NOT IN (
                        SELECT id FROM output_logs WHERE output_id = ? ORDER BY id DESC LIMIT ${LOG_RETENTION_LIMIT}
                    )`,
                )
                .run(outputId, outputId);
        },

        getOutputLogs(outputId: string, limit = LOG_RETENTION_LIMIT): OutputLog[] {
            return (
                sqlite
                    .prepare(
                        'SELECT id, output_id, ts, event, message FROM output_logs WHERE output_id = ? ORDER BY id DESC LIMIT ?',
                    )
                    .all(outputId, limit) as Record<string, unknown>[]
            ).map((r) => ({
                id: r.id as number,
                outputId: r.output_id as string,
                ts: r.ts as number,
                event: r.event as string,
                message: r.message as string,
            }));
        },

        appendPipelineLog(pipelineId: number, event: string, message: string): void {
            sqlite
                .prepare(
                    'INSERT INTO pipeline_logs (pipeline_id, ts, event, message) VALUES (?, ?, ?, ?)',
                )
                .run(pipelineId, Date.now(), event, message);
            sqlite
                .prepare(
                    `DELETE FROM pipeline_logs WHERE pipeline_id = ? AND id NOT IN (
                        SELECT id FROM pipeline_logs WHERE pipeline_id = ? ORDER BY id DESC LIMIT ${LOG_RETENTION_LIMIT}
                    )`,
                )
                .run(pipelineId, pipelineId);
        },

        getPipelineLogs(pipelineId: number, limit = LOG_RETENTION_LIMIT): PipelineLog[] {
            return (
                sqlite
                    .prepare(
                        'SELECT id, pipeline_id, ts, event, message FROM pipeline_logs WHERE pipeline_id = ? ORDER BY id DESC LIMIT ?',
                    )
                    .all(pipelineId, limit) as Record<string, unknown>[]
            ).map((r) => ({
                id: r.id as number,
                pipelineId: r.pipeline_id as number,
                ts: r.ts as number,
                event: r.event as string,
                message: r.message as string,
            }));
        },
    };
}
