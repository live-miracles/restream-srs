import BetterSqlite3 from 'better-sqlite3';
import crypto from 'crypto';
import path from 'path';
import { setupDatabaseSchema } from './schema.js';
import type {
    Pipeline,
    Output,
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
const PIPELINE_LOG_CAP = 100;
const LOG_RETENTION_LIMIT = 100;

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
    // WAL mode not enabled: better-sqlite3 is synchronous with a single connection, so all
    // reads and writes are already serialized by the JS event loop — no concurrency benefit.
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
    // The dataset is small (~30 pipelines / 300+ outputs) so full-table reads
    // are cheaper and simpler than maintaining targeted per-entity queries.
    const stmtLoadPipelines = sqlite.prepare(`${PIPELINE_SELECT} ORDER BY p.id`);
    const stmtLoadOutputs = sqlite.prepare('SELECT * FROM outputs ORDER BY pipeline_id, seq');
    // Lightweight id/pipeline map for the 5s health poll — avoids loading every
    // output row just to group output ids by pipeline.
    const stmtLoadOutputIds = sqlite.prepare(
        'SELECT id, pipeline_id, last_error FROM outputs ORDER BY pipeline_id, seq',
    );
    // Extra sinks only — primary sink (seq=1) is inlined on the outputs row.
    const stmtLoadExtraSinks = sqlite.prepare(
        'SELECT output_id, seq, url, audio_encoding FROM output_sinks ORDER BY output_id, seq',
    );
    // Targeted single-row lookups for the hot retry / process-exit paths.
    const stmtGetPipeline = sqlite.prepare(`${PIPELINE_SELECT} WHERE p.id = ?`);
    const stmtGetOutput = sqlite.prepare('SELECT * FROM outputs WHERE id = ?');
    const stmtGetExtraSinksByOutput = sqlite.prepare(
        'SELECT seq, url, audio_encoding FROM output_sinks WHERE output_id = ? ORDER BY seq',
    );
    // Targeted per-pipeline lookups — avoids full-table scans in the hot restart
    // path where restartPipelineOutputs is called once per reconnecting pipeline.
    const stmtGetOutputsByPipeline = sqlite.prepare(
        'SELECT * FROM outputs WHERE pipeline_id = ? ORDER BY seq',
    );
    const stmtGetExtraSinksByPipeline = sqlite.prepare(
        `SELECT os.output_id, os.seq, os.url, os.audio_encoding
         FROM output_sinks os
         JOIN outputs o ON os.output_id = o.id
         WHERE o.pipeline_id = ?
         ORDER BY os.output_id, os.seq`,
    );
    const stmtListStreamKeys = sqlite.prepare(
        'SELECT id, slot, key FROM stream_keys WHERE slot IS NOT NULL ORDER BY slot',
    );
    const stmtListStreamKeySlots = sqlite.prepare(
        'SELECT id, slot FROM stream_keys WHERE slot IS NOT NULL ORDER BY slot',
    );
    const stmtGetSetting = sqlite.prepare('SELECT value FROM settings WHERE key = ?');
    const stmtSetSetting = sqlite.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );

    // Write prepared statements
    const stmtUpdateInlineSink = sqlite.prepare(
        'UPDATE outputs SET url = ?, audio_encoding = ? WHERE id = ?',
    );
    const stmtDeleteExtraSinks = sqlite.prepare('DELETE FROM output_sinks WHERE output_id = ?');
    const stmtUpdateStreamKey = sqlite.prepare('UPDATE stream_keys SET key = ? WHERE id = ?');
    const stmtInsertSink = sqlite.prepare(
        'INSERT INTO output_sinks (id, output_id, seq, url, audio_encoding) VALUES (?, ?, ?, ?, ?)',
    );
    const stmtSetLastError = sqlite.prepare('UPDATE outputs SET last_error = ? WHERE id = ?');
    const stmtClearLastError = sqlite.prepare('UPDATE outputs SET last_error = NULL WHERE id = ?');
    const stmtInsertPipelineLog = sqlite.prepare(
        'INSERT INTO pipeline_logs (pipeline_id, ts, event, message) VALUES (?, ?, ?, ?)',
    );
    const stmtPrunePipelineLogs = sqlite.prepare(
        `DELETE FROM pipeline_logs WHERE pipeline_id = ? AND id NOT IN (
            SELECT id FROM pipeline_logs WHERE pipeline_id = ? ORDER BY id DESC LIMIT ${PIPELINE_LOG_CAP}
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

    function getOutputsByPipeline(pipelineId: number): Output[] {
        const outputRows = stmtGetOutputsByPipeline.all(pipelineId) as Record<string, unknown>[];
        if (outputRows.length === 0) return [];
        const extraSinkRows = stmtGetExtraSinksByPipeline.all(pipelineId) as Record<
            string,
            unknown
        >[];
        const extraSinksMap = new Map<string, Record<string, unknown>[]>();
        for (const r of extraSinkRows) {
            const id = r.output_id as string;
            if (!extraSinksMap.has(id)) extraSinksMap.set(id, []);
            extraSinksMap.get(id)!.push(r);
        }
        return outputRows.map((row) => rowToOutput(row, extraSinksMap.get(row.id as string) ?? []));
    }

    function loadAllOutputs(): Output[] {
        const outputRows = stmtLoadOutputs.all() as Record<string, unknown>[];
        const extraSinkRows = stmtLoadExtraSinks.all() as Record<string, unknown>[];

        const extraSinksMap = new Map<string, Record<string, unknown>[]>();
        for (const r of extraSinkRows) {
            const id = r.output_id as string;
            if (!extraSinksMap.has(id)) extraSinksMap.set(id, []);
            extraSinksMap.get(id)!.push(r);
        }

        return outputRows.map((row) => rowToOutput(row, extraSinksMap.get(row.id as string) ?? []));
    }

    // Builds an Output from an outputs row plus any extra sink rows (seq >= 2).
    // The primary sink (seq=1) is stored inline on the outputs row itself.
    function rowToOutput(
        row: Record<string, unknown>,
        extraSinkRows: Record<string, unknown>[],
    ): Output {
        const id = row.id as string;
        const sinks: OutputSink[] = [];
        if (row.url) {
            sinks.push({
                seq: 1,
                url: row.url as string,
                audioEncoding: (row.audio_encoding as string) || 'copy',
            });
        }
        for (const r of extraSinkRows) {
            sinks.push({
                seq: r.seq as number,
                url: r.url as string,
                audioEncoding: (r.audio_encoding as string) || 'copy',
            });
        }
        return {
            id,
            pipelineId: row.pipeline_id as number,
            seq: row.seq as number,
            name: row.name as string,
            desiredState: row.desired_state as 'running' | 'stopped',
            videoEncoding: (row.encoding as string) || 'copy',
            pullMethod: (row.pull_method as PullMethod) || 'rtmp',
            sinks,
            lastError: (row.last_error as string | null) ?? null,
        };
    }

    function getOutputById(id: string): Output | null {
        const row = stmtGetOutput.get(id) as Record<string, unknown> | undefined;
        if (!row) return null;
        const extraSinkRows = stmtGetExtraSinksByOutput.all(id) as Record<string, unknown>[];
        return rowToOutput(row, extraSinkRows);
    }

    // First sink goes inline on the outputs row; any extras (seq >= 2) go to output_sinks.
    function insertSinks(outputId: string, sinks: SinkInput[]): void {
        if (sinks.length > 0) {
            stmtUpdateInlineSink.run(sinks[0].url, sinks[0].audioEncoding ?? 'copy', outputId);
        }
        sinks.slice(1).forEach((s, i) => {
            const seq = i + 2;
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
        // Deliberately fills gaps: if existing IDs are [1, 2, 4, 5] the next
        // pipeline gets id=3, not 6. Pipelines are deleted and recreated often
        // enough that leaving permanent holes would exhaust readable slot names.
        const existing = loadAllPipelines();
        let id = 1;
        while (existing.some((p) => p.id === id)) id++;
        return id;
    }

    return {
        getSetting(key: string): string | null {
            const row = stmtGetSetting.get(key) as { value: string } | undefined;
            return row?.value ?? null;
        },

        setSetting(key: string, value: string): void {
            stmtSetSetting.run(key, value);
        },

        listStreamKeys(): StreamKey[] {
            return (stmtListStreamKeys.all() as Record<string, unknown>[]).map(rowToStreamKey);
        },

        regenerateStreamKeys(): StreamKey[] {
            const rows = stmtListStreamKeySlots.all() as { id: number; slot: number }[];
            sqlite.transaction(() => {
                for (const row of rows) {
                    const newKey = `key${String(row.slot).padStart(2, '0')}_${crypto.randomBytes(16).toString('hex')}`;
                    stmtUpdateStreamKey.run(newKey, row.id);
                }
            })();
            return (stmtListStreamKeys.all() as Record<string, unknown>[]).map(rowToStreamKey);
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
            return rowToPipeline(stmtGetPipeline.get(id) as Record<string, unknown>);
        },

        getPipeline(id: number): Pipeline | undefined {
            const row = stmtGetPipeline.get(id) as Record<string, unknown> | undefined;
            return row ? rowToPipeline(row) : undefined;
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
            sqlite.transaction(() => {
                sqlite
                    .prepare(
                        'INSERT INTO outputs (id, pipeline_id, seq, name, desired_state, encoding, pull_method) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    )
                    .run(id, pipelineId, seq, name, 'stopped', videoEncoding, pullMethod);
                insertSinks(id, sinks);
            })();
            return getOutputById(id)!;
        },

        getOutput(id: string): Output | null {
            return getOutputById(id);
        },

        listOutputs(): Output[] {
            return loadAllOutputs();
        },

        listOutputIds(): { id: string; pipelineId: number; lastError: string | null }[] {
            return (stmtLoadOutputIds.all() as Record<string, unknown>[]).map((r) => ({
                id: r.id as string,
                pipelineId: r.pipeline_id as number,
                lastError: (r.last_error as string | null) ?? null,
            }));
        },

        listOutputsForPipeline(pipelineId: number): Output[] {
            return getOutputsByPipeline(pipelineId);
        },

        updateOutput(id: string, { name, videoEncoding, pullMethod, sinks }): Output | null {
            sqlite.transaction(() => {
                sqlite
                    .prepare(
                        'UPDATE outputs SET name = ?, encoding = ?, pull_method = ? WHERE id = ?',
                    )
                    .run(name, videoEncoding, pullMethod, id);
                stmtDeleteExtraSinks.run(id);
                insertSinks(id, sinks);
            })();
            return getOutputById(id);
        },

        setOutputDesiredState(id: string, desiredState: 'running' | 'stopped'): Output | null {
            sqlite
                .prepare('UPDATE outputs SET desired_state = ? WHERE id = ?')
                .run(desiredState, id);
            return getOutputById(id);
        },

        deleteOutput(id: string): boolean {
            const result = sqlite.prepare('DELETE FROM outputs WHERE id = ?').run(id);
            return result.changes > 0;
        },

        setOutputLastError(id: string, message: string): void {
            stmtSetLastError.run(`${Date.now()}\n${message}`, id);
        },

        clearOutputLastError(id: string): void {
            stmtClearLastError.run(id);
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
