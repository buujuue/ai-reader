CREATE TABLE materials (
    id TEXT PRIMARY KEY NOT NULL,
    status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready')),
    fingerprint TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    author TEXT,
    language TEXT,
    source_file_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
