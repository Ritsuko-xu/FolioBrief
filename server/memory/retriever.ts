/** Cross-document context retriever combining `MemoryProfile` rules with embedding/keyword similarity. */
import type { FolioDatabase } from '../db.ts';
import type { MemoryProfileRecord } from '../../src/shared/types.ts';

/** Computes normalized cosine similarity (`0..1` for non-negative embeddings) between two equal-length vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom > 0 ? dot / denom : 0;
}

export interface RelatedReadingMatch {
  id: string;
  title: string;
  sourceDomain: string | null;
  summary: string;
  similarity: number;
  createdAt: string;
}

/** Retrieves related prior readings and MemoryProfile rules to personalize synthesis and chat. */
export class MemoryContextRetriever {
  private readonly db: FolioDatabase;

  constructor(db: FolioDatabase) {
    this.db = db;
  }

  /** Ranks related library documents via embedding cosine similarity with FTS5 keyword fallback. */
  findRelatedDocuments(input: {
    excludeDocumentId?: string;
    queryEmbedding?: number[] | null;
    fallbackKeywords?: string;
    limit?: number;
  }): RelatedReadingMatch[] {
    const limit = input.limit ?? 3;
    if (input.queryEmbedding && input.queryEmbedding.length > 0) {
      const candidates = this.db.listDocumentsWithEmbeddings(input.excludeDocumentId);
      const scored = candidates
        .map((c) => ({
          id: c.id,
          title: c.title,
          sourceDomain: c.sourceDomain,
          summary: c.summary,
          similarity: cosineSimilarity(input.queryEmbedding!, c.embeddingVector),
          createdAt: c.createdAt,
        }))
        .filter((item) => item.similarity > 0.25)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);

      if (scored.length > 0) return scored;
    }

    if (input.fallbackKeywords) {
      const ftsMatches = this.db.searchDocumentsFts(input.fallbackKeywords, limit + 1);
      return ftsMatches
        .filter((m) => m.id !== input.excludeDocumentId)
        .slice(0, limit)
        .map((m) => ({
          id: m.id,
          title: m.title,
          sourceDomain: null,
          summary: m.summary,
          similarity: 0.5,
          createdAt: m.createdAt,
        }));
    }

    return [];
  }

  /** Builds a concise prompt context block combining user preferences and top related readings. */
  buildPersonalizedContextBlock(input: {
    excludeDocumentId?: string;
    queryEmbedding?: number[] | null;
    fallbackKeywords?: string;
  }): {
    promptBlock: string;
    preferences: MemoryProfileRecord[];
    relatedDocuments: RelatedReadingMatch[];
  } {
    const preferences = this.db.listMemoryPreferences().slice(0, 12);
    const relatedDocuments = this.findRelatedDocuments({
      excludeDocumentId: input.excludeDocumentId,
      queryEmbedding: input.queryEmbedding,
      fallbackKeywords: input.fallbackKeywords,
      limit: 3,
    });

    const lines: string[] = [];
    if (preferences.length > 0) {
      lines.push('USER READING PREFERENCES (learned from prior sessions):');
      for (const pref of preferences) {
        lines.push(`- [${pref.preferenceKey}] ${pref.learnedRule}`);
      }
    }

    if (relatedDocuments.length > 0) {
      lines.push('RELATED PRIOR READINGS IN USER LIBRARY:');
      for (const doc of relatedDocuments) {
        lines.push(`- "${doc.title}" (${doc.createdAt.slice(0, 10)}): ${doc.summary.slice(0, 280)}`);
      }
    }

    return {
      promptBlock: lines.join('\n'),
      preferences,
      relatedDocuments,
    };
  }
}
