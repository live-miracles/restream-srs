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

    // Migration: add slot column if the table existed without it
    const skCols = (db.prepare(`PRAGMA table_info(stream_keys)`).all() as { name: string }[]).map(
        (c) => c.name,
    );
    if (!skCols.includes('slot')) {
        db.prepare(`ALTER TABLE stream_keys ADD COLUMN slot INTEGER`).run();
    }

    db.prepare(
        `CREATE TABLE IF NOT EXISTS pipelines (
            id            INTEGER PRIMARY KEY,
            name          TEXT NOT NULL,
            stream_key_id INTEGER REFERENCES stream_keys(id)
        )`,
    ).run();

    // Migration: add stream_key_id if the table existed with the old schema
    const pipelineCols = (
        db.prepare(`PRAGMA table_info(pipelines)`).all() as { name: string }[]
    ).map((c) => c.name);
    if (!pipelineCols.includes('stream_key_id')) {
        db.prepare(
            `ALTER TABLE pipelines ADD COLUMN stream_key_id INTEGER REFERENCES stream_keys(id)`,
        ).run();
    }

    // Migration: move old stream_key text values into stream_keys table
    if (pipelineCols.includes('stream_key')) {
        const toMigrate = db
            .prepare(
                `SELECT id, stream_key FROM pipelines WHERE stream_key != '' AND stream_key_id IS NULL`,
            )
            .all() as { id: number; stream_key: string }[];
        for (const row of toMigrate) {
            db.prepare(`INSERT OR IGNORE INTO stream_keys (key) VALUES (?)`).run(row.stream_key);
            const keyRow = db
                .prepare(`SELECT id FROM stream_keys WHERE key = ?`)
                .get(row.stream_key) as { id: number };
            db.prepare(`UPDATE pipelines SET stream_key_id = ? WHERE id = ?`).run(
                keyRow.id,
                row.id,
            );
        }
    }

    db.prepare(
        `CREATE TABLE IF NOT EXISTS outputs (
            id            TEXT PRIMARY KEY,
            pipeline_id   INTEGER NOT NULL,
            seq           INTEGER NOT NULL,
            name          TEXT NOT NULL,
            url           TEXT NOT NULL,
            desired_state TEXT NOT NULL DEFAULT 'stopped',
            encoding      TEXT NOT NULL DEFAULT 'source',
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
}
