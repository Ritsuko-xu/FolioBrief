/**
 * Initial Document Synthesis Agent: single-shot structured JSON call run once on ingest to produce the `v1`
 * Executive Brief and verbatim highlight quotes (PDF drawing itself is handled deterministically in `pdf/generator.ts`).
 */
import { ThinkingLevel, Type } from '@google/genai';
import crypto from 'node:crypto';
import type { AnalysisPayload, HighlightCategory, HighlightItem, PageIndexEntry } from '../../src/shared/types.ts';
import { findQuoteRects } from '../pdf/extractor.ts';
import {
  computeConciseHighlightCap,
  createGeminiClient,
  PRIMARY_MODEL,
  withRetry,
} from './geminiClient.ts';

/** Builds the default system instruction for initial single-shot document synthesis. */
export function buildDocumentSynthesisSystemInstruction(input: {
  maxHighlights: number;
  memoryContextBlock?: string;
}): string {
  return [
    'You are FolioBrief, a sharp senior research & engineering reading assistant.',
    'Produce a crisp, high-signal synthesis of the provided paper or article.',
    'Rules:',
    '1. Summary: 1 concise executive paragraph (3-5 sentences) capturing the core problem, approach, and verdict.',
    '2. Key Insights: 3-6 crisp, concrete bullet points.',
    '3. Improvements: 2-5 bullet points detailing novel contributions, benchmarks, or improvements over prior work (state explicitly if an opinion/news piece contributes a new framework or reframing).',
    '4. Open-Ended Questions: 2-4 thought-provoking open questions, gaps, or limitations worth investigating.',
    `5. Concise Highlights: Select ONLY the most pivotal ${input.maxHighlights} or fewer passages across the entire document. Do NOT highlight everything. Each quoteAnchor MUST be an exact verbatim 6-20 word substring copied directly from the [Page N] text so it can be highlighted accurately in the PDF.`,
    input.memoryContextBlock ? `\nPersonal Context:\n${input.memoryContextBlock}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Generates structured Executive Brief sections and grounded PDF highlights via single-shot Gemini synthesis. */
export async function synthesizeDocumentAnalysis(input: {
  title: string;
  extractedText: string;
  pageIndex: PageIndexEntry[];
  memoryContextBlock?: string;
  modelOverride?: string;
  temperature?: number;
  systemInstructionOverride?: string;
}): Promise<AnalysisPayload> {
  const ai = createGeminiClient();
  const pageCount = Math.max(1, input.pageIndex.length);
  const maxHighlights = computeConciseHighlightCap(pageCount);
  const model = input.modelOverride?.trim() || PRIMARY_MODEL;

  // Trim ultra-long documents safely while preserving beginning, middle, and conclusion
  const raw = input.extractedText;
  const maxChars = 160_000;
  const textForPrompt =
    raw.length <= maxChars
      ? raw
      : `${raw.slice(0, 95_000)}\n\n[... middle excerpt omitted for length ...]\n\n${raw.slice(-55_000)}`;

  const systemInstruction =
    input.systemInstructionOverride ??
    buildDocumentSynthesisSystemInstruction({
      maxHighlights,
      memoryContextBlock: input.memoryContextBlock,
    });

  const response = await withRetry(() =>
    ai.models.generateContent({
      model,
      contents: `Document Title: ${input.title}\nTotal Pages: ${pageCount}\n\nDocument Content:\n${textForPrompt}`,
      config: {
        systemInstruction,
        ...(typeof input.temperature === 'number' ? { temperature: input.temperature } : {}),
        thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            summary: { type: Type.STRING },
            keyInsights: { type: Type.ARRAY, items: { type: Type.STRING } },
            improvements: { type: Type.ARRAY, items: { type: Type.STRING } },
            openQuestions: { type: Type.ARRAY, items: { type: Type.STRING } },
            highlights: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  page: { type: Type.INTEGER },
                  quoteAnchor: { type: Type.STRING },
                  category: { type: Type.STRING },
                  comment: { type: Type.STRING },
                },
                required: ['page', 'quoteAnchor', 'category', 'comment'],
              },
            },
          },
          required: ['summary', 'keyInsights', 'improvements', 'openQuestions', 'highlights'],
        },
      },
    })
  );

  const rawJson = (response.text ?? '{}').trim();
  const parsed = JSON.parse(rawJson) as {
    summary?: string;
    keyInsights?: string[];
    improvements?: string[];
    openQuestions?: string[];
    highlights?: Array<{
      page?: number;
      quoteAnchor?: string;
      category?: string;
      comment?: string;
    }>;
  };

  const validCategory = (cat?: string): HighlightCategory => {
    if (cat === 'improvement' || cat === 'question' || cat === 'claim') return cat;
    return 'claim';
  };

  const rawHighlights = (parsed.highlights ?? []).slice(0, maxHighlights);
  const highlights: HighlightItem[] = rawHighlights
    .filter((h) => h.quoteAnchor && h.quoteAnchor.trim().length > 4)
    .map((h) => {
      const requestedPage = Math.min(Math.max(Number(h.page ?? 1), 1), pageCount);
      const quoteAnchor = String(h.quoteAnchor).trim();
      const matched = findQuoteRects(input.pageIndex, requestedPage, quoteAnchor);
      return {
        id: `hl-${crypto.randomUUID().slice(0, 8)}`,
        page: matched.page,
        quoteAnchor,
        category: validCategory(h.category),
        comment: String(h.comment ?? '').trim(),
        rects: matched.rects,
      };
    });

  return {
    summary: String(parsed.summary ?? '').trim() || 'No summary generated.',
    keyInsights: (parsed.keyInsights ?? []).map((s) => String(s).trim()).filter(Boolean),
    improvements: (parsed.improvements ?? []).map((s) => String(s).trim()).filter(Boolean),
    openQuestions: (parsed.openQuestions ?? []).map((s) => String(s).trim()).filter(Boolean),
    highlights,
  };
}
