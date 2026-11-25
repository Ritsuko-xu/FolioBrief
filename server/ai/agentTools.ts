/** Domain tool schemas and executors for mutating analysis revisions, highlights, prior-reading search, and memory preferences. */
import { Type, type FunctionDeclaration } from '@google/genai';
import crypto from 'node:crypto';
import type {
  AnalysisPayload,
  AnalysisVersion,
  DocumentRecord,
  HighlightCategory,
  HighlightItem,
} from '../../src/shared/types.ts';
import type { FolioDatabase } from '../db.ts';
import type { FileStorageManager } from '../storage.ts';
import { findQuoteRects } from '../pdf/extractor.ts';
import { generateBriefPdfBytes } from '../pdf/generator.ts';
import { MemoryContextRetriever } from '../memory/retriever.ts';
import { computeConciseHighlightCap, PRIMARY_MODEL } from './geminiClient.ts';

export const AGENT_TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: 'update_brief_section',
    description:
      'Modify a specific section of the generated Executive Brief (summary, keyInsights, improvements, or openQuestions). Only modifies the targeted section and leaves all other sections untouched.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        section: {
          type: Type.STRING,
          description: 'One of: summary, keyInsights, improvements, openQuestions',
        },
        operation: {
          type: Type.STRING,
          description: 'One of: replace_section, append_item, edit_item, remove_item',
        },
        itemIndex: {
          type: Type.INTEGER,
          description: 'Zero-based bullet index when operation is edit_item or remove_item',
        },
        content: {
          type: Type.STRING,
          description: 'New text content. For replace_section on bulleted lists, separate bullets with newline characters.',
        },
      },
      required: ['section', 'operation'],
    },
  },
  {
    name: 'upsert_highlight',
    description:
      'Add a new concise highlight and margin comment to the article, or update an existing highlight comment. Respects the document conciseness budget.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        highlightId: {
          type: Type.STRING,
          description: 'Existing highlight ID to update, or omit to create a new highlight.',
        },
        page: {
          type: Type.INTEGER,
          description: '1-based page number where the quote appears.',
        },
        quoteAnchor: {
          type: Type.STRING,
          description: 'Exact short verbatim phrase (5-25 words) from the paper to highlight.',
        },
        category: {
          type: Type.STRING,
          description: 'One of: claim, improvement, question',
        },
        comment: {
          type: Type.STRING,
          description: 'Concise margin comment explaining why this passage matters.',
        },
      },
      required: ['page', 'quoteAnchor', 'category', 'comment'],
    },
  },
  {
    name: 'delete_highlight',
    description: 'Remove an existing highlight and its margin comment by highlightId.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        highlightId: {
          type: Type.STRING,
          description: 'The ID of the highlight to remove (e.g. hl-12ab34cd).',
        },
      },
      required: ['highlightId'],
    },
  },
  {
    name: 'search_prior_readings',
    description:
      'Search previously read papers and articles in the user library to cross-reference ideas or answer comparison questions.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: 'Keywords or topic to search across prior readings.',
        },
        limit: {
          type: Type.INTEGER,
          description: 'Maximum results to return (default 3).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'update_memory_preference',
    description:
      'Store or update a standing user reading preference in MemoryProfile when the user states how they want future analyses formatted or focused.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        preferenceKey: {
          type: Type.STRING,
          description: 'Short snake_case key (e.g. systems_focus, highlight_style).',
        },
        rule: {
          type: Type.STRING,
          description: 'Clear 1-sentence preference rule to apply to future papers.',
        },
      },
      required: ['preferenceKey', 'rule'],
    },
  },
];

export interface ToolExecutionContext {
  db: FolioDatabase;
  storage?: FileStorageManager;
  documentId: string;
  chatMessageId?: string | null;
  model?: string;
}

export interface ToolExecutionOutcome {
  ok: boolean;
  result: Record<string, unknown>;
  newVersion?: AnalysisVersion;
}

interface HandlerOutcome extends ToolExecutionOutcome {
  status: 'ok' | 'rejected';
  traceSummary: string;
}

type ToolHandlerInput = {
  ctx: ToolExecutionContext;
  doc: DocumentRecord;
  latest: AnalysisVersion | null;
  args: Record<string, unknown>;
};

type ToolHandler = (input: ToolHandlerInput) => Promise<HandlerOutcome>;

const VALID_BRIEF_SECTIONS = ['summary', 'keyInsights', 'improvements', 'openQuestions'] as const;
type BriefSection = (typeof VALID_BRIEF_SECTIONS)[number];
type BriefOperation = 'replace_section' | 'append_item' | 'edit_item' | 'remove_item';

/** Builds a rejected handler outcome without mutating state. */
function reject(error: string, traceSummary = error): HandlerOutcome {
  return { ok: false, status: 'rejected', traceSummary, result: { error } };
}

/** Persists a new `AnalysisVersion` snapshot and regenerates `brief_v<N>.pdf` when storage is configured. */
async function commitAnalysisRevision(input: {
  ctx: ToolExecutionContext;
  doc: DocumentRecord;
  payload: AnalysisPayload;
  annotatedPdfPath?: string | null;
  annotatedPdfDirty: boolean;
  revisionReason: string;
}): Promise<AnalysisVersion> {
  const { ctx, doc } = input;
  const newVer = ctx.db.createAnalysisVersion({
    documentId: ctx.documentId,
    payload: input.payload,
    annotatedPdfPath: input.annotatedPdfPath,
    annotatedPdfDirty: input.annotatedPdfDirty,
    revisionReason: input.revisionReason,
  });

  if (ctx.storage) {
    const briefBytes = await generateBriefPdfBytes({
      title: doc.title,
      sourceDomain: doc.sourceDomain,
      version: newVer,
    });
    const briefPath = ctx.storage.getBriefPdfPath(doc.id, newVer.versionNumber);
    ctx.storage.writeFileAtomic(briefPath, briefBytes);
    ctx.db.updateVersionPdfPaths(newVer.id, { briefPdfPath: briefPath });
    newVer.briefPdfPath = briefPath;
  }

  return newVer;
}

/** Updates a single Brief section (`summary`, `keyInsights`, `improvements`, or `openQuestions`). */
async function handleUpdateBriefSection({ ctx, doc, latest, args }: ToolHandlerInput): Promise<HandlerOutcome> {
  if (!latest) {
    return reject('No existing analysis version to modify.', 'No existing analysis version to modify');
  }

  const section = String(args.section ?? '') as BriefSection;
  const operation = String(args.operation ?? '') as BriefOperation;
  const content = args.content != null ? String(args.content).trim() : '';
  const itemIndex = args.itemIndex != null ? Number(args.itemIndex) : -1;

  if (!VALID_BRIEF_SECTIONS.includes(section)) {
    return reject(`Unsupported section: ${section}`, `Invalid section: ${section}`);
  }

  const nextPayload: AnalysisPayload = {
    summary: latest.summary,
    keyInsights: [...latest.keyInsights],
    improvements: [...latest.improvements],
    openQuestions: [...latest.openQuestions],
    highlights: [...latest.highlights],
  };

  if (section === 'summary') {
    if (!content) {
      return reject('Content is required to update summary.', 'Empty summary content');
    }
    nextPayload.summary = content;
  } else {
    const list = [...nextPayload[section]];
    if (operation === 'replace_section') {
      const items = content
        .split(/\n+/)
        .map((s) => s.replace(/^[-*•\d.)\s]+/, '').trim())
        .filter(Boolean);
      if (items.length === 0) {
        return reject('Provide at least one bullet item.', 'Replacement items cannot be empty');
      }
      nextPayload[section] = items;
    } else if (operation === 'append_item') {
      if (!content) {
        return reject('Content required for append_item.', 'Empty append content');
      }
      list.push(content.replace(/^[-*•]\s*/, ''));
      nextPayload[section] = list;
    } else if (operation === 'edit_item') {
      if (itemIndex < 0 || itemIndex >= list.length || !content) {
        return reject(`Invalid itemIndex ${itemIndex} for ${section}.`, `Invalid itemIndex ${itemIndex} for ${section}`);
      }
      list[itemIndex] = content.replace(/^[-*•]\s*/, '');
      nextPayload[section] = list;
    } else if (operation === 'remove_item') {
      if (itemIndex < 0 || itemIndex >= list.length) {
        return reject(`Invalid itemIndex ${itemIndex} for ${section}.`, `Invalid itemIndex ${itemIndex} for removal`);
      }
      list.splice(itemIndex, 1);
      nextPayload[section] = list;
    } else {
      return reject(`Unsupported operation: ${operation}`, `Unsupported operation ${operation}`);
    }
  }

  const newVer = await commitAnalysisRevision({
    ctx,
    doc,
    payload: nextPayload,
    annotatedPdfPath: latest.annotatedPdfPath,
    annotatedPdfDirty: latest.annotatedPdfDirty,
    revisionReason: `Revision: ${operation} on ${section}`,
  });

  return {
    ok: true,
    status: 'ok',
    newVersion: newVer,
    traceSummary: `Updated ${section} (${operation}) -> v${newVer.versionNumber}`,
    result: { status: 'updated', versionNumber: newVer.versionNumber, section, operation },
  };
}

/** Adds or updates a grounded highlight and margin note while enforcing the per-document cap. */
async function handleUpsertHighlight({ ctx, doc, latest, args }: ToolHandlerInput): Promise<HandlerOutcome> {
  if (!latest) {
    return reject('No analysis version found.', 'No analysis version found');
  }

  const highlightId = args.highlightId ? String(args.highlightId).trim() : null;
  const requestedPage = Number(args.page ?? 1);
  const quoteAnchor = String(args.quoteAnchor ?? '').trim();
  const categoryRaw = String(args.category ?? 'claim');
  const comment = String(args.comment ?? '').trim();

  if (!quoteAnchor || !comment) {
    return reject('Both quoteAnchor and comment are required.', 'quoteAnchor and comment are required');
  }
  if (requestedPage < 1 || requestedPage > Math.max(1, doc.pageCount)) {
    return reject(
      `Page ${requestedPage} is out of bounds (1-${doc.pageCount}).`,
      `Page ${requestedPage} out of range 1..${doc.pageCount}`
    );
  }

  const category: HighlightCategory =
    categoryRaw === 'improvement' || categoryRaw === 'question' ? categoryRaw : 'claim';
  const nextHighlights = [...latest.highlights];
  const existingIdx = highlightId ? nextHighlights.findIndex((h) => h.id === highlightId) : -1;

  const cap = computeConciseHighlightCap(Math.max(1, doc.pageCount));
  if (existingIdx === -1 && nextHighlights.length >= cap) {
    return reject(
      `Conciseness limit of ${cap} highlights reached. Delete an existing highlight first before adding another.`,
      `Conciseness cap (${cap}) reached`
    );
  }

  const matched = findQuoteRects(doc.pageIndex, requestedPage, quoteAnchor);
  const item: HighlightItem = {
    id: existingIdx >= 0 ? nextHighlights[existingIdx].id : `hl-${crypto.randomUUID().slice(0, 8)}`,
    page: matched.page,
    quoteAnchor,
    category,
    comment,
    rects: matched.rects,
  };

  if (existingIdx >= 0) {
    nextHighlights[existingIdx] = item;
  } else {
    nextHighlights.push(item);
  }

  const newVer = await commitAnalysisRevision({
    ctx,
    doc,
    payload: {
      summary: latest.summary,
      keyInsights: latest.keyInsights,
      improvements: latest.improvements,
      openQuestions: latest.openQuestions,
      highlights: nextHighlights,
    },
    annotatedPdfDirty: true,
    revisionReason: existingIdx >= 0 ? `Updated highlight ${item.id}` : `Added highlight on page ${item.page}`,
  });

  return {
    ok: true,
    status: 'ok',
    newVersion: newVer,
    traceSummary: `Highlight ${item.id} saved on page ${item.page} -> v${newVer.versionNumber}`,
    result: { status: 'saved', highlightId: item.id, page: item.page, versionNumber: newVer.versionNumber },
  };
}

/** Removes an existing highlight by ID and marks the annotated PDF dirty for lazy rebuild. */
async function handleDeleteHighlight({ ctx, doc, latest, args }: ToolHandlerInput): Promise<HandlerOutcome> {
  if (!latest) {
    return reject('No analysis version found.', 'No analysis version found');
  }

  const highlightId = String(args.highlightId ?? '').trim();
  const nextHighlights = latest.highlights.filter((h) => h.id !== highlightId);
  if (nextHighlights.length === latest.highlights.length) {
    return reject(`Highlight "${highlightId}" was not found.`, `Highlight ${highlightId} not found`);
  }

  const newVer = await commitAnalysisRevision({
    ctx,
    doc,
    payload: {
      summary: latest.summary,
      keyInsights: latest.keyInsights,
      improvements: latest.improvements,
      openQuestions: latest.openQuestions,
      highlights: nextHighlights,
    },
    annotatedPdfDirty: true,
    revisionReason: `Removed highlight ${highlightId}`,
  });

  return {
    ok: true,
    status: 'ok',
    newVersion: newVer,
    traceSummary: `Deleted highlight ${highlightId} -> v${newVer.versionNumber}`,
    result: { status: 'deleted', highlightId, versionNumber: newVer.versionNumber },
  };
}

/** Searches prior documents in the library by keyword/relevance for cross-referencing. */
async function handleSearchPriorReadings({ ctx, args }: ToolHandlerInput): Promise<HandlerOutcome> {
  const query = String(args.query ?? '').trim();
  const limit = Math.min(Math.max(Number(args.limit ?? 3), 1), 8);
  const retriever = new MemoryContextRetriever(ctx.db);
  const matches = retriever.findRelatedDocuments({
    excludeDocumentId: ctx.documentId,
    fallbackKeywords: query,
    limit,
  });

  return {
    ok: true,
    status: 'ok',
    traceSummary: `Found ${matches.length} prior readings for "${query}"`,
    result: {
      matches: matches.map((m) => ({
        id: m.id,
        title: m.title,
        summary: m.summary,
        createdAt: m.createdAt,
      })),
    },
  };
}

/** Persists a reusable reading preference rule in `MemoryProfile`. */
async function handleUpdateMemoryPreference({ ctx, doc, args }: ToolHandlerInput): Promise<HandlerOutcome> {
  const preferenceKey = String(args.preferenceKey ?? '')
    .trim()
    .replace(/[^a-z0-9_]/gi, '_')
    .toLowerCase();
  const rule = String(args.rule ?? '').trim();
  if (!preferenceKey || !rule) {
    return reject('Both preferenceKey and rule are required.', 'preferenceKey and rule are required');
  }

  const pref = ctx.db.upsertMemoryPreference({
    preferenceKey,
    learnedRule: rule,
    sourceEvidence: `Explicitly requested during reading "${doc.title}"`,
  });

  return {
    ok: true,
    status: 'ok',
    traceSummary: `Saved MemoryProfile preference "${preferenceKey}"`,
    result: { status: 'saved', preference: pref },
  };
}

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  update_brief_section: handleUpdateBriefSection,
  upsert_highlight: handleUpsertHighlight,
  delete_highlight: handleDeleteHighlight,
  search_prior_readings: handleSearchPriorReadings,
  update_memory_preference: handleUpdateMemoryPreference,
};

/** Dispatches a Gemini tool call, records its `ToolTrace`, and returns the execution outcome. */
export async function executeAgentTool(
  ctx: ToolExecutionContext,
  toolName: string,
  args: Record<string, unknown>
): Promise<ToolExecutionOutcome> {
  const startMs = Date.now();
  const doc = ctx.db.getDocumentById(ctx.documentId);
  if (!doc) {
    return { ok: false, result: { error: 'Document not found' } };
  }

  const latest = ctx.db.getLatestAnalysisVersion(ctx.documentId);
  const beforeVersion = latest?.versionNumber ?? null;

  const finalizeTrace = (
    status: 'ok' | 'rejected' | 'error',
    resultSummary: string,
    afterVersion: number | null
  ) => {
    ctx.db.recordToolTrace({
      documentId: ctx.documentId,
      chatMessageId: ctx.chatMessageId ?? null,
      model: ctx.model ?? PRIMARY_MODEL,
      toolName,
      rawArgsJson: JSON.stringify(args),
      status,
      resultSummary,
      beforeVersion,
      afterVersion,
      durationMs: Date.now() - startMs,
    });
  };

  try {
    const handler = TOOL_HANDLERS[toolName];
    if (!handler) {
      finalizeTrace('rejected', `Unknown tool ${toolName}`, beforeVersion);
      return { ok: false, result: { error: `Unknown tool: ${toolName}` } };
    }

    const outcome = await handler({ ctx, doc, latest, args });
    finalizeTrace(outcome.status, outcome.traceSummary, outcome.newVersion?.versionNumber ?? beforeVersion);
    return {
      ok: outcome.ok,
      result: outcome.result,
      ...(outcome.newVersion ? { newVersion: outcome.newVersion } : {}),
    };
  } catch (err) {
    const message = (err as Error).message;
    finalizeTrace('error', message, beforeVersion);
    return { ok: false, result: { error: message } };
  }
}
