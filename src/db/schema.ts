import type Database from 'better-sqlite3';

export function setupDatabaseSchema(db: Database.Database): void {
    db.pragma('foreign_keys = ON');

    db.prepare(
        `CREATE TABLE IF NOT EXISTS stream_keys (
            id   INTEGER PRIMARY KEY AUTOINCREMENT,
            slot INTEGER UNIQUE,
            key  TEXT UNIQUE NOT NULL
        )`,
    ).run();

    db.prepare(
        `CREATE TABLE IF NOT EXISTS pipelines (
            id            INTEGER PRIMARY KEY,
            name          TEXT NOT NULL,
            stream_key_id INTEGER REFERENCES stream_keys(id)
        )`,
    ).run();

    // One output = one ffmpeg process that pulls the input once and fans out to
    // one or more sinks (output_sinks). pull_method selects how that single input
    // is pulled from SRS (rtmp collapses to one audio track; srt preserves all).
    db.prepare(
        `CREATE TABLE IF NOT EXISTS outputs (
            id              TEXT PRIMARY KEY,
            pipeline_id     INTEGER NOT NULL,
            seq             INTEGER NOT NULL,
            name            TEXT NOT NULL,
            desired_state   TEXT NOT NULL DEFAULT 'stopped',
            encoding        TEXT NOT NULL DEFAULT 'copy',
            pull_method     TEXT NOT NULL DEFAULT 'rtmp',
            FOREIGN KEY(pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE
        )`,
    ).run();

    db.prepare(`CREATE INDEX IF NOT EXISTS idx_outputs_pipeline ON outputs(pipeline_id)`).run();

    // Each sink is a single destination URL with its own audio track selection.
    db.prepare(
        `CREATE TABLE IF NOT EXISTS output_sinks (
            id              TEXT PRIMARY KEY,
            output_id       TEXT NOT NULL,
            seq             INTEGER NOT NULL,
            url             TEXT NOT NULL,
            audio_encoding  TEXT NOT NULL DEFAULT 'copy',
            FOREIGN KEY(output_id) REFERENCES outputs(id) ON DELETE CASCADE
        )`,
    ).run();

    db.prepare(
        `CREATE INDEX IF NOT EXISTS idx_output_sinks_output ON output_sinks(output_id)`,
    ).run();

    db.prepare(
        `CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )`,
    ).run();

    db.prepare(
        `CREATE TABLE IF NOT EXISTS output_logs (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            output_id TEXT NOT NULL,
            ts        INTEGER NOT NULL,
            event     TEXT NOT NULL,
            message   TEXT NOT NULL,
            FOREIGN KEY(output_id) REFERENCES outputs(id) ON DELETE CASCADE
        )`,
    ).run();

    db.prepare(
        `CREATE INDEX IF NOT EXISTS idx_output_logs_output ON output_logs(output_id, id DESC)`,
    ).run();

    db.prepare(
        `CREATE TABLE IF NOT EXISTS pipeline_logs (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            pipeline_id INTEGER NOT NULL,
            ts          INTEGER NOT NULL,
            event       TEXT NOT NULL,
            message     TEXT NOT NULL,
            FOREIGN KEY(pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE
        )`,
    ).run();

    db.prepare(
        `CREATE INDEX IF NOT EXISTS idx_pipeline_logs_pipeline ON pipeline_logs(pipeline_id, id DESC)`,
    ).run();
}
