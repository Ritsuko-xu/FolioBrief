/** Unit tests for documentSynthesisAgent structured brief, highlight, and fallback handling (mocked Gemini SDK). */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PageIndexEntry } from '../../src/shared/types.ts';

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
      },
    }),
  };
});

import {
  buildDocumentSynthesisSystemInstruction,
  synthesizeDocumentAnalysis,
} from '../../server/ai/documentSynthesisAgent.ts';

const samplePageIndex: PageIndexEntry[] = [
  {
    page: 1,
    width: 612,
    height: 792,
    fullText: 'Speculative decoding accelerates autoregressive inference without changing output distribution.',
    spans: [
      {
        text: 'Speculative decoding accelerates autoregressive inference without changing output distribution.',
        x: 48,
        y: 710,
        width: 420,
        height: 12,
      },
    ],
  },
  {
    page: 2,
    width: 612,
    height: 792,
    fullText: 'Draft models verify multiple tokens in parallel using a single target forward pass.',
    spans: [
      {
        text: 'Draft models verify multiple tokens in parallel using a single target forward pass.',
        x: 48,
        y: 680,
        width: 410,
        height: 12,
      },
    ],
  },
];

describe('Initial Document Synthesis Agent (synthesizeDocumentAnalysis)', () => {
  beforeEach(() => {
    generateContentMock.mockReset();
  });

  it('caps highlights, filters short anchors, clamps page numbers, normalizes categories, and resolves rects', async () => {
    // 2 pages -> computeConciseHighlightCap(2) === 4
    generateContentMock.mockResolvedValueOnce({
      text: JSON.stringify({
        summary: '  Executive overview of draft-target decoding.  ',
        keyInsights: ['  Lossless speedup  ', ''],
        improvements: ['Parallel token verification'],
        openQuestions: ['How does acceptance rate degrade at high temperature?'],
        highlights: [
          {
            page: 99, // clamped to 2, or relocated by findQuoteRects
            quoteAnchor: 'Speculative decoding accelerates autoregressive inference',
            category: 'claim',
            comment: ' Core guarantee ',
          },
          {
            page: 2,
            quoteAnchor: 'Draft models verify multiple tokens in parallel',
            category: 'improvement',
            comment: 'Verification step',
          },
          {
            page: 0, // clamped to 1
            quoteAnchor: 'invalid-anchor-not-in-page-text',
            category: 'unknown-cat', // normalized to 'claim'
            comment: 'Fallback cat check',
          },
          {
            page: 1,
            quoteAnchor: 'tiny', // <= 4 chars, filtered out
            category: 'question',
            comment: 'Should be dropped',
          },
          {
            page: 2,
            quoteAnchor: 'using a single target forward pass.',
            category: 'question',
            comment: '4th raw item within slice',
          },
          {
            page: 2,
            quoteAnchor: 'multiple tokens in parallel', // 5th raw item -> sliced off by cap=4
            category: 'claim',
            comment: 'Exceeds cap',
          },
        ],
      }),
    });

    const payload = await synthesizeDocumentAnalysis({
      title: 'Fast Inference with Draft Models',
      extractedText: samplePageIndex.map((p) => `[Page ${p.page}]\n${p.fullText}`).join('\n\n'),
      pageIndex: samplePageIndex,
    });

    expect(payload.summary).toBe('Executive overview of draft-target decoding.');
    expect(payload.keyInsights).toEqual(['Lossless speedup']);
    expect(payload.improvements).toEqual(['Parallel token verification']);
    expect(payload.openQuestions).toEqual(['How does acceptance rate degrade at high temperature?']);

    // 4 raw highlights kept -> 'tiny' filtered -> 3 highlights returned
    expect(payload.highlights.length).toBe(3);
    expect(payload.highlights[0].page).toBe(1);
    expect(payload.highlights[0].rects?.length).toBeGreaterThan(0);
    expect(payload.highlights[0].comment).toBe('Core guarantee');
    expect(payload.highlights[1].category).toBe('improvement');
    expect(payload.highlights[2].page).toBe(1);
    expect(payload.highlights[2].category).toBe('claim');
  });

  it('truncates documents over 160,000 chars and injects memoryContextBlock into systemInstruction', async () => {
    generateContentMock.mockResolvedValueOnce({
      text: JSON.stringify({
        summary: 'Truncated doc summary.',
        keyInsights: [],
        improvements: [],
        openQuestions: [],
        highlights: [],
      }),
    });

    const headMarker = 'HEAD_SECTION_MARKER_';
    const tailMarker = '_TAIL_SECTION_MARKER';
    const oversizedText = headMarker + 'A'.repeat(180_000) + tailMarker;

    await synthesizeDocumentAnalysis({
      title: 'Long Monograph',
      extractedText: oversizedText,
      pageIndex: samplePageIndex,
      memoryContextBlock: 'Focus on memory-bandwidth bottlenecks.',
    });

    const callArg = generateContentMock.mock.calls[0][0] as {
      contents: string;
      config: { systemInstruction: string };
    };
    expect(callArg.contents).toContain(headMarker);
    expect(callArg.contents).toContain('[... middle excerpt omitted for length ...]');
    expect(callArg.contents).toContain(tailMarker);
    expect(callArg.contents.length).toBeLessThan(160_000);
    expect(callArg.config.systemInstruction).toContain('Personal Context:\nFocus on memory-bandwidth bottlenecks.');
  });

  it('uses fallback summary on empty fields or missing response text, handles empty pageIndex, and throws on malformed JSON', async () => {
    generateContentMock.mockResolvedValueOnce({
      text: undefined,
    });

    const fallback = await synthesizeDocumentAnalysis({
      title: 'Empty Output',
      extractedText: 'Short sample.',
      pageIndex: [],
    });
    expect(fallback.summary).toBe('No summary generated.');
    expect(fallback.keyInsights).toEqual([]);
    expect(fallback.highlights).toEqual([]);

    generateContentMock.mockResolvedValueOnce({
      text: 'not-valid-json',
    });
    await expect(
      synthesizeDocumentAnalysis({
        title: 'Bad JSON',
        extractedText: 'Short sample.',
        pageIndex: samplePageIndex,
      })
    ).rejects.toThrow();
  });

  it('applies optional modelOverride, temperature, and systemInstructionOverride for evals', async () => {
    const defaultPrompt = buildDocumentSynthesisSystemInstruction({
      maxHighlights: 5,
      memoryContextBlock: 'Prioritize latency numbers.',
    });
    expect(defaultPrompt).toContain('most pivotal 5 or fewer passages');
    expect(defaultPrompt).toContain('Prioritize latency numbers.');

    generateContentMock.mockResolvedValueOnce({
      text: JSON.stringify({
        summary: 'Override run summary.',
        keyInsights: ['Insight A'],
        improvements: [],
        openQuestions: [],
        highlights: [],
      }),
    });

    await synthesizeDocumentAnalysis({
      title: 'Override Test',
      extractedText: 'Sample text.',
      pageIndex: samplePageIndex,
      modelOverride: 'gemini-custom-eval',
      temperature: 0,
      systemInstructionOverride: 'Custom A/B test instruction',
    });

    const callArg = generateContentMock.mock.calls[0][0] as {
      model: string;
      config: { systemInstruction: string; temperature?: number };
    };
    expect(callArg.model).toBe('gemini-custom-eval');
    expect(callArg.config.temperature).toBe(0);
    expect(callArg.config.systemInstruction).toBe('Custom A/B test instruction');
  });
});
