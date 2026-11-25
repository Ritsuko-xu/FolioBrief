/** Custom Promptfoo provider invoking `runSideChatTurn` with an isolated SQLite DB, prior-reading RAG corpus, and temp storage. */
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FolioDatabase } from '../../server/db.ts';
import { FileStorageManager } from '../../server/storage.ts';
import { AppLogger } from '../../server/logger.ts';
import { PRIMARY_MODEL } from '../../server/ai/geminiClient.ts';
import { runSideChatTurn } from '../../server/ai/sideChatRevisionAgent.ts';
import type { AnalysisPayload, AnalysisVersion, PageIndexEntry } from '../../src/shared/types.ts';

interface ProviderOptions {
  id?: string;
  config?: {
    modelOverride?: string;
    temperature?: number;
    usePromptAsSystemInstruction?: boolean;
  };
}

interface CallContext {
  vars?: Record<string, unknown>;
}

interface PriorReadingSeed {
  title: string;
  extractedText: string;
  summary: string;
  keyInsights?: string[];
  embeddingVector?: number[];
}

interface MemoryPreferenceSeed {
  preferenceKey: string;
  learnedRule: string;
}

function buildPageIndex(rawText: string): PageIndexEntry[] {
  const matches = [...rawText.matchAll(/\[Page\s+(\d+)\]\s*([\s\S]*?)(?=\[Page\s+\d+\]|$)/gi)];
  const sections =
    matches.length > 0
      ? matches.map((m) => ({ page: Number(m[1]), body: m[2].trim() }))
      : [{ page: 1, body: rawText.trim() }];

  return sections.map(({ page, body }) => {
    const lines = body
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean);
    return {
      page,
      width: 612,
      height: 792,
      fullText: body,
      spans: lines.map((line, idx) => ({
        text: line,
        x: 48,
        y: Math.max(48, 720 - idx * 18),
        width: Math.min(516, line.length * 6),
        height: 12,
      })),
    };
  });
}

function defaultAnalysisPayload(extractedText: string): AnalysisPayload {
  const firstSentence =
    extractedText
      .replace(/\[Page\s+\d+\]\s*/gi, '')
      .split(/(?<=[.!?])\s+/)[0]
      ?.trim() || 'Sample technical reading.';
  return {
    summary: 'Initial brief summarizing the core architecture and empirical results.',
    keyInsights: ['Reduces decode latency without changing output distribution.'],
    improvements: ['Parallel token verification improves hardware utilization.'],
    openQuestions: ['How does efficiency change under larger batch sizes?'],
    highlights: [
      {
        id: 'hl-seed1',
        page: 1,
        quoteAnchor: firstSentence.slice(0, 110),
        category: 'claim',
        comment: 'Core claim from page 1',
      },
    ],
  };
}

export default class SideChatAgentProvider {
  private readonly providerId: string;
  private readonly modelOverride?: string;
  private readonly temperature?: number;
  private readonly usePromptAsSystemInstruction: boolean;

  constructor(options: ProviderOptions = {}) {
    this.providerId = options.id ?? 'foliobrief-sidechat-agent';
    this.modelOverride = options.config?.modelOverride;
    this.temperature = options.config?.temperature;
    this.usePromptAsSystemInstruction = Boolean(options.config?.usePromptAsSystemInstruction);
  }

  id(): string {
    return this.providerId;
  }

  async callApi(prompt: string, context: CallContext = {}) {
    const vars = context.vars ?? {};
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foliobrief-eval-'));

    const storage = new FileStorageManager(tmpDir);
    const logger = new AppLogger(storage.logsDir);
    const db = new FolioDatabase(path.join(tmpDir, 'foliobrief.db'), logger);

    try {
      const priorReadings = Array.isArray(vars.priorReadings)
        ? (vars.priorReadings as PriorReadingSeed[])
        : [];
      for (const prior of priorReadings) {
        const priorDoc = db.createDocument({
          title: prior.title,
          sourceType: 'url',
          sourceUrl: `https://example.org/${encodeURIComponent(prior.title.toLowerCase())}`,
          sourceDomain: 'example.org',
          jobStatus: 'ready',
          extractedText: prior.extractedText,
          pageCount: 1,
          pageIndex: buildPageIndex(prior.extractedText),
        });
        db.updateDocument(priorDoc.id, {
          embeddingVector: prior.embeddingVector ?? [0.8, 0.2, 0.1],
        });
        db.createAnalysisVersion({
          documentId: priorDoc.id,
          payload: {
            summary: prior.summary,
            keyInsights: prior.keyInsights ?? [],
            improvements: [],
            openQuestions: [],
            highlights: [],
          },
          revisionReason: 'Seeded prior reading for RAG eval',
        });
      }

      const seededPrefs = Array.isArray(vars.memoryPreferences)
        ? (vars.memoryPreferences as MemoryPreferenceSeed[])
        : [];
      for (const pref of seededPrefs) {
        db.upsertMemoryPreference({
          preferenceKey: pref.preferenceKey,
          learnedRule: pref.learnedRule,
          sourceEvidence: 'Seeded eval preference',
          confidence: 0.9,
        });
      }

      const extractedText = String(
        vars.extractedText ??
          '[Page 1]\nSpeculative decoding uses a small draft model to propose K tokens verified in parallel by a large target model.'
      );
      const pageIndex = buildPageIndex(extractedText);
      const doc = db.createDocument({
        title: String(vars.title ?? 'Speculative Decoding Paper'),
        sourceType: 'pdf',
        jobStatus: 'ready',
        extractedText,
        pageCount: pageIndex.length,
        pageIndex,
      });
      db.updateDocument(doc.id, {
        embeddingVector: Array.isArray(vars.docEmbedding)
          ? (vars.docEmbedding as number[])
          : [0.82, 0.18, 0.1],
      });

      const initialPayload: AnalysisPayload =
        vars.initialAnalysis && typeof vars.initialAnalysis === 'object'
          ? {
              ...defaultAnalysisPayload(extractedText),
              ...(vars.initialAnalysis as Partial<AnalysisPayload>),
            }
          : defaultAnalysisPayload(extractedText);

      const beforeVersion = db.createAnalysisVersion({
        documentId: doc.id,
        payload: initialPayload,
        revisionReason: 'Initial AI synthesis',
      });

      const userMessages = Array.isArray(vars.turns)
        ? vars.turns.map((t) => String(t))
        : [String(vars.userMessage ?? prompt)];

      const streamedRevisions: AnalysisVersion[] = [];
      let lastOutcome: Awaited<ReturnType<typeof runSideChatTurn>> | null = null;

      for (const message of userMessages) {
        lastOutcome = await runSideChatTurn({
          db,
          storage,
          logger,
          documentId: doc.id,
          userMessage: message,
          referencedHighlightIds: Array.isArray(vars.referencedHighlightIds)
            ? (vars.referencedHighlightIds as string[])
            : undefined,
          modelOverride: this.modelOverride,
          temperature: this.temperature,
          systemInstructionOverride:
            this.usePromptAsSystemInstruction && prompt.trim() ? prompt.trim() : undefined,
          awaitDistillation: true,
          callbacks: {
            onDelta: () => {},
            onRevision: (ver) => {
              streamedRevisions.push(ver);
            },
            onTrace: () => {},
          },
        });
      }

      const afterVersion = lastOutcome?.latestVersion ?? beforeVersion;
      const traces = db.listToolTracesByDocument(doc.id, 50);
      const mutationToolSet = new Set([
        'update_brief_section',
        'upsert_highlight',
        'delete_highlight',
      ]);

      const changedSections = {
        summary: beforeVersion.summary !== afterVersion.summary,
        keyInsights:
          JSON.stringify(beforeVersion.keyInsights) !== JSON.stringify(afterVersion.keyInsights),
        improvements:
          JSON.stringify(beforeVersion.improvements) !== JSON.stringify(afterVersion.improvements),
        openQuestions:
          JSON.stringify(beforeVersion.openQuestions) !==
          JSON.stringify(afterVersion.openQuestions),
        highlights:
          JSON.stringify(beforeVersion.highlights) !== JSON.stringify(afterVersion.highlights),
      };

      return {
        output: JSON.stringify({
          model: this.modelOverride?.trim() || PRIMARY_MODEL,
          assistantReply: lastOutcome?.assistantMessage.content ?? '',
          appliedVersionNumber: lastOutcome?.assistantMessage.appliedVersionNumber ?? null,
          beforeVersionNumber: beforeVersion.versionNumber,
          afterVersionNumber: afterVersion.versionNumber,
          revisionsCreated: streamedRevisions.length,
          toolTraces: traces.map((t) => ({
            toolName: t.toolName,
            status: t.status,
            rawArgsJson: t.rawArgsJson,
          })),
          toolNames: traces.map((t) => t.toolName),
          mutationTools: traces
            .filter((t) => mutationToolSet.has(t.toolName) && t.status === 'ok')
            .map((t) => t.toolName),
          readOnlyTools: traces
            .filter((t) => !mutationToolSet.has(t.toolName) && t.status === 'ok')
            .map((t) => t.toolName),
          changedSections,
          beforeVersion,
          afterVersion,
          memoryPreferences: db.listMemoryPreferences(),
        }),
      };
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}
