import BetterSqlite3 from 'better-sqlite3';
import crypto from 'crypto';
import path from 'path';
import { setupDatabaseSchema } from './schema.js';
import type { Pipeline, Output, StreamKey, Db } from '../types.js';

const PIPELINE_SELECT = `
    SELECT p.id, p.name, p.stream_key_id, COALESCE(sk.key, '') as stream_key
    FROM pipelines p
    LEFT JOIN stream_keys sk ON sk.id = p.stream_key_id
`;

const STREAM_KEY_SLOTS = 99;

function rowToPipeline(row: Record<string, unknown>): Pipeline {
    return {
        id: row.id as number,
        name: row.name as string,
        streamKey: row.stream_key as string,
        streamKeyId: row.stream_key_id as number,
    };
}

function rowToOutput(row: Record<string, unknown>): Output {
    return {
        id: row.id as string,
        pipelineId: row.pipeline_id as number,
        seq: row.seq as number,
        name: row.name as string,
        url: row.url as string,
        desiredState: row.desired_state as 'running' | 'stopped',
        encoding: row.encoding as string,
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
            return rowToPipeline(
                sqlite.prepare(`${PIPELINE_SELECT} WHERE p.id = ?`).get(id) as Record<
                    string,
                    unknown
                >,
            );
        },

        getPipeline(id: number): Pipeline | undefined {
            const row = sqlite.prepare(`${PIPELINE_SELECT} WHERE p.id = ?`).get(id) as
                | Record<string, unknown>
                | undefined;
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
            const row = sqlite.prepare(`${PIPELINE_SELECT} WHERE p.id = ?`).get(id) as
                | Record<string, unknown>
                | undefined;
            return row ? rowToPipeline(row) : null;
        },

        deletePipeline(id: number): boolean {
            const result = sqlite.prepare('DELETE FROM pipelines WHERE id = ?').run(id);
            return result.changes > 0;
        },

        createOutput({ pipelineId, name, url, encoding = 'source' }): Output {
            const seqRow = sqlite
                .prepare(
                    'SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM outputs WHERE pipeline_id = ?',
                )
                .get(pipelineId) as { next_seq: number };
            const seq = seqRow.next_seq;
            const id = `${pipelineId}-${seq}`;
            sqlite
                .prepare(
                    'INSERT INTO outputs (id, pipeline_id, seq, name, url, desired_state, encoding) VALUES (?, ?, ?, ?, ?, ?, ?)',
                )
                .run(id, pipelineId, seq, name, url, 'stopped', encoding);
            return rowToOutput(
                sqlite.prepare('SELECT * FROM outputs WHERE id = ?').get(id) as Record<
                    string,
                    unknown
                >,
            );
        },

        getOutput(id: string): Output | undefined {
            const row = sqlite.prepare('SELECT * FROM outputs WHERE id = ?').get(id) as
                | Record<string, unknown>
                | undefined;
            return row ? rowToOutput(row) : undefined;
        },

        listOutputs(): Output[] {
            return (
                sqlite.prepare('SELECT * FROM outputs ORDER BY pipeline_id, seq').all() as Record<
                    string,
                    unknown
                >[]
            ).map(rowToOutput);
        },

        listOutputsForPipeline(pipelineId: number): Output[] {
            return (
                sqlite
                    .prepare('SELECT * FROM outputs WHERE pipeline_id = ? ORDER BY seq')
                    .all(pipelineId) as Record<string, unknown>[]
            ).map(rowToOutput);
        },

        updateOutput(id: string, { name, url, encoding }): Output | null {
            sqlite
                .prepare('UPDATE outputs SET name = ?, url = ?, encoding = ? WHERE id = ?')
                .run(name, url, encoding, id);
            const row = sqlite.prepare('SELECT * FROM outputs WHERE id = ?').get(id) as
                | Record<string, unknown>
                | undefined;
            return row ? rowToOutput(row) : null;
        },

        setOutputDesiredState(id: string, desiredState: 'running' | 'stopped'): Output | null {
            sqlite
                .prepare('UPDATE outputs SET desired_state = ? WHERE id = ?')
                .run(desiredState, id);
            const row = sqlite.prepare('SELECT * FROM outputs WHERE id = ?').get(id) as
                | Record<string, unknown>
                | undefined;
            return row ? rowToOutput(row) : null;
        },

        deleteOutput(id: string): boolean {
            const result = sqlite.prepare('DELETE FROM outputs WHERE id = ?').run(id);
            return result.changes > 0;
        },
    };
}
