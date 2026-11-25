/** SQLite connection facade composing migrations and domain repositories with WAL health checks. */
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import type {
  AnalysisPayload,
  AnalysisVersion,
  ChatMessage,
  DocumentListItem,
  DocumentRecord,
  JobStatus,
  MemoryProfileRecord,
  PageIndexEntry,
  SourceType,
  ToolTraceRecord,
} from '../src/shared/types.ts';
import { runMigrations } from './db/migrations.ts';
import { DocumentRepository } from './db/documentRepo.ts';
import { AnalysisRepository } from './db/analysisRepo.ts';
import { ChatRepository } from './db/chatRepo.ts';
import { MemoryRepository } from './db/memoryRepo.ts';
import type { StructuredLogger } from './utils/jsonParser.ts';

/**
 * Facade over SQLite initialization, schema migrations, and entity repositories.
 * Composes `documents`, `analyses`, `chat`, and `memory` repositories on a shared WAL connection.
 */
export class FolioDatabase {
  public readonly db: Database.Database;
  public readonly documents: DocumentRepository;
  public readonly analyses: AnalysisRepository;
  public readonly chat: ChatRepository;
  public readonly memory: MemoryRepository;

  constructor(dbPath: string, logger?: StructuredLogger) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    runMigrations(this.db, { dbPath, logger });

    this.documents = new DocumentRepository(this.db, logger);
    this.analyses = new AnalysisRepository(this.db, logger);
    this.chat = new ChatRepository(this.db, logger);
    this.memory = new MemoryRepository(this.db);
  }

  /** Marks stale in-flight ingestion/synthesis jobs as `interrupted` on startup. */
  recoverInterruptedJobs(): number {
    return this.documents.recoverInterruptedJobs();
  }

  /** Inserts a new document record and indexes it in `documents_fts`. */
  createDocument(input: {
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
    return this.documents.create(input);
  }

  /** Looks up an existing document by SHA-256 content hash for PDF deduplication. */
  findDocumentByContentHash(contentHash: string): DocumentRecord | null {
    return this.documents.findByContentHash(contentHash);
  }

  /** Looks up an existing document by normalized URL for URL deduplication. */
  findDocumentByUrl(sourceUrl: string): DocumentRecord | null {
    return this.documents.findByUrl(sourceUrl);
  }

  /** Applies a partial update to a document and refreshes `documents_fts` if text changed. */
  updateDocument(
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
    return this.documents.update(id, patch);
  }

  /** Fetches a full document record by ID, or `null` if missing. */
  getDocumentById(id: string): DocumentRecord | null {
    return this.documents.getById(id);
  }

  /** Lists sidebar document summaries, optionally filtered via FTS5 + title search. */
  listDocuments(search?: string): DocumentListItem[] {
    return this.documents.list(search);
  }

  /** Deletes a document and its FTS index entry (cascading versions, chat, and traces). */
  deleteDocument(id: string): boolean {
    return this.documents.delete(id);
  }

  /** Returns ready documents with valid embedding vectors for cosine similarity retrieval. */
  listDocumentsWithEmbeddings(excludeDocumentId?: string) {
    return this.documents.listWithEmbeddings(excludeDocumentId);
  }

  /** Searches indexed documents using SQLite FTS5 prefix matching. */
  searchDocumentsFts(query: string, limit = 5) {
    return this.documents.searchFts(query, limit);
  }

  /** Appends a new immutable `AnalysisVersion` snapshot for a document. */
  createAnalysisVersion(input: {
    documentId: string;
    payload: AnalysisPayload;
    briefPdfPath?: string | null;
    annotatedPdfPath?: string | null;
    annotatedPdfDirty?: boolean;
    revisionReason: string;
  }): AnalysisVersion {
    return this.analyses.createVersion(input);
  }

  /** Updates cached Brief/Annotated PDF file paths or dirty flag on an analysis version. */
  updateVersionPdfPaths(
    versionId: string,
    patch: Partial<{
      briefPdfPath: string | null;
      annotatedPdfPath: string | null;
      annotatedPdfDirty: boolean;
    }>
  ): void {
    this.analyses.updatePdfPaths(versionId, patch);
  }

  /** Returns the latest `AnalysisVersion` for a document, or `null`. */
  getLatestAnalysisVersion(documentId: string): AnalysisVersion | null {
    return this.analyses.getLatest(documentId);
  }

  /** Fetches a specific `AnalysisVersion` by document ID and version number. */
  getAnalysisVersion(documentId: string, versionNumber: number): AnalysisVersion | null {
    return this.analyses.getVersion(documentId, versionNumber);
  }

  /** Lists version metadata (number, reason, timestamp) newest-first. */
  listAnalysisVersions(documentId: string) {
    return this.analyses.listVersions(documentId);
  }

  /** Restores an older version by appending a new copy at the next version number. */
  revertToVersion(documentId: string, targetVersionNumber: number): AnalysisVersion | null {
    return this.analyses.revertToVersion(documentId, targetVersionNumber);
  }

  /** Persists a user or assistant side-chat message. */
  addChatMessage(input: {
    documentId: string;
    role: 'user' | 'assistant';
    content: string;
    referencedHighlightIds?: string[];
    appliedVersionNumber?: number | null;
  }): ChatMessage {
    return this.chat.addMessage(input);
  }

  /** Lists chronological chat messages for a document with attached tool traces. */
  listChatMessages(documentId: string): ChatMessage[] {
    return this.chat.listMessages(documentId);
  }

  /** Records a tool-calling audit trace for debugging and Diagnostics inspection. */
  recordToolTrace(input: Omit<ToolTraceRecord, 'id' | 'createdAt'>): ToolTraceRecord {
    return this.chat.recordTrace(input);
  }

  /** Lists recent tool traces for a single document. */
  listToolTracesByDocument(documentId: string, limit = 50): ToolTraceRecord[] {
    return this.chat.listTracesByDocument(documentId, limit);
  }

  /** Lists the most recent tool traces across all documents. */
  listRecentToolTraces(limit = 50): ToolTraceRecord[] {
    return this.chat.listRecentTraces(limit);
  }

  /** Inserts or updates a standing reading preference rule keyed by `preferenceKey`. */
  upsertMemoryPreference(input: {
    preferenceKey: string;
    learnedRule: string;
    sourceEvidence?: string;
    confidence?: number;
  }): MemoryProfileRecord {
    return this.memory.upsert(input);
  }

  /** Fetches a single MemoryProfile preference by ID. */
  getMemoryPreferenceById(id: string): MemoryProfileRecord | null {
    return this.memory.getById(id);
  }

  /** Lists all stored MemoryProfile reading preferences newest-first. */
  listMemoryPreferences(): MemoryProfileRecord[] {
    return this.memory.list();
  }

  /** Deletes a MemoryProfile preference by ID. */
  deleteMemoryPreference(id: string): boolean {
    return this.memory.delete(id);
  }

  /** Runs `PRAGMA quick_check` and gathers WAL/count metrics for health & diagnostics. */
  getHealthInfo(): { sqliteIntegrity: string; sqliteWalMode: string; documentCount: number; interruptedJobs: number } {
    const integrity = String(this.db.pragma('quick_check', { simple: true }) ?? 'unknown');
    const walMode = String(this.db.pragma('journal_mode', { simple: true }) ?? 'unknown');
    const docRow = this.db.prepare(`SELECT COUNT(*) AS cnt FROM documents`).get() as { cnt: number };
    const intRow = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM documents WHERE job_status = 'interrupted'`)
      .get() as { cnt: number };
    return {
      sqliteIntegrity: integrity,
      sqliteWalMode: walMode,
      documentCount: Number(docRow.cnt),
      interruptedJobs: Number(intRow.cnt),
    };
  }

  /** Closes the underlying SQLite connection. */
  close(): void {
    this.db.close();
  }
}
