/**
 * Side-Chat & Revision Agent: on-demand multi-round tool-calling loop for Q&A, versioned brief/highlight
 * edits (`v2+`), SSE streaming, and background preference distillation.
 */
import { Type, type Content } from '@google/genai';
import type { AnalysisVersion, ChatMessage, ToolTraceRecord } from '../../src/shared/types.ts';
import type { FolioDatabase } from '../db.ts';
import type { FileStorageManager } from '../storage.ts';
import type { AppLogger } from '../logger.ts';
import { MemoryContextRetriever } from '../memory/retriever.ts';
import {
  createGeminiClient,
  FAST_MEMORY_MODEL,
  PRIMARY_MODEL,
  withRetry,
} from './geminiClient.ts';
import { AGENT_TOOL_DECLARATIONS, executeAgentTool } from './agentTools.ts';

export interface ChatStreamCallbacks {
  onDelta: (textChunk: string) => void;
  onRevision: (version: AnalysisVersion) => void;
  onTrace: (trace: ToolTraceRecord) => void;
}

/** Builds the default prompt for extracting a generalizable reading preference from a chat edit. */
export function buildDistillPreferencePrompt(input: {
  userInstruction: string;
  toolUsed: string;
}): string {
  return `A user gave this revision instruction while reading a paper: "${input.userInstruction}" (tool executed: ${input.toolUsed}).
Decide whether this expresses a durable, generalizable reading or analysis preference that should apply to FUTURE unrelated articles.

Return shouldSave=false for:
- Typo, spelling, capitalization, punctuation, or entity-name fixes (e.g., "Change 'GPT4' to 'GPT-4' in bullet #2")
- Local edits to a single bullet, highlight, or section that only fix or reword content in THIS paper without stating a reusable rule
- Deleting or tweaking one redundant item in this document

Return shouldSave=true ONLY when the user states or clearly implies a standing cross-paper preference (e.g., "For future papers, always include dataset sample sizes", "Keep summaries concise", "Focus open questions on latency and memory bottlenecks").
When shouldSave=true, extract a short snake_case preferenceKey and a 1-sentence learnedRule.`;
}

/** Extracts a generalizable reading preference rule from a chat revision instruction, or `null`. */
export async function distillUserPreferenceFromChat(input: {
  userInstruction: string;
  toolUsed: string;
  modelOverride?: string;
  temperature?: number;
  promptOverride?: string;
  throwOnError?: boolean;
}): Promise<{ preferenceKey: string; learnedRule: string } | null> {
  try {
    const ai = createGeminiClient();
    const model = input.modelOverride?.trim() || FAST_MEMORY_MODEL;
    const response = await withRetry(
      () =>
        ai.models.generateContent({
          model,
          contents: input.promptOverride ?? buildDistillPreferencePrompt(input),
          config: {
            ...(typeof input.temperature === 'number' ? { temperature: input.temperature } : {}),
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                shouldSave: { type: Type.BOOLEAN },
                preferenceKey: { type: Type.STRING },
                learnedRule: { type: Type.STRING },
              },
              required: ['shouldSave'],
            },
          },
        }),
      5
    );
    const parsed = JSON.parse((response.text ?? '{}').trim()) as {
      shouldSave?: boolean;
      preferenceKey?: string;
      learnedRule?: string;
    };
    if (parsed.shouldSave && parsed.preferenceKey && parsed.learnedRule) {
      return {
        preferenceKey: parsed.preferenceKey.replace(/[^a-z0-9_]/gi, '_').toLowerCase().slice(0, 48),
        learnedRule: parsed.learnedRule.trim(),
      };
    }
    return null;
  } catch (err) {
    if (input.throwOnError) {
      throw err;
    }
    return null;
  }
}

/** Builds the default system instruction for the grounded Side-Chat & Revision Agent. */
export function buildSideChatSystemInstruction(input: {
  title: string;
  pageCount: number;
  extractedText: string;
  latestVersion: AnalysisVersion | null;
  referencedNotes?: string;
  memoryPromptBlock?: string;
}): string {
  return [
    'You are the FolioBrief Side-Chat & Revision Assistant.',
    'Answer user questions clearly using grounded evidence from the paper/article, the active Executive Brief, and active Highlights.',
    'When the user asks you to MODIFY, REWRITE, ADD, or DELETE any part of the summary, keyInsights, improvements, openQuestions, or highlights, you MUST call the corresponding tool (`update_brief_section`, `upsert_highlight`, or `delete_highlight`) rather than only replying with text.',
    'Only modify the exact section or highlight requested; preserve all untouched sections.',
    'If the user expresses a standing preference for future papers, also call `update_memory_preference`.',
    '',
    `DOCUMENT TITLE: ${input.title} (${input.pageCount} pages)`,
    input.latestVersion
      ? `ACTIVE ANALYSIS (v${input.latestVersion.versionNumber}):\n${JSON.stringify(
          {
            summary: input.latestVersion.summary,
            keyInsights: input.latestVersion.keyInsights,
            improvements: input.latestVersion.improvements,
            openQuestions: input.latestVersion.openQuestions,
            highlights: input.latestVersion.highlights.map((h) => ({
              id: h.id,
              page: h.page,
              category: h.category,
              quoteAnchor: h.quoteAnchor,
              comment: h.comment,
            })),
          },
          null,
          2
        )}`
      : 'No active analysis version yet.',
    input.referencedNotes ? `\nUSER REFERENCED HIGHLIGHTS:\n${input.referencedNotes}` : '',
    input.memoryPromptBlock ? `\n${input.memoryPromptBlock}` : '',
    `\nSOURCE TEXT EXCERPT:\n${input.extractedText.slice(0, 85_000)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Runs a multi-round grounded chat turn with tool execution, SSE delta streaming, and preference distillation. */
export async function runSideChatTurn(input: {
  db: FolioDatabase;
  storage: FileStorageManager;
  logger: AppLogger;
  documentId: string;
  userMessage: string;
  referencedHighlightIds?: string[];
  callbacks: ChatStreamCallbacks;
  modelOverride?: string;
  temperature?: number;
  systemInstructionOverride?: string;
  awaitDistillation?: boolean;
}): Promise<{ assistantMessage: ChatMessage; latestVersion: AnalysisVersion | null }> {
  const doc = input.db.getDocumentById(input.documentId);
  if (!doc) {
    throw new Error('Document not found.');
  }

  const latestVersion = input.db.getLatestAnalysisVersion(input.documentId);
  const history = input.db.listChatMessages(input.documentId);
  const model = input.modelOverride?.trim() || PRIMARY_MODEL;

  input.db.addChatMessage({
    documentId: input.documentId,
    role: 'user',
    content: input.userMessage,
    referencedHighlightIds: input.referencedHighlightIds ?? [],
  });

  const retriever = new MemoryContextRetriever(input.db);
  const memoryCtx = retriever.buildPersonalizedContextBlock({
    excludeDocumentId: doc.id,
    queryEmbedding: doc.embeddingVector,
    fallbackKeywords: doc.title,
  });

  const referencedNotes =
    latestVersion && input.referencedHighlightIds?.length
      ? latestVersion.highlights
          .filter((h) => input.referencedHighlightIds!.includes(h.id))
          .map((h) => `- [${h.id} | Page ${h.page} | ${h.category}] "${h.quoteAnchor}" -> ${h.comment}`)
          .join('\n')
      : '';

  const systemInstruction =
    input.systemInstructionOverride ??
    buildSideChatSystemInstruction({
      title: doc.title,
      pageCount: doc.pageCount,
      extractedText: doc.extractedText,
      latestVersion,
      referencedNotes,
      memoryPromptBlock: memoryCtx.promptBlock,
    });

  const recentTurns = history.slice(-10);
  const contents: Content[] = recentTurns.map((msg) => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: msg.content }],
  }));
  contents.push({
    role: 'user',
    parts: [{ text: input.userMessage }],
  });

  const ai = createGeminiClient();
  let currentVersion: AnalysisVersion | null = latestVersion;
  let finalReplyText = '';
  let executedMutationTool: string | null = null;

  // Up to 3 tool-execution rounds before final natural-language answer
  for (let round = 0; round < 3; round += 1) {
    const response = await withRetry(() =>
      ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction,
          ...(typeof input.temperature === 'number' ? { temperature: input.temperature } : {}),
          tools: [{ functionDeclarations: AGENT_TOOL_DECLARATIONS }],
        },
      })
    );

    const functionCalls = response.functionCalls;
    const candidateContent = response.candidates?.[0]?.content;

    if (functionCalls && functionCalls.length > 0 && candidateContent) {
      contents.push(candidateContent);
      const functionResponseParts = [];

      for (const call of functionCalls) {
        const toolName = call.name ?? '';
        const args = (call.args ?? {}) as Record<string, unknown>;
        const outcome = await executeAgentTool(
          {
            db: input.db,
            storage: input.storage,
            documentId: doc.id,
            model,
          },
          toolName,
          args
        );

        if (outcome.newVersion) {
          currentVersion = outcome.newVersion;
          executedMutationTool = toolName;
          input.callbacks.onRevision(outcome.newVersion);
        }

        const latestTrace = input.db.listToolTracesByDocument(doc.id, 1)[0];
        if (latestTrace) {
          input.callbacks.onTrace(latestTrace);
        }

        functionResponseParts.push({
          functionResponse: {
            id: call.id,
            name: toolName,
            response: outcome.result,
          },
        });
      }

      contents.push({
        role: 'user',
        parts: functionResponseParts,
      });
      continue;
    }

    // Stream final answer cleanly if no further tool calls
    finalReplyText = (response.text ?? '').trim();
    if (!finalReplyText) {
      finalReplyText = 'Completed the requested update.';
    }

    // Stream word chunks smoothly to client
    const chunks = finalReplyText.match(/\S+\s*/g) ?? [finalReplyText];
    for (const chunk of chunks) {
      input.callbacks.onDelta(chunk);
    }
    break;
  }

  // Fallback if loop exhausted
  if (!finalReplyText) {
    const stream = await withRetry(() =>
      ai.models.generateContentStream({
        model,
        contents,
        config: {
          systemInstruction,
          ...(typeof input.temperature === 'number' ? { temperature: input.temperature } : {}),
        },
      })
    );
    for await (const chunk of stream) {
      const text = chunk.text ?? '';
      if (text) {
        finalReplyText += text;
        input.callbacks.onDelta(text);
      }
    }
  }

  const assistantMessage = input.db.addChatMessage({
    documentId: doc.id,
    role: 'assistant',
    content: finalReplyText,
    referencedHighlightIds: input.referencedHighlightIds ?? [],
    appliedVersionNumber:
      currentVersion && latestVersion && currentVersion.versionNumber !== latestVersion.versionNumber
        ? currentVersion.versionNumber
        : null,
  });

  // Distill reusable preference if a revision tool was invoked (fire-and-forget by default, awaitable in evals)
  if (executedMutationTool) {
    const distillationTask = distillUserPreferenceFromChat({
      userInstruction: input.userMessage,
      toolUsed: executedMutationTool,
      temperature: input.temperature,
    })
      .then((pref) => {
        if (pref) {
          input.db.upsertMemoryPreference({
            preferenceKey: pref.preferenceKey,
            learnedRule: pref.learnedRule,
            sourceEvidence: `Inferred from chat edit on "${doc.title}"`,
            confidence: 0.75,
          });
          input.logger.info('memory', 'Distilled reading preference from chat edit', {
            preferenceKey: pref.preferenceKey,
          });
        }
      })
      .catch(() => {
        // Non-critical background task
      });

    if (input.awaitDistillation) {
      await distillationTask;
    } else {
      void distillationTask;
    }
  }

  return {
    assistantMessage,
    latestVersion: currentVersion,
  };
}
