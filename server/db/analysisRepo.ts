/** Repository for immutable `AnalysisVersion` snapshots, brief/annotated PDF paths, and version reverts. */
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import type { AnalysisPayload, AnalysisVersion, HighlightItem } from '../../src/shared/types.ts';
import {
  isStringItem,
  safeParseArray,
  type StructuredLogger,
} from '../utils/jsonParser.ts';
import { isHighlightItem } from './rowGuards.ts';

/** Ensures required Brief/Highlight collections are arrays before persisting JSON columns. */
function assertAnalysisPayloadValid(payload: AnalysisPayload): void {
  if (!payload || typeof payload.summary !== 'string') {
    throw new Error('AnalysisRepository.createVersion: payload.summary must be a string');
  }
  if (!Array.isArray(payload.keyInsights)) {
    throw new Error('AnalysisRepository.createVersion: payload.keyInsights must be an array');
  }
  if (!Array.isArray(payload.improvements)) {
    throw new Error('AnalysisRepository.createVersion: payload.improvements must be an array');
  }
  if (!Array.isArray(payload.openQuestions)) {
    throw new Error('AnalysisRepository.createVersion: payload.openQuestions must be an array');
  }
  if (!Array.isArray(payload.highlights)) {
    throw new Error('AnalysisRepository.createVersion: payload.highlights must be an array');
  }
}

/** Persistence repository for append-only `analysis_versions` snapshots and rollbacks. */
export class AnalysisRepository {
  private readonly db: Database.Database;
  private readonly logger?: StructuredLogger;

  constructor(db: Database.Database, logger?: StructuredLogger) {
    this.db = db;
    this.logger = logger;
  }

  /** Atomically appends the next sequential `AnalysisVersion` for a document. */
  createVersion(input: {
    documentId: string;
    payload: AnalysisPayload;
    briefPdfPath?: string | null;
    annotatedPdfPath?: string | null;
    annotatedPdfDirty?: boolean;
    revisionReason: string;
  }): AnalysisVersion {
    assertAnalysisPayloadValid(input.payload);

    const tx = this.db.transaction(() => {
      const maxRow = this.db
        .prepare(`SELECT COALESCE(MAX(version_number), 0) AS max_ver FROM analysis_versions WHERE document_id = ?`)
        .get(input.documentId) as { max_ver: number };
      const nextVer = Number(maxRow.max_ver) + 1;
      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      this.db
        .prepare(
          `INSERT INTO analysis_versions (
            id, document_id, version_number, summary,
            key_insights_json, improvements_json, open_questions_json, highlights_json,
            brief_pdf_path, annotated_pdf_path, annotated_pdf_dirty, revision_reason, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.documentId,
          nextVer,
          input.payload.summary,
          JSON.stringify(input.payload.keyInsights),
          JSON.stringify(input.payload.improvements),
          JSON.stringify(input.payload.openQuestions),
          JSON.stringify(input.payload.highlights),
          input.briefPdfPath ?? null,
          input.annotatedPdfPath ?? null,
          input.annotatedPdfDirty === false ? 0 : 1,
          input.revisionReason,
          now
        );

      this.db.prepare(`UPDATE documents SET updated_at = ? WHERE id = ?`).run(now, input.documentId);
      return nextVer;
    });

    const nextVer = tx();
    return this.getVersion(input.documentId, nextVer)!;
  }

  /** Updates cached Brief/Annotated PDF paths or the dirty regeneration flag on a version. */
  updatePdfPaths(
    versionId: string,
    patch: Partial<{
      briefPdfPath: string | null;
      annotatedPdfPath: string | null;
      annotatedPdfDirty: boolean;
    }>
  ): void {
    const existing = this.db
      .prepare(`SELECT * FROM analysis_versions WHERE id = ?`)
      .get(versionId) as Record<string, unknown> | undefined;
    if (!existing) return;

    this.db
      .prepare(
        `UPDATE analysis_versions
         SET brief_pdf_path = ?, annotated_pdf_path = ?, annotated_pdf_dirty = ?
         WHERE id = ?`
      )
      .run(
        patch.briefPdfPath !== undefined ? patch.briefPdfPath : existing.brief_pdf_path,
        patch.annotatedPdfPath !== undefined ? patch.annotatedPdfPath : existing.annotated_pdf_path,
        patch.annotatedPdfDirty !== undefined ? (patch.annotatedPdfDirty ? 1 : 0) : existing.annotated_pdf_dirty,
        versionId
      );
  }

  /** Returns the highest-numbered `AnalysisVersion` for a document, or `null`. */
  getLatest(documentId: string): AnalysisVersion | null {
    const row = this.db
      .prepare(`SELECT * FROM analysis_versions WHERE document_id = ? ORDER BY version_number DESC LIMIT 1`)
      .get(documentId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  /** Fetches a specific `AnalysisVersion` by document ID and version number. */
  getVersion(documentId: string, versionNumber: number): AnalysisVersion | null {
    const row = this.db
      .prepare(`SELECT * FROM analysis_versions WHERE document_id = ? AND version_number = ?`)
      .get(documentId, versionNumber) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  /** Lists version history summaries (ID, number, reason, timestamp) newest-first. */
  listVersions(documentId: string): Array<{
    id: string;
    versionNumber: number;
    revisionReason: string;
    createdAt: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, version_number, revision_reason, created_at
         FROM analysis_versions
         WHERE document_id = ?
         ORDER BY version_number DESC`
      )
      .all(documentId) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: String(r.id),
      versionNumber: Number(r.version_number),
      revisionReason: String(r.revision_reason),
      createdAt: String(r.created_at),
    }));
  }

  /** Restores `targetVersionNumber` as a new appended version and marks the annotated PDF dirty. */
  revertToVersion(documentId: string, targetVersionNumber: number): AnalysisVersion | null {
    const target = this.getVersion(documentId, targetVersionNumber);
    if (!target) return null;
    return this.createVersion({
      documentId,
      payload: {
        summary: target.summary,
        keyInsights: target.keyInsights,
        improvements: target.improvements,
        openQuestions: target.openQuestions,
        highlights: target.highlights,
      },
      annotatedPdfDirty: true,
      revisionReason: `Reverted to version v${targetVersionNumber}`,
    });
  }

  /** Maps an `analysis_versions` row into an `AnalysisVersion` using safe JSON array parsing. */
  private mapRow(row: Record<string, unknown>): AnalysisVersion {
    const id = String(row.id);
    return {
      id,
      documentId: String(row.document_id),
      versionNumber: Number(row.version_number),
      summary: String(row.summary ?? ''),
      keyInsights: safeParseArray<string>(row.key_insights_json, {
        module: 'db',
        table: 'analysis_versions',
        rowId: id,
        column: 'key_insights_json',
        logger: this.logger,
        itemGuard: isStringItem,
      }),
      improvements: safeParseArray<string>(row.improvements_json, {
        module: 'db',
        table: 'analysis_versions',
        rowId: id,
        column: 'improvements_json',
        logger: this.logger,
        itemGuard: isStringItem,
      }),
      openQuestions: safeParseArray<string>(row.open_questions_json, {
        module: 'db',
        table: 'analysis_versions',
        rowId: id,
        column: 'open_questions_json',
        logger: this.logger,
        itemGuard: isStringItem,
      }),
      highlights: safeParseArray<HighlightItem>(row.highlights_json, {
        module: 'db',
        table: 'analysis_versions',
        rowId: id,
        column: 'highlights_json',
        logger: this.logger,
        itemGuard: isHighlightItem,
      }),
      briefPdfPath: row.brief_pdf_path ? String(row.brief_pdf_path) : null,
      annotatedPdfPath: row.annotated_pdf_path ? String(row.annotated_pdf_path) : null,
      annotatedPdfDirty: Boolean(row.annotated_pdf_dirty),
      revisionReason: String(row.revision_reason ?? ''),
      createdAt: String(row.created_at),
    };
  }
}
