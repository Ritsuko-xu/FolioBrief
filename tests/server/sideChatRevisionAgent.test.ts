/** Tests for multi-round sideChatRevisionAgent tool calling, SSE streaming, and preference distillation (mocked Gemini SDK). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FolioDatabase } from '../../server/db.ts';
import { FileStorageManager } from '../../server/storage.ts';
import { AppLogger } from '../../server/logger.ts';

const { generateContentMock, generateContentStreamMock } = vi.hoisted(() => ({
  generateContentMock: vi.fn(),
  generateContentStreamMock: vi.fn(),
}));

vi.mock('../../server/ai/geminiClient.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/ai/geminiClient.ts')>();
  return {
    ...actual,
    createGeminiClient: () => ({
      models: {
        generateContent: generateContentMock,
        generateContentStream: generateContentStreamMock,
      },
    }),
  };
});

import {
  buildDistillPreferencePrompt,
  buildSideChatSystemInstruction,
  distillUserPreferenceFromChat,
  runSideChatTurn,
} from '../../server/ai/sideChatRevisionAgent.ts';

describe('Side-Chat & Revision Agent (runSideChatTurn & Preference Distillation)', () => {
  let tmpDir: string;
  let db: FolioDatabase;
  let storage: FileStorageManager;
  let logger: AppLogger;
  let docId: string;

  beforeEach(() => {
    generateContentMock.mockReset();
    generateContentStreamMock.mockReset();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foliobrief-chat-'));
    storage = new FileStorageManager(tmpDir);
    logger = new AppLogger(storage.logsDir);
    db = new FolioDatabase(path.join(tmpDir, 'foliobrief.db'));

    const doc = db.createDocument({
      title: 'FlashAttention-3',
      sourceType: 'pdf',
      jobStatus: 'ready',
      pageCount: 2,
      extractedText: '[Page 1]\nAsynchronous warp-specialization overlaps GEMM and softmax.',
      pageIndex: [
        {
          page: 1,
          width: 612,
          height: 792,
          fullText: 'Asynchronous warp-specialization overlaps GEMM and softmax.',
          spans: [
            {
              text: 'Asynchronous warp-specialization overlaps GEMM and softmax.',
              x: 48,
              y: 700,
              width: 320,
              height: 12,
            },
          ],
        },
      ],
    });
    docId = doc.id;

    db.createAnalysisVersion({
      documentId: docId,
      payload: {
        summary: 'Initial summary.',
        keyInsights: ['Warp specialization boosts tensor core utilization.'],
        improvements: ['FP8 block-quantization lowers error.'],
        openQuestions: ['How well does it generalize to non-Hopper GPUs?'],
        highlights: [
          {
            id: 'hl-ref1',
            page: 1,
            quoteAnchor: 'Asynchronous warp-specialization overlaps GEMM and softmax.',
            category: 'improvement',
            comment: 'Key pipelining trick',
          },
        ],
      },
      revisionReason: 'Initial AI synthesis',
    });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('answers grounded Q&A directly without creating a new revision', async () => {
    generateContentMock.mockResolvedValueOnce({
      text: 'Warp specialization overlaps matrix multiplies with softmax.',
      functionCalls: undefined,
      candidates: [],
    });

    const deltas: string[] = [];
    const revisions: number[] = [];
    const traces: string[] = [];

    const outcome = await runSideChatTurn({
      db,
      storage,
      logger,
      documentId: docId,
      userMessage: 'Explain this highlight',
      referencedHighlightIds: ['hl-ref1'],
      callbacks: {
        onDelta: (chunk) => deltas.push(chunk),
        onRevision: (ver) => revisions.push(ver.versionNumber),
        onTrace: (t) => traces.push(t.toolName),
      },
    });

    expect(deltas.join('')).toBe('Warp specialization overlaps matrix multiplies with softmax.');
    expect(revisions).toEqual([]);
    expect(traces).toEqual([]);
    expect(outcome.assistantMessage.appliedVersionNumber).toBeNull();
    expect(outcome.latestVersion?.versionNumber).toBe(1);

    const callArgs = generateContentMock.mock.calls[0][0] as {
      config: { systemInstruction: string };
    };
    expect(callArgs.config.systemInstruction).toContain('USER REFERENCED HIGHLIGHTS');
    expect(callArgs.config.systemInstruction).toContain('hl-ref1');

    const messages = db.listChatMessages(docId);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('executes tool calls across rounds, streams revision + trace, and distills preference', async () => {
    generateContentMock
      // Round 1: model emits a tool call
      .mockResolvedValueOnce({
        functionCalls: [
          {
            id: 'call-1',
            name: 'update_brief_section',
            args: {
              section: 'openQuestions',
              operation: 'append_item',
              content: 'What is the kernel occupancy on Blackwell?',
            },
          },
        ],
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: 'Calling tool...' }],
            },
          },
        ],
      })
      // Round 2: final reply after receiving tool response
      .mockResolvedValueOnce({
        text: 'Added the Blackwell occupancy question.',
        functionCalls: undefined,
        candidates: [],
      })
      // Background distillUserPreferenceFromChat call
      .mockResolvedValueOnce({
        text: JSON.stringify({
          shouldSave: true,
          preferenceKey: 'hardware_focus',
          learnedRule: 'Include GPU architecture occupancy details in open questions.',
        }),
      });

    const revisions: number[] = [];
    const traceNames: string[] = [];

    const outcome = await runSideChatTurn({
      db,
      storage,
      logger,
      documentId: docId,
      userMessage: 'Always check GPU architecture occupancy in open questions',
      callbacks: {
        onDelta: () => {},
        onRevision: (ver) => revisions.push(ver.versionNumber),
        onTrace: (t) => traceNames.push(t.toolName),
      },
    });

    expect(revisions).toEqual([2]);
    expect(traceNames).toEqual(['update_brief_section']);
    expect(outcome.latestVersion?.versionNumber).toBe(2);
    expect(outcome.latestVersion?.openQuestions).toContain('What is the kernel occupancy on Blackwell?');
    expect(outcome.assistantMessage.appliedVersionNumber).toBe(2);

    // Wait briefly for fire-and-forget preference distillation promise to settle
    await new Promise((r) => setTimeout(r, 25));
    const prefs = db.listMemoryPreferences();
    expect(prefs.some((p) => p.preferenceKey === 'hardware_focus')).toBe(true);
  });

  it('falls back to generateContentStream if 3 tool rounds finish without text', async () => {
    const toolResponse = {
      functionCalls: [
        {
          id: 'call-loop',
          name: 'search_prior_readings',
          args: { query: 'FlashAttention', limit: 2 },
        },
      ],
      candidates: [{ content: { role: 'model', parts: [{ text: '' }] } }],
    };
    generateContentMock
      .mockResolvedValueOnce(toolResponse)
      .mockResolvedValueOnce(toolResponse)
      .mockResolvedValueOnce(toolResponse);

    generateContentStreamMock.mockResolvedValueOnce(
      (async function* () {
        yield { text: 'Fallback ' };
        yield { text: 'streamed reply.' };
      })()
    );

    const deltas: string[] = [];
    const outcome = await runSideChatTurn({
      db,
      storage,
      logger,
      documentId: docId,
      userMessage: 'Compare with prior readings',
      callbacks: {
        onDelta: (c) => deltas.push(c),
        onRevision: () => {},
        onTrace: () => {},
      },
    });

    expect(generateContentStreamMock).toHaveBeenCalledTimes(1);
    expect(deltas.join('')).toBe('Fallback streamed reply.');
    expect(outcome.assistantMessage.content).toBe('Fallback streamed reply.');
  });

  it('returns null when shouldSave is false or JSON is invalid in distillUserPreferenceFromChat, and throws on missing doc', async () => {
    generateContentMock.mockResolvedValueOnce({
      text: JSON.stringify({ shouldSave: false, preferenceKey: 'x', learnedRule: 'y' }),
    });
    expect(
      await distillUserPreferenceFromChat({
        userInstruction: 'Fix typo',
        toolUsed: 'update_brief_section',
      })
    ).toBeNull();

    generateContentMock.mockResolvedValueOnce({ text: 'not-json' });
    const pref = await distillUserPreferenceFromChat({
      userInstruction: 'Fix typo',
      toolUsed: 'update_brief_section',
    });
    expect(pref).toBeNull();

    await expect(
      runSideChatTurn({
        db,
        storage,
        logger,
        documentId: 'missing-doc-id',
        userMessage: 'hi',
        callbacks: { onDelta: () => {}, onRevision: () => {}, onTrace: () => {} },
      })
    ).rejects.toThrow('Document not found.');
  });

  it('passes rejected tool outcomes back to Gemini so the conversation still finishes cleanly', async () => {
    generateContentMock
      .mockResolvedValueOnce({
        functionCalls: [
          {
            id: 'call-bad',
            name: 'delete_highlight',
            args: { highlightId: 'hl-does-not-exist' },
          },
        ],
        candidates: [{ content: { role: 'model', parts: [{ text: '' }] } }],
      })
      .mockResolvedValueOnce({
        text: 'That highlight ID was not found, so nothing was deleted.',
        functionCalls: undefined,
        candidates: [],
      });

    const traces: Array<{ toolName: string; status: string }> = [];
    const outcome = await runSideChatTurn({
      db,
      storage,
      logger,
      documentId: docId,
      userMessage: 'Delete missing highlight',
      callbacks: {
        onDelta: () => {},
        onRevision: () => {},
        onTrace: (t) => traces.push({ toolName: t.toolName, status: t.status }),
      },
    });

    expect(traces).toEqual([{ toolName: 'delete_highlight', status: 'rejected' }]);
    expect(outcome.latestVersion?.versionNumber).toBe(1);
    expect(outcome.assistantMessage.content).toContain('not found');
  });

  it('supports eval overrides (modelOverride, temperature, systemInstructionOverride, promptOverride, awaitDistillation)', async () => {
    const builtChatPrompt = buildSideChatSystemInstruction({
      title: 'Paper X',
      pageCount: 3,
      extractedText: 'Body excerpt.',
      latestVersion: null,
      memoryPromptBlock: 'User Pref Block',
    });
    expect(builtChatPrompt).toContain('DOCUMENT TITLE: Paper X (3 pages)');
    expect(builtChatPrompt).toContain('User Pref Block');

    const builtDistillPrompt = buildDistillPreferencePrompt({
      userInstruction: 'Include latency numbers.',
      toolUsed: 'update_brief_section',
    });
    expect(builtDistillPrompt).toContain('Include latency numbers.');

    generateContentMock
      .mockResolvedValueOnce({
        functionCalls: [
          {
            id: 'call-eval',
            name: 'update_brief_section',
            args: { section: 'summary', operation: 'replace_section', content: 'Updated summary.' },
          },
        ],
        candidates: [{ content: { role: 'model', parts: [{ text: '' }] } }],
      })
      .mockResolvedValueOnce({
        text: 'Summary updated.',
        functionCalls: undefined,
        candidates: [],
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          shouldSave: true,
          preferenceKey: 'sync_eval_rule',
          learnedRule: 'Persist synchronously when awaitDistillation is true.',
        }),
      });

    await runSideChatTurn({
      db,
      storage,
      logger,
      documentId: docId,
      userMessage: 'Rewrite summary concisely',
      modelOverride: 'gemini-eval-model',
      temperature: 0,
      systemInstructionOverride: 'Custom agent prompt override',
      awaitDistillation: true,
      callbacks: { onDelta: () => {}, onRevision: () => {}, onTrace: () => {} },
    });

    // Because awaitDistillation is true, memory preference must exist immediately without any timer wait
    expect(db.listMemoryPreferences().some((p) => p.preferenceKey === 'sync_eval_rule')).toBe(true);

    const firstCall = generateContentMock.mock.calls[0][0] as {
      model: string;
      config: { systemInstruction: string; temperature?: number };
    };
    expect(firstCall.model).toBe('gemini-eval-model');
    expect(firstCall.config.temperature).toBe(0);
    expect(firstCall.config.systemInstruction).toBe('Custom agent prompt override');

    const trace = db.listToolTracesByDocument(docId, 1)[0];
    expect(trace.model).toBe('gemini-eval-model');

    generateContentMock.mockResolvedValueOnce({
      text: JSON.stringify({ shouldSave: true, preferenceKey: 'custom_key', learnedRule: 'Custom rule.' }),
    });
    const customPref = await distillUserPreferenceFromChat({
      userInstruction: 'ignored when promptOverride passed',
      toolUsed: 'update_brief_section',
      modelOverride: 'gemini-fast-eval',
      temperature: 0,
      promptOverride: 'Custom distill prompt',
    });
    expect(customPref).toEqual({ preferenceKey: 'custom_key', learnedRule: 'Custom rule.' });

    const distillCall = generateContentMock.mock.calls[3][0] as {
      model: string;
      contents: string;
      config: { temperature?: number };
    };
    expect(distillCall.model).toBe('gemini-fast-eval');
    expect(distillCall.contents).toBe('Custom distill prompt');
    expect(distillCall.config.temperature).toBe(0);
  });
});
