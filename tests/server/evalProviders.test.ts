/** Contract tests for Promptfoo custom TypeScript providers and eval config loading (mocked Gemini SDK). */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadApiProvider } from 'promptfoo';

const { generateContentMock } = vi.hoisted(() => ({
  generateContentMock: vi.fn(),
}));

vi.mock('../../server/ai/geminiClient.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/ai/geminiClient.ts')>();
  return {
    ...actual,
    createGeminiClient: () => ({
      models: {
        generateContent: generateContentMock,
        generateContentStream: vi.fn(),
      },
    }),
  };
});

import SynthesisProvider from '../../evals/providers/synthesisProvider.ts';
import SideChatAgentProvider from '../../evals/providers/sideChatAgentProvider.ts';
import DistillPreferenceProvider from '../../evals/providers/distillPreferenceProvider.ts';

describe('Promptfoo Custom Providers & Eval Configs', () => {
  beforeEach(() => {
    generateContentMock.mockReset();
  });

  it('SynthesisProvider invokes synthesizeDocumentAnalysis and computes verbatim quote match diagnostics', async () => {
    generateContentMock.mockResolvedValueOnce({
      text: JSON.stringify({
        summary: 'Speculative decoding speeds up generation by 2.3x.',
        keyInsights: ['Uses a draft model and parallel verification.'],
        improvements: ['Lossless output distribution matching.'],
        openQuestions: ['What happens past batch size 16?'],
        highlights: [
          {
            page: 1,
            quoteAnchor: 'Speculative decoding uses a small draft model',
            category: 'claim',
            comment: 'Core idea',
          },
          {
            page: 1,
            quoteAnchor: 'paraphrased quote not present verbatim',
            category: 'question',
            comment: 'Unmatched',
          },
        ],
      }),
    });

    const provider = new SynthesisProvider({
      id: 'synth-eval',
      config: { modelOverride: 'gemini-4-hydrogen', temperature: 0 },
    });
    expect(provider.id()).toBe('synth-eval');

    const res = await provider.callApi('USE_DEFAULT_SYSTEM_PROMPT', {
      vars: {
        title: 'Speculative Decoding',
        article_excerpt:
          '[Page 1]\nSpeculative decoding uses a small draft model to propose K tokens verified in parallel.',
      },
    });

    const parsed = JSON.parse(res.output);
    expect(parsed._eval.model).toBe('gemini-4-hydrogen');
    expect(parsed._eval.highlightCap).toBe(4);
    expect(parsed._eval.totalHighlights).toBe(2);
    expect(parsed._eval.verbatimMatchedCount).toBe(1);

    const callArg = generateContentMock.mock.calls[0][0] as {
      config: { systemInstruction: string; temperature?: number };
    };
    expect(callArg.config.temperature).toBe(0);
    expect(callArg.config.systemInstruction).toContain('You are FolioBrief');
  });

  it('SideChatAgentProvider seeds prior RAG readings, awaits distillation, and reports scoped section diffs', async () => {
    generateContentMock
      .mockResolvedValueOnce({
        functionCalls: [
          {
            id: 'call-1',
            name: 'update_brief_section',
            args: {
              section: 'openQuestions',
              operation: 'replace_section',
              content: ['How does KV-cache bandwidth affect concurrency?'],
            },
          },
        ],
        candidates: [{ content: { role: 'model', parts: [{ text: '' }] } }],
      })
      .mockResolvedValueOnce({
        text: 'Updated openQuestions only.',
        functionCalls: undefined,
        candidates: [],
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          shouldSave: true,
          preferenceKey: 'kv_bandwidth_focus',
          learnedRule: 'Prioritize KV-cache bandwidth bottlenecks in open questions.',
        }),
      });

    const provider = new SideChatAgentProvider({
      config: { modelOverride: 'gemini-4-hydrogen', temperature: 0 },
    });

    const res = await provider.callApi('Update openQuestions', {
      vars: {
        title: 'Draft Model Serving',
        extractedText: '[Page 1]\nKV-cache bandwidth governs batch throughput.',
        priorReadings: [
          {
            title: 'PagedAttention',
            extractedText: 'PagedAttention avoids KV fragmentation.',
            summary: 'Block-based KV management.',
          },
        ],
        userMessage: 'Rewrite ONLY openQuestions for KV-cache bandwidth.',
      },
    });

    const parsed = JSON.parse(res.output);
    expect(parsed.mutationTools).toEqual(['update_brief_section']);
    expect(parsed.changedSections.openQuestions).toBe(true);
    expect(parsed.changedSections.summary).toBe(false);
    expect(parsed.changedSections.keyInsights).toBe(false);
    expect(parsed.changedSections.highlights).toBe(false);
    expect(parsed.memoryPreferences.some((p: { preferenceKey: string }) => p.preferenceKey === 'kv_bandwidth_focus')).toBe(
      true
    );
  });

  it('DistillPreferenceProvider returns structured shouldSave classification', async () => {
    generateContentMock.mockResolvedValueOnce({
      text: JSON.stringify({ shouldSave: false }),
    });

    const provider = new DistillPreferenceProvider({
      config: { modelOverride: 'gemini-3.1-flash-lite', temperature: 0 },
    });

    const res = await provider.callApi('USE_DEFAULT_PROMPT', {
      vars: {
        userInstruction: 'Fix typo in bullet 1.',
        toolUsed: 'update_brief_section',
      },
    });

    expect(JSON.parse(res.output)).toEqual({
      model: 'gemini-3.1-flash-lite',
      shouldSave: false,
      preferenceKey: null,
      learnedRule: null,
    });
  });

  it('Promptfoo loadApiProvider resolves all custom provider files and eval YAML configs exist', async () => {
    const providerPaths = [
      'file://evals/providers/synthesisProvider.ts',
      'file://evals/providers/sideChatAgentProvider.ts',
      'file://evals/providers/distillPreferenceProvider.ts',
    ];

    for (const p of providerPaths) {
      const loaded = await loadApiProvider(p, { basePath: process.cwd() });
      expect(typeof loaded.callApi).toBe('function');
    }

    for (const yamlName of [
      'promptfooconfig.yaml',
      'sidechat.promptfooconfig.yaml',
      'distillation.promptfooconfig.yaml',
    ]) {
      const fullPath = path.join(process.cwd(), 'evals', yamlName);
      expect(fs.existsSync(fullPath)).toBe(true);
    }
  });
});
