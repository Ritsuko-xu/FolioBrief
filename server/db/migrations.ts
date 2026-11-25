/** Atomic versioned SQLite schema migrations (`user_version`) with pre-migration backup and busy retries. */
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import type { StructuredLogger } from '../utils/jsonParser.ts';

export const LATEST_SCHEMA_VERSION = 2;

export interface MigrationOptions {
  dbPath?: string;
  logger?: StructuredLogger;
}

/** Returns true when SQLite rejects an operation due to transient lock contention. */
function isBusySqliteError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
}

/** Synchronously pauses execution for `ms` milliseconds during lock retries. */
function sleepSync(ms: number): void {
  const buf = new SharedArrayBuffer(4);
  const view = new Int32Array(buf);
  Atomics.wait(view, 0, 0, ms);
}

/** Retries `fn` only on transient `SQLITE_BUSY`/`SQLITE_LOCKED` errors; DDL errors fail fast. */
function withBusyRetry<T>(fn: () => T, logger?: StructuredLogger, maxAttempts = 3): T {
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      return fn();
    } catch (err) {
      if (isBusySqliteError(err) && attempt < maxAttempts) {
        const delayMs = attempt * 150;
        logger?.warn('db', `SQLite busy during migration; retrying (${attempt}/${maxAttempts})`, {
          attempt,
          delayMs,
          error: err instanceof Error ? err.message : String(err),
        });
        sleepSync(delayMs);
        continue;
      }
      throw err;
    }
  }
}

/** Copies an existing DB file to `*.bak-v<N>` after truncating the WAL before upgrading. */
function createPreMigrationBackup(db: Database.Database, dbPath: string | undefined, fromVersion: number, logger?: StructuredLogger): void {
  if (!dbPath || dbPath === ':memory:' || fromVersion <= 0) return;
  const backupPath = `${dbPath}.bak-v${fromVersion}`;
  try {
    if (fs.existsSync(dbPath) && !fs.existsSync(backupPath)) {
      db.pragma('wal_checkpoint(TRUNCATE)');
      fs.copyFileSync(dbPath, backupPath);
      logger?.info?.('db', `Created pre-migration database backup before upgrading from v${fromVersion}`, {
        fromVersion,
        backupPath,
      });
    }
  } catch (err) {
    logger?.warn('db', `Pre-migration backup skipped due to filesystem error`, {
      fromVersion,
      backupPath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Runs versioned, transactional SQLite schema migrations up to `LATEST_SCHEMA_VERSION`. */
export function runMigrations(db: Database.Database, options: MigrationOptions = {}): void {
  const { dbPath, logger } = options;
  const currentVersion = Number(db.pragma('user_version', { simple: true }) ?? 0);

  if (currentVersion >= LATEST_SCHEMA_VERSION) {
    return;
  }

  createPreMigrationBackup(db, dbPath, currentVersion, logger);

  const migrateV1 = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_url TEXT,
        source_domain TEXT,
        source_pdf_path TEXT,
        job_status TEXT NOT NULL DEFAULT 'queued',
        error_message TEXT,
        extracted_text TEXT NOT NULL DEFAULT '',
        page_index_json TEXT NOT NULL DEFAULT '[]',
        page_count INTEGER NOT NULL DEFAULT 0,
        embedding_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS analysis_versions (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        version_number INTEGER NOT NULL,
        summary TEXT NOT NULL,
        key_insights_json TEXT NOT NULL,
        improvements_json TEXT NOT NULL,
        open_questions_json TEXT NOT NULL,
        highlights_json TEXT NOT NULL,
        brief_pdf_path TEXT,
        annotated_pdf_path TEXT,
        annotated_pdf_dirty INTEGER NOT NULL DEFAULT 1,
        revision_reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(document_id, version_number)
      );

      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        referenced_highlight_ids_json TEXT NOT NULL DEFAULT '[]',
        applied_version_number INTEGER,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tool_traces (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        chat_message_id TEXT REFERENCES chat_messages(id) ON DELETE SET NULL,
        model TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        raw_args_json TEXT NOT NULL,
        status TEXT NOT NULL,
        result_summary TEXT NOT NULL,
        before_version INTEGER,
        after_version INTEGER,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_profiles (
        id TEXT PRIMARY KEY,
        preference_key TEXT UNIQUE NOT NULL,
        learned_rule TEXT NOT NULL,
        source_evidence TEXT NOT NULL DEFAULT '',
        confidence REAL NOT NULL DEFAULT 0.8,
        updated_at TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
        document_id UNINDEXED,
        title,
        extracted_text
      );

      CREATE INDEX IF NOT EXISTS idx_versions_doc ON analysis_versions(document_id, version_number DESC);
      CREATE INDEX IF NOT EXISTS idx_chat_doc ON chat_messages(document_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_traces_doc ON tool_traces(document_id, created_at DESC);
    `);
    db.pragma('user_version = 1');
  });

  const migrateV2 = db.transaction(() => {
    const columns = db.pragma('table_info(documents)') as Array<{ name: string }>;
    if (!columns.some((col) => col.name === 'content_hash')) {
      db.exec(`ALTER TABLE documents ADD COLUMN content_hash TEXT;`);
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_documents_content_hash ON documents(content_hash);
      CREATE INDEX IF NOT EXISTS idx_documents_source_url ON documents(source_url);
    `);
    db.pragma('user_version = 2');
  });

  try {
    if (currentVersion < 1) {
      withBusyRetry(() => migrateV1(), logger);
    }

    const versionAfterV1 = Number(db.pragma('user_version', { simple: true }) ?? 0);
    if (versionAfterV1 < 2) {
      withBusyRetry(() => migrateV2(), logger);
    }
  } catch (err) {
    logger?.error?.('db', 'Database migration failed', {
      currentVersion,
      targetVersion: LATEST_SCHEMA_VERSION,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
