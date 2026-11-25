/** Repository for persisted user reading preferences (`memory_profiles`). */
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import type { MemoryProfileRecord } from '../../src/shared/types.ts';

/** Persistence repository for learned user reading preferences (`memory_profiles`). */
export class MemoryRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** Inserts or updates a standing reading preference keyed by `preferenceKey`. */
  upsert(input: {
    preferenceKey: string;
    learnedRule: string;
    sourceEvidence?: string;
    confidence?: number;
  }): MemoryProfileRecord {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare(`SELECT id FROM memory_profiles WHERE preference_key = ?`)
      .get(input.preferenceKey) as { id: string } | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE memory_profiles
           SET learned_rule = ?, source_evidence = ?, confidence = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          input.learnedRule,
          input.sourceEvidence ?? '',
          input.confidence ?? 0.85,
          now,
          existing.id
        );
      return this.getById(existing.id)!;
    }

    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO memory_profiles (id, preference_key, learned_rule, source_evidence, confidence, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.preferenceKey,
        input.learnedRule,
        input.sourceEvidence ?? '',
        input.confidence ?? 0.85,
        now
      );
    return this.getById(id)!;
  }

  /** Fetches a single preference record by ID, or `null`. */
  getById(id: string): MemoryProfileRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM memory_profiles WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  /** Lists all stored reading preferences ordered by most recently updated. */
  list(): MemoryProfileRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM memory_profiles ORDER BY updated_at DESC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRow(row));
  }

  /** Deletes a preference record by ID and returns whether a row was removed. */
  delete(id: string): boolean {
    return this.db.prepare(`DELETE FROM memory_profiles WHERE id = ?`).run(id).changes > 0;
  }

  /** Maps a `memory_profiles` SQLite row to a `MemoryProfileRecord`. */
  private mapRow(row: Record<string, unknown>): MemoryProfileRecord {
    return {
      id: String(row.id),
      preferenceKey: String(row.preference_key),
      learnedRule: String(row.learned_rule),
      sourceEvidence: String(row.source_evidence),
      confidence: Number(row.confidence),
      updatedAt: String(row.updated_at),
    };
  }
}
