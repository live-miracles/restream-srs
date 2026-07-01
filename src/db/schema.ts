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
    // one or more sinks. The primary (and almost always only) sink is stored
    // inline on this row; extra sinks for the rare multi-audio-remap case live
    // in output_sinks. The pull protocol isn't stored — it's derived at runtime
    // from how the input is currently published (SRT input -> SRT pull, RTMP
    // input -> RTMP pull).
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
            url             TEXT,
            audio_encoding  TEXT NOT NULL DEFAULT 'copy',
            last_error      TEXT,
            FOREIGN KEY(pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE
        )`,
    ).run();

    db.prepare(`CREATE INDEX IF NOT EXISTS idx_outputs_pipeline ON outputs(pipeline_id)`).run();

    // Extra sinks only — the primary sink (seq=1) is stored inline in outputs.url.
    // Populated only for the rare outputs that fan out to multiple destinations.
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
