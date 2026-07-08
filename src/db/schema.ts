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
    // one or more sinks, stored as a JSON array [{url, audioEncoding}] — sinks
    // are only ever read as part of their whole output, so they don't need their
    // own table. The pull protocol isn't stored — it's derived at runtime from
    // how the input is currently published (SRT input -> SRT pull, RTMP input ->
    // RTMP pull).
    // last_error stores the most recent ffmpeg failure as "<ts_ms>\n<message>".
    // Cleared when the user explicitly starts the output.
    db.prepare(
        `CREATE TABLE IF NOT EXISTS outputs (
            id              TEXT PRIMARY KEY,
            pipeline_id     INTEGER NOT NULL,
            seq             INTEGER NOT NULL,
            name            TEXT NOT NULL,
            desired_state   TEXT NOT NULL DEFAULT 'stopped',
            encoding        TEXT NOT NULL DEFAULT 'copy',
            sinks           TEXT NOT NULL DEFAULT '[]',
            last_error      TEXT,
            FOREIGN KEY(pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE
        )`,
    ).run();

    db.prepare(`CREATE INDEX IF NOT EXISTS idx_outputs_pipeline ON outputs(pipeline_id)`).run();

    db.prepare(
        `CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )`,
    ).run();

    db.prepare(
        `CREATE TABLE IF NOT EXISTS host_probe_targets (
            slot  INTEGER PRIMARY KEY,
            label TEXT NOT NULL,
            host  TEXT NOT NULL,
            port  INTEGER NOT NULL
        )`,
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

    db.prepare(
        `CREATE TABLE IF NOT EXISTS sessions (
            token      TEXT PRIMARY KEY,
            created_at INTEGER NOT NULL
        )`,
    ).run();
}
