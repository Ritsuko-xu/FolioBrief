/** SQLite WAL initialization, schema migrations, FTS5 search, versioning, and repository persistence tests. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FolioDatabase } from '../../server/db.ts';
import { LATEST_SCHEMA_VERSION, runMigrations } from '../../server/db/migrations.ts';
import { FileStorageManager } from '../../server/storage.ts';
import { AppLogger } from '../../server/logger.ts';
import type { AnalysisPayload } from '../../src/shared/types.ts';

describe('SQLite Database, Migrations, Versioning & FTS5 Repositories', () => {
  let tmpDir: string;
  let db: FolioDatabase;
  let storage: FileStorageManager;
  let logger: AppLogger;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foliobrief-g1-'));
    storage = new FileStorageManager(tmpDir);
    logger = new AppLogger(storage.logsDir);
    db = new FolioDatabase(path.join(tmpDir, 'foliobrief.db'), logger);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('initializes SQLite in WAL mode and passes integrity check', () => {
    const health = db.getHealthInfo();
    expect(health.sqliteWalMode.toLowerCase()).toBe('wal');
    expect(health.sqliteIntegrity.toLowerCase()).toBe('ok');
    expect(Number(db.db.pragma('user_version', { simple: true }))).toBe(LATEST_SCHEMA_VERSION);
  });

  it('recovers cleanly from a half-applied v2 migration and creates a pre-migration backup', () => {
    const legacyPath = path.join(tmpDir, 'legacy-partial-v2.db');
    const raw = new Database(legacyPath);
    raw.exec(`
      CREATE TABLE documents (
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
      -- Simulate ALTER TABLE succeeding before CREATE INDEX failed & before user_version bumped
      ALTER TABLE documents ADD COLUMN content_hash TEXT;
    `);
    raw.pragma('user_version = 1');
    raw.close();

    const migrated = new FolioDatabase(legacyPath, logger);
    try {
      expect(Number(migrated.db.pragma('user_version', { simple: true }))).toBe(2);
      const indexes = migrated.db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'documents'`)
        .all() as Array<{ name: string }>;
      const indexNames = indexes.map((i) => i.name);
      expect(indexNames).toContain('idx_documents_content_hash');
      expect(indexNames).toContain('idx_documents_source_url');
      expect(fs.existsSync(`${legacyPath}.bak-v1`)).toBe(true);
    } finally {
      migrated.close();
    }
  });

  it('keeps schema version unchanged and logs an error if a migration fails', () => {
    const brokenRaw = new Database(':memory:');
    brokenRaw.pragma('user_version = 1'); // Pretend v1 completed, but documents table is absent
    expect(() => runMigrations(brokenRaw, { logger })).toThrow();
    expect(Number(brokenRaw.pragma('user_version', { simple: true }))).toBe(1);
    const errors = logger.getRecentLogs(10).filter((l) => l.level === 'error' && l.module === 'db');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    brokenRaw.close();
  });

  it('rolls back earlier tables atomically when a later independent table fails during v1 migration', () => {
    const raw = new Database(':memory:');
    // Pre-create an FTS5 shadow table so documents..memory_profiles succeed first, then documents_fts fails mid-transaction
    raw.exec(`CREATE TABLE documents_fts_data (id INTEGER PRIMARY KEY);`);

    expect(() => runMigrations(raw, { logger })).toThrow();
    expect(Number(raw.pragma('user_version', { simple: true }))).toBe(0);

    const tables = raw
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).not.toContain('documents');
    expect(tableNames).not.toContain('analysis_versions');
    expect(tableNames).not.toContain('chat_messages');
    expect(tableNames).not.toContain('tool_traces');
    expect(tableNames).not.toContain('memory_profiles');
    expect(tableNames).not.toContain('documents_fts');
    expect(tableNames).toEqual(['documents_fts_data']);
    raw.close();
  });

  it('handles out-of-range reverts, missing document IDs, invalid patches, and FTS special characters safely', () => {
    const doc = db.createDocument({
      title: 'Quoted "Raft" Consensus*',
      sourceType: 'text',
      jobStatus: 'ready',
      extractedText: 'Raft leader election and log replication under network partitions.',
    });
    db.createAnalysisVersion({
      documentId: doc.id,
      payload: {
        summary: 'Summary v1',
        keyInsights: ['K1'],
        improvements: [],
        openQuestions: [],
        highlights: [],
      },
      revisionReason: 'Initial',
    });

    expect(db.revertToVersion(doc.id, 999)).toBeNull();
    expect(db.revertToVersion('missing-doc-id', 1)).toBeNull();
    expect(db.getDocumentById('missing-doc-id')).toBeNull();
    expect(db.updateDocument('missing-doc-id', { title: 'Nope' })).toBeNull();
    expect(db.deleteDocument('missing-doc-id')).toBe(false);

    expect(() =>
      db.updateDocument(doc.id, { pageIndex: 'bad-shape' as unknown as [] })
    ).toThrow('pageIndex must be an array');
    expect(() =>
      db.updateDocument(doc.id, { embeddingVector: [0.1, Number.NaN] })
    ).toThrow('embeddingVector must be null or finite number[]');

    expect(db.searchDocumentsFts('')).toEqual([]);
    expect(db.searchDocumentsFts('a')).toEqual([]);
    expect(() => db.searchDocumentsFts('Raft "OR" * !!!')).not.toThrow();
    expect(() => db.listDocuments('Raft "quoted" * OR')).not.toThrow();
    expect(db.listDocuments('Raft').length).toBe(1);
  });

  it('recovers stale in-flight jobs as interrupted on startup', () => {
    const doc1 = db.createDocument({
      title: 'Crashed Paper',
      sourceType: 'pdf',
      jobStatus: 'synthesizing',
    });
    const doc2 = db.createDocument({
      title: 'Completed Paper',
      sourceType: 'url',
      sourceUrl: 'https://example.com/post',
      jobStatus: 'ready',
    });

    const recovered = db.recoverInterruptedJobs();
    expect(recovered).toBe(1);
    expect(db.getDocumentById(doc1.id)?.jobStatus).toBe('interrupted');
    expect(db.getDocumentById(doc2.id)?.jobStatus).toBe('ready');
  });

  it('supports append-only AnalysisVersions, rollback, FTS5 search, and MemoryProfile', () => {
    const doc = db.createDocument({
      title: 'Speculative Decoding Survey',
      sourceType: 'pdf',
      jobStatus: 'ready',
      extractedText: 'Speculative decoding accelerates autoregressive transformer inference using draft models.',
    });

    const v1 = db.createAnalysisVersion({
      documentId: doc.id,
      payload: {
        summary: 'Initial summary',
        keyInsights: ['Draft models reduce memory bandwidth bottlenecks'],
        improvements: ['2.4x speedup without quality loss'],
        openQuestions: ['How does tree attention scale?'],
        highlights: [
          {
            id: 'h1',
            page: 1,
            quoteAnchor: 'accelerates autoregressive transformer inference',
            category: 'claim',
            comment: 'Core thesis',
          },
        ],
      },
      revisionReason: 'Initial AI synthesis',
    });
    expect(v1.versionNumber).toBe(1);

    const v2 = db.createAnalysisVersion({
      documentId: doc.id,
      payload: {
        summary: 'Revised latency-focused summary',
        keyInsights: v1.keyInsights,
        improvements: v1.improvements,
        openQuestions: ['What is the batch-size crossover point?'],
        highlights: v1.highlights,
      },
      revisionReason: 'User requested latency focus',
    });
    expect(v2.versionNumber).toBe(2);

    const v3 = db.revertToVersion(doc.id, 1);
    expect(v3?.versionNumber).toBe(3);
    expect(v3?.summary).toBe('Initial summary');

    const matches = db.searchDocumentsFts('speculative transformer');
    expect(matches.length).toBe(1);
    expect(matches[0].id).toBe(doc.id);

    const pref = db.upsertMemoryPreference({
      preferenceKey: 'focus_area',
      learnedRule: 'Emphasize systems latency and memory bandwidth trade-offs.',
    });
    expect(pref.preferenceKey).toBe('focus_area');
    expect(db.listMemoryPreferences().length).toBe(1);
  });

  it('handles empty, malformed, and wrong-shape JSON rows gracefully on read while validating writes', () => {
    const docOk = db.createDocument({
      title: 'Healthy Doc',
      sourceType: 'text',
      jobStatus: 'ready',
    });
    db.updateDocument(docOk.id, { embeddingVector: [0.5, 0.5] });

    const docCorrupt = db.createDocument({
      title: 'Corrupted JSON Doc',
      sourceType: 'text',
      jobStatus: 'ready',
    });
    const ver = db.createAnalysisVersion({
      documentId: docCorrupt.id,
      payload: {
        summary: 'Summary survives',
        keyInsights: ['Valid'],
        improvements: ['Valid'],
        openQuestions: ['Valid'],
        highlights: [],
      },
      revisionReason: 'Seed',
    });
    const msg = db.addChatMessage({
      documentId: docCorrupt.id,
      role: 'user',
      content: 'Check highlights',
      referencedHighlightIds: ['h1'],
    });

    // Inject empty string, malformed JSON, wrong runtime shapes (null / {}), and mixed array items
    db.db
      .prepare(`UPDATE documents SET page_index_json = '', embedding_json = '' WHERE id = ?`)
      .run(docCorrupt.id);
    db.db
      .prepare(
        `UPDATE analysis_versions
         SET key_insights_json = '{bad-json',
             improvements_json = '{}',
             open_questions_json = 'null',
             highlights_json = ?
         WHERE id = ?`
      )
      .run(
        JSON.stringify([
          null,
          'invalid-string',
          { id: 'h-valid', page: 1, quoteAnchor: 'quote', category: 'claim', comment: 'valid' },
        ]),
        ver.id
      );
    db.db
      .prepare(`UPDATE chat_messages SET referenced_highlight_ids_json = '{"not":"array"}' WHERE id = ?`)
      .run(msg.id);

    const docInvalidEmbed = db.createDocument({
      title: 'Invalid Embed Doc',
      sourceType: 'text',
      jobStatus: 'ready',
    });
    db.db
      .prepare(`UPDATE documents SET embedding_json = '[0.1, null]' WHERE id = ?`)
      .run(docInvalidEmbed.id);

    // listDocuments() uses SQL json_valid + json_array_length and must not crash even with invalid highlights JSON
    db.db
      .prepare(`INSERT INTO analysis_versions (
        id, document_id, version_number, summary,
        key_insights_json, improvements_json, open_questions_json, highlights_json,
        annotated_pdf_dirty, revision_reason, created_at
      ) VALUES ('v-bad-list', ?, 1, 'S', '[]', '[]', '[]', '{not-json', 1, 'R', ?)`)
      .run(docInvalidEmbed.id, new Date().toISOString());

    const list = db.listDocuments();
    expect(list.length).toBe(3);
    expect(list.find((d) => d.id === docInvalidEmbed.id)?.highlightCount).toBe(0);

    const loadedDoc = db.getDocumentById(docCorrupt.id);
    expect(loadedDoc?.pageIndex).toEqual([]);
    expect(loadedDoc?.embeddingVector).toBeNull();

    const loadedVer = db.getLatestAnalysisVersion(docCorrupt.id);
    expect(loadedVer?.summary).toBe('Summary survives');
    expect(loadedVer?.keyInsights).toEqual([]);
    expect(loadedVer?.improvements).toEqual([]);
    expect(loadedVer?.openQuestions).toEqual([]);
    expect(loadedVer?.highlights).toHaveLength(1);
    expect(loadedVer?.highlights[0].id).toBe('h-valid');

    const messages = db.listChatMessages(docCorrupt.id);
    expect(messages[0].referencedHighlightIds).toEqual([]);

    const embeddings = db.listDocumentsWithEmbeddings();
    expect(embeddings.map((e) => e.id)).toEqual([docOk.id]);

    const warns = logger.getRecentLogs(30).filter((l) => l.level === 'warn' && l.module === 'db');
    expect(warns.some((w) => w.meta?.column === 'page_index_json')).toBe(true);
    expect(warns.some((w) => w.meta?.column === 'key_insights_json')).toBe(true);
    expect(warns.some((w) => w.meta?.column === 'improvements_json')).toBe(true);
    expect(warns.some((w) => w.meta?.column === 'open_questions_json')).toBe(true);
    expect(warns.some((w) => w.meta?.column === 'highlights_json')).toBe(true);
    expect(warns.some((w) => w.meta?.column === 'referenced_highlight_ids_json')).toBe(true);
    // Empty string on nullable embedding_json should map silently to null without emitting a warning
    expect(warns.some((w) => w.meta?.rowId === docCorrupt.id && w.meta?.column === 'embedding_json')).toBe(false);

    // Strict write-path validation rejects non-array shapes before writing to SQLite
    expect(() =>
      db.createAnalysisVersion({
        documentId: docOk.id,
        payload: {
          summary: 'Bad write',
          keyInsights: {} as unknown as string[],
          improvements: [],
          openQuestions: [],
          highlights: [],
        } as AnalysisPayload,
        revisionReason: 'Invalid write test',
      })
    ).toThrow();
  });

  it('redacts sensitive tokens and API keys in structured logs', () => {
    logger.error(
      'gemini',
      'Request failed with key AIzaSyD1234567890ABCDEFGHIJKLMNOP',
      { apiKey: 'secret-value', nested: { authorization: 'Bearer tok_12345' } },
      'req-1'
    );
    const logs = logger.getRecentLogs(5);
    expect(logs.length).toBe(1);
    expect(logs[0].message).not.toContain('AIzaSyD');
    expect(logs[0].message).toContain('[REDACTED_GEMINI_KEY]');
    expect(logs[0].meta?.apiKey).toBe('[REDACTED]');
    expect((logs[0].meta?.nested as Record<string, unknown>)?.authorization).toBe('[REDACTED]');
  });
});
