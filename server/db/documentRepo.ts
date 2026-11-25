/** Repository for ingested `documents` CRUD, deduplication lookups, search, and job status tracking. */
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import type {
  DocumentListItem,
  DocumentRecord,
  JobStatus,
  PageIndexEntry,
  SourceType,
} from '../../src/shared/types.ts';
import {
  safeParseArray,
  safeParseNumberArray,
  type StructuredLogger,
} from '../utils/jsonParser.ts';
import { isPageIndexEntry } from './rowGuards.ts';

/** Persistence repository for `documents` records, deduplication lookups, and `documents_fts`. */
export class DocumentRepository {
  private readonly db: Database.Database;
  private readonly logger?: StructuredLogger;

  constructor(db: Database.Database, logger?: StructuredLogger) {
    this.db = db;
    this.logger = logger;
  }

  /** Transitions any leftover `queued`/`extracting`/`synthesizing` jobs to `interrupted` after a crash/restart. */
  recoverInterruptedJobs(): number {
    const now = new Date().toISOString();
    const res = this.db
      .prepare(
        `UPDATE documents
         SET job_status = 'interrupted',
             error_message = COALESCE(error_message, 'Analysis interrupted by server restart. Click Resume to continue.'),
             updated_at = ?
         WHERE job_status IN ('queued', 'extracting', 'synthesizing')`
      )
      .run(now);
    return res.changes;
  }

  /** Atomically inserts a document row and its initial `documents_fts` entry. */
  create(input: {
    id?: string;
    title: string;
    sourceType: SourceType;
    sourceUrl?: string | null;
    sourceDomain?: string | null;
    sourcePdfPath?: string | null;
    contentHash?: string | null;
    jobStatus?: JobStatus;
    extractedText?: string;
    pageIndex?: PageIndexEntry[];
    pageCount?: number;
  }): DocumentRecord {
    const id = input.id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    const extractedText = input.extractedText ?? '';
    const pageIndex = input.pageIndex ?? [];
    if (!Array.isArray(pageIndex)) {
      throw new Error('DocumentRepository.create: pageIndex must be an array');
    }
    const pageCount = input.pageCount ?? pageIndex.length;

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO documents (
            id, title, source_type, source_url, source_domain, source_pdf_path, content_hash,
            job_status, error_message, extracted_text, page_index_json, page_count,
            embedding_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?)`
        )
        .run(
          id,
          input.title,
          input.sourceType,
          input.sourceUrl ?? null,
          input.sourceDomain ?? null,
          input.sourcePdfPath ?? null,
          input.contentHash ?? null,
          input.jobStatus ?? 'queued',
          extractedText,
          JSON.stringify(pageIndex),
          pageCount,
          now,
          now
        );

      this.db
        .prepare(`INSERT INTO documents_fts (document_id, title, extracted_text) VALUES (?, ?, ?)`)
        .run(id, input.title, extractedText);
    });
    tx();

    return this.getById(id)!;
  }

  /** Finds the most recent document matching a PDF SHA-256 `content_hash`. */
  findByContentHash(contentHash: string): DocumentRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM documents WHERE content_hash = ? ORDER BY created_at DESC LIMIT 1`)
      .get(contentHash) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  /** Finds the most recent document matching a normalized `source_url`. */
  findByUrl(sourceUrl: string): DocumentRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM documents WHERE source_url = ? ORDER BY created_at DESC LIMIT 1`)
      .get(sourceUrl) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  /** Validates array/vector patches, updates `documents`, and syncs `documents_fts` when text changes. */
  update(
    id: string,
    patch: Partial<{
      title: string;
      sourcePdfPath: string | null;
      jobStatus: JobStatus;
      errorMessage: string | null;
      extractedText: string;
      pageIndex: PageIndexEntry[];
      pageCount: number;
      embeddingVector: number[] | null;
    }>
  ): DocumentRecord | null {
    if (patch.pageIndex !== undefined && !Array.isArray(patch.pageIndex)) {
      throw new Error('DocumentRepository.update: pageIndex must be an array');
    }
    if (
      patch.embeddingVector !== undefined &&
      patch.embeddingVector !== null &&
      (!Array.isArray(patch.embeddingVector) ||
        !patch.embeddingVector.every((n) => typeof n === 'number' && Number.isFinite(n)))
    ) {
      throw new Error('DocumentRepository.update: embeddingVector must be null or finite number[]');
    }

    const existing = this.getById(id);
    if (!existing) return null;
    const now = new Date().toISOString();

    const nextTitle = patch.title ?? existing.title;
    const nextText = patch.extractedText ?? existing.extractedText;

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE documents SET
            title = ?,
            source_pdf_path = ?,
            job_status = ?,
            error_message = ?,
            extracted_text = ?,
            page_index_json = ?,
            page_count = ?,
            embedding_json = ?,
            updated_at = ?
          WHERE id = ?`
        )
        .run(
          nextTitle,
          patch.sourcePdfPath !== undefined ? patch.sourcePdfPath : existing.sourcePdfPath,
          patch.jobStatus ?? existing.jobStatus,
          patch.errorMessage !== undefined ? patch.errorMessage : existing.errorMessage,
          nextText,
          patch.pageIndex !== undefined ? JSON.stringify(patch.pageIndex) : JSON.stringify(existing.pageIndex),
          patch.pageCount ?? existing.pageCount,
          patch.embeddingVector !== undefined
            ? patch.embeddingVector
              ? JSON.stringify(patch.embeddingVector)
              : null
            : existing.embeddingVector
              ? JSON.stringify(existing.embeddingVector)
              : null,
          now,
          id
        );

      if (patch.title !== undefined || patch.extractedText !== undefined) {
        this.db.prepare(`DELETE FROM documents_fts WHERE document_id = ?`).run(id);
        this.db
          .prepare(`INSERT INTO documents_fts (document_id, title, extracted_text) VALUES (?, ?, ?)`)
          .run(id, nextTitle, nextText);
      }
    });
    tx();

    return this.getById(id);
  }

  /** Fetches a full `DocumentRecord` by ID, or `null` if not found. */
  getById(id: string): DocumentRecord | null {
    const row = this.db.prepare(`SELECT * FROM documents WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapRow(row) : null;
  }

  /** Lists document summaries ordered by `updated_at`, computing `highlightCount` in SQL. */
  list(search?: string): DocumentListItem[] {
    const highlightCountExpr = `
      CASE
        WHEN v.highlights_json IS NOT NULL
         AND json_valid(v.highlights_json)
         AND json_type(v.highlights_json) = 'array'
        THEN json_array_length(v.highlights_json)
        ELSE 0
      END AS latest_highlight_count
    `;

    let rows: Array<Record<string, unknown>>;
    if (search && search.trim()) {
      const ftsQuery = search
        .trim()
        .split(/\s+/)
        .map((t) => `"${t.replace(/"/g, '""')}"*`)
        .join(' OR ');
      rows = this.db
        .prepare(
          `SELECT d.id, d.title, d.source_type, d.source_url, d.source_domain,
                  d.job_status, d.error_message, d.page_count, d.created_at, d.updated_at,
                  v.version_number AS latest_version_number,
                  ${highlightCountExpr}
           FROM documents d
           LEFT JOIN analysis_versions v
             ON v.document_id = d.id
            AND v.version_number = (
              SELECT MAX(v2.version_number) FROM analysis_versions v2 WHERE v2.document_id = d.id
            )
           WHERE d.id IN (SELECT document_id FROM documents_fts WHERE documents_fts MATCH ?)
              OR d.title LIKE ?
           ORDER BY d.updated_at DESC`
        )
        .all(ftsQuery, `%${search.trim()}%`) as Array<Record<string, unknown>>;
    } else {
      rows = this.db
        .prepare(
          `SELECT d.id, d.title, d.source_type, d.source_url, d.source_domain,
                  d.job_status, d.error_message, d.page_count, d.created_at, d.updated_at,
                  v.version_number AS latest_version_number,
                  ${highlightCountExpr}
           FROM documents d
           LEFT JOIN analysis_versions v
             ON v.document_id = d.id
            AND v.version_number = (
              SELECT MAX(v2.version_number) FROM analysis_versions v2 WHERE v2.document_id = d.id
            )
           ORDER BY d.updated_at DESC`
        )
        .all() as Array<Record<string, unknown>>;
    }

    return rows.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      sourceType: row.source_type as SourceType,
      sourceUrl: row.source_url ? String(row.source_url) : null,
      sourceDomain: row.source_domain ? String(row.source_domain) : null,
      jobStatus: row.job_status as JobStatus,
      errorMessage: row.error_message ? String(row.error_message) : null,
      pageCount: Number(row.page_count ?? 0),
      latestVersionNumber: row.latest_version_number != null ? Number(row.latest_version_number) : null,
      highlightCount: Number(row.latest_highlight_count ?? 0),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  /** Removes a document and its FTS entry inside a transaction. */
  delete(id: string): boolean {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM documents_fts WHERE document_id = ?`).run(id);
      return this.db.prepare(`DELETE FROM documents WHERE id = ?`).run(id);
    });
    return tx().changes > 0;
  }

  /** Loads ready documents with valid embedding vectors, skipping any malformed rows safely. */
  listWithEmbeddings(excludeDocumentId?: string): Array<{
    id: string;
    title: string;
    sourceDomain: string | null;
    embeddingVector: number[];
    summary: string;
    createdAt: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT d.id, d.title, d.source_domain, d.embedding_json, d.created_at,
                v.summary
         FROM documents d
         LEFT JOIN analysis_versions v
           ON v.document_id = d.id
          AND v.version_number = (
            SELECT MAX(v2.version_number) FROM analysis_versions v2 WHERE v2.document_id = d.id
          )
         WHERE d.embedding_json IS NOT NULL
           AND TRIM(d.embedding_json) != ''
           AND d.job_status = 'ready'
           AND (? IS NULL OR d.id != ?)`
      )
      .all(excludeDocumentId ?? null, excludeDocumentId ?? null) as Array<Record<string, unknown>>;

    const out: Array<{
      id: string;
      title: string;
      sourceDomain: string | null;
      embeddingVector: number[];
      summary: string;
      createdAt: string;
    }> = [];

    for (const r of rows) {
      const id = String(r.id);
      const vector = safeParseNumberArray(r.embedding_json, {
        module: 'db',
        table: 'documents',
        rowId: id,
        column: 'embedding_json',
        logger: this.logger,
      });
      if (!vector) continue;
      out.push({
        id,
        title: String(r.title),
        sourceDomain: r.source_domain ? String(r.source_domain) : null,
        embeddingVector: vector,
        summary: r.summary ? String(r.summary) : '',
        createdAt: String(r.created_at),
      });
    }

    return out;
  }

  /** Runs an FTS5 prefix search across document titles and extracted prose. */
  searchFts(query: string, limit = 5): Array<{ id: string; title: string; summary: string; createdAt: string }> {
    const tokens = query
      .trim()
      .split(/\s+/)
      .filter((t) => t.length > 1);
    if (tokens.length === 0) return [];
    const ftsExpr = tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' OR ');

    const rows = this.db
      .prepare(
        `SELECT d.id, d.title, d.created_at, COALESCE(v.summary, substr(d.extracted_text, 1, 400)) AS summary
         FROM documents_fts f
         JOIN documents d ON d.id = f.document_id
         LEFT JOIN analysis_versions v
           ON v.document_id = d.id
          AND v.version_number = (
            SELECT MAX(v2.version_number) FROM analysis_versions v2 WHERE v2.document_id = d.id
          )
         WHERE documents_fts MATCH ?
         LIMIT ?`
      )
      .all(ftsExpr, limit) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: String(r.id),
      title: String(r.title),
      summary: String(r.summary),
      createdAt: String(r.created_at),
    }));
  }

  /** Maps a `documents` row into a `DocumentRecord` with resilient JSON array/vector parsing. */
  private mapRow(row: Record<string, unknown>): DocumentRecord {
    const id = String(row.id);
    return {
      id,
      title: String(row.title),
      sourceType: row.source_type as SourceType,
      sourceUrl: row.source_url ? String(row.source_url) : null,
      sourceDomain: row.source_domain ? String(row.source_domain) : null,
      sourcePdfPath: row.source_pdf_path ? String(row.source_pdf_path) : null,
      contentHash: row.content_hash ? String(row.content_hash) : null,
      jobStatus: row.job_status as JobStatus,
      errorMessage: row.error_message ? String(row.error_message) : null,
      extractedText: String(row.extracted_text ?? ''),
      pageIndex: safeParseArray<PageIndexEntry>(row.page_index_json, {
        module: 'db',
        table: 'documents',
        rowId: id,
        column: 'page_index_json',
        logger: this.logger,
        itemGuard: isPageIndexEntry,
      }),
      pageCount: Number(row.page_count ?? 0),
      embeddingVector: safeParseNumberArray(row.embedding_json, {
        module: 'db',
        table: 'documents',
        rowId: id,
        column: 'embedding_json',
        logger: this.logger,
      }),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}
