/** Repository for per-document side-chat transcripts (`chat_messages`) and tool audit logs (`tool_traces`). */
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import type { ChatMessage, ToolTraceRecord } from '../../src/shared/types.ts';
import { isStringItem, safeParseArray, type StructuredLogger } from '../utils/jsonParser.ts';

/** Persistence repository for side-chat messages (`chat_messages`) and tool audit logs (`tool_traces`). */
export class ChatRepository {
  private readonly db: Database.Database;
  private readonly logger?: StructuredLogger;

  constructor(db: Database.Database, logger?: StructuredLogger) {
    this.db = db;
    this.logger = logger;
  }

  /** Appends a user or assistant message and validates `referencedHighlightIds` on write. */
  addMessage(input: {
    documentId: string;
    role: 'user' | 'assistant';
    content: string;
    referencedHighlightIds?: string[];
    appliedVersionNumber?: number | null;
  }): ChatMessage {
    const referencedHighlightIds = input.referencedHighlightIds ?? [];
    if (!Array.isArray(referencedHighlightIds)) {
      throw new Error('ChatRepository.addMessage: referencedHighlightIds must be an array');
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO chat_messages (
          id, document_id, role, content, referenced_highlight_ids_json, applied_version_number, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.documentId,
        input.role,
        input.content,
        JSON.stringify(referencedHighlightIds),
        input.appliedVersionNumber ?? null,
        now
      );

    return {
      id,
      documentId: input.documentId,
      role: input.role,
      content: input.content,
      referencedHighlightIds,
      appliedVersionNumber: input.appliedVersionNumber ?? null,
      createdAt: now,
    };
  }

  /** Lists chronological chat messages for a document and joins their tool-calling traces. */
  listMessages(documentId: string): ChatMessage[] {
    const rows = this.db
      .prepare(`SELECT * FROM chat_messages WHERE document_id = ? ORDER BY created_at ASC`)
      .all(documentId) as Array<Record<string, unknown>>;

    const traces = this.listTracesByDocument(documentId, 200);
    const tracesByMsg = new Map<string, ToolTraceRecord[]>();
    for (const trace of traces) {
      if (trace.chatMessageId) {
        const list = tracesByMsg.get(trace.chatMessageId) ?? [];
        list.push(trace);
        tracesByMsg.set(trace.chatMessageId, list);
      }
    }

    return rows.map((r) => {
      const id = String(r.id);
      return {
        id,
        documentId: String(r.document_id),
        role: r.role as 'user' | 'assistant',
        content: String(r.content),
        referencedHighlightIds: safeParseArray<string>(r.referenced_highlight_ids_json, {
          module: 'db',
          table: 'chat_messages',
          rowId: id,
          column: 'referenced_highlight_ids_json',
          logger: this.logger,
          itemGuard: isStringItem,
        }),
        appliedVersionNumber: r.applied_version_number != null ? Number(r.applied_version_number) : null,
        traces: tracesByMsg.get(id) ?? [],
        createdAt: String(r.created_at),
      };
    });
  }

  /** Persists a tool execution audit record with timing and version delta metadata. */
  recordTrace(input: Omit<ToolTraceRecord, 'id' | 'createdAt'>): ToolTraceRecord {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO tool_traces (
          id, document_id, chat_message_id, model, tool_name, raw_args_json,
          status, result_summary, before_version, after_version, duration_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.documentId,
        input.chatMessageId ?? null,
        input.model,
        input.toolName,
        input.rawArgsJson,
        input.status,
        input.resultSummary,
        input.beforeVersion ?? null,
        input.afterVersion ?? null,
        input.durationMs,
        now
      );

    return { ...input, id, createdAt: now };
  }

  /** Lists recent tool traces for a specific document newest-first. */
  listTracesByDocument(documentId: string, limit = 50): ToolTraceRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM tool_traces WHERE document_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(documentId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapTraceRow(r));
  }

  /** Lists the most recent tool traces across all documents for Diagnostics. */
  listRecentTraces(limit = 50): ToolTraceRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM tool_traces ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapTraceRow(r));
  }

  /** Maps a `tool_traces` SQLite row into a `ToolTraceRecord`. */
  private mapTraceRow(row: Record<string, unknown>): ToolTraceRecord {
    return {
      id: String(row.id),
      documentId: String(row.document_id),
      chatMessageId: row.chat_message_id ? String(row.chat_message_id) : null,
      model: String(row.model),
      toolName: String(row.tool_name),
      rawArgsJson: String(row.raw_args_json),
      status: row.status as 'ok' | 'rejected' | 'error',
      resultSummary: String(row.result_summary),
      beforeVersion: row.before_version != null ? Number(row.before_version) : null,
      afterVersion: row.after_version != null ? Number(row.after_version) : null,
      durationMs: Number(row.duration_ms ?? 0),
      createdAt: String(row.created_at),
    };
  }
}
