CREATE TABLE workspace_state (
    id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
    json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
