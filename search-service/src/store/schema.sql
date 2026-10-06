-- Relational schema for the documentation search service.
-- Reference DDL (SQLite dialect; portable to Postgres with minor type changes).
-- The in-memory RelationalStore in memory-store.js mirrors these tables so the
-- service runs with zero external dependencies; production deployments point
-- the same repository interface at this schema.

PRAGMA foreign_keys = ON;

-- A logical document (page), identity stable across versions.
CREATE TABLE IF NOT EXISTS documents (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL,
  current_ver  TEXT,                       -- label of the current version
  created_at   INTEGER NOT NULL
);

-- A specific, IMMUTABLE version of a document. Published content is frozen;
-- visibility changes never mutate published bodies (they gate reachability).
CREATE TABLE IF NOT EXISTS document_versions (
  id            TEXT PRIMARY KEY,
  document_id   TEXT NOT NULL REFERENCES documents(id),
  version_label TEXT NOT NULL,            -- 'v1' | 'v2' | ...
  title         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft', -- draft|published
  created_at    INTEGER NOT NULL,
  UNIQUE(document_id, version_label)
);

-- A searchable chapter/section within a version. Bodies are immutable once the
-- version is published. anchor identifies the in-page section for deep links.
CREATE TABLE IF NOT EXISTS sections (
  id              TEXT PRIMARY KEY,
  version_id      TEXT NOT NULL REFERENCES document_versions(id),
  anchor          TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,          -- raw HTML/markdown
  ordinal         INTEGER NOT NULL,
  content_hash    TEXT NOT NULL,
  declared_fields TEXT NOT NULL DEFAULT '[]',  -- JSON [{name,start,end}] raw cp
  declared_apis   TEXT NOT NULL DEFAULT '[]',  -- JSON [{name,start,end}]
  declared_errors TEXT NOT NULL DEFAULT '[]',  -- JSON [{code,start,end}]
  UNIQUE(version_id, anchor)
);

-- Visibility / ACL. effective visibility per (principal, document).
-- kind: 'public' | 'group' | 'user' ; '*' principal = everyone.
CREATE TABLE IF NOT EXISTS visibility (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id  TEXT NOT NULL REFERENCES documents(id),
  principal_id TEXT NOT NULL,             -- '*' = anonymous/public
  allowed      INTEGER NOT NULL,          -- 1 allow, 0 deny (deny wins)
  updated_at   INTEGER NOT NULL,
  UNIQUE(document_id, principal_id)
);

-- Optional version-scoped override (e.g. v2 visible only to beta group).
CREATE TABLE IF NOT EXISTS version_visibility (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id   TEXT NOT NULL REFERENCES document_versions(id),
  principal_id TEXT NOT NULL,
  allowed      INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE(version_id, principal_id)
);

-- Index generations. Each generation is built fully BEFORE it is published;
-- the active pointer switches atomically.
CREATE TABLE IF NOT EXISTS index_generations (
  id           TEXT PRIMARY KEY,
  status       TEXT NOT NULL DEFAULT 'building', -- building|ready|active|retired
  scope        TEXT NOT NULL DEFAULT 'all',      -- 'all' | version label
  doc_count    INTEGER NOT NULL DEFAULT 0,
  section_count INTEGER NOT NULL DEFAULT 0,
  built_at     INTEGER,
  activated_at INTEGER,
  checkpoint   TEXT NOT NULL DEFAULT '{}'       -- resume cursor (JSON)
);

-- Which generation is currently serving per scope. Exactly one active/scope.
CREATE TABLE IF NOT EXISTS active_index (
  scope        TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL REFERENCES index_generations(id),
  switched_at  INTEGER NOT NULL
);

-- Postings snapshot used at index time (which sections were visible then).
CREATE TABLE IF NOT EXISTS index_sections (
  generation_id TEXT NOT NULL REFERENCES index_generations(id),
  section_id    TEXT NOT NULL REFERENCES sections(id),
  document_id   TEXT NOT NULL,
  version_id    TEXT NOT NULL,
  visible_snapshot INTEGER NOT NULL,
  PRIMARY KEY (generation_id, section_id)
);

-- Revocation log: immediate filter (served) + physical sweep (postings).
CREATE TABLE IF NOT EXISTS revocation_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  generation_id  TEXT NOT NULL,
  document_id    TEXT NOT NULL,
  action         TEXT NOT NULL,           -- revoke|restore
  filter_applied INTEGER NOT NULL,        -- immediate filter timestamp/flag
  swept_at       INTEGER,                 -- physical postings removed
  created_at     INTEGER NOT NULL
);
