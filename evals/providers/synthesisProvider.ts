/** Custom Promptfoo provider invoking FolioBrief's real initial document synthesis agent (`synthesizeDocumentAnalysis`). */
import 'dotenv/config';
import { synthesizeDocumentAnalysis } from '../../server/ai/documentSynthesisAgent.ts';
import { computeConciseHighlightCap, PRIMARY_MODEL } from '../../server/ai/geminiClient.ts';
import type { PageIndexEntry } from '../../src/shared/types.ts';

interface ProviderOptions {
  id?: string;
  config?: {
    modelOverride?: string;
    temperature?: number;
  };
}

interface CallContext {
  vars?: Record<string, unknown>;
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

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

export default class SynthesisProvider {
  private readonly providerId: string;
  private readonly modelOverride?: string;
  private readonly temperature?: number;

  constructor(options: ProviderOptions = {}) {
    this.providerId = options.id ?? 'foliobrief-synthesis';
    this.modelOverride = options.config?.modelOverride;
    this.temperature = options.config?.temperature;
  }

  id(): string {
    return this.providerId;
  }

  async callApi(prompt: string, context: CallContext = {}) {
    const vars = context.vars ?? {};
    const title = String(vars.title ?? 'Untitled Research Excerpt');
    const extractedText = String(vars.extractedText ?? vars.article_excerpt ?? '');
    const memoryContextBlock =
      typeof vars.memoryContextBlock === 'string' && vars.memoryContextBlock.trim()
        ? vars.memoryContextBlock.trim()
        : undefined;

    const pageIndex = Array.isArray(vars.pageIndex)
      ? (vars.pageIndex as PageIndexEntry[])
      : buildPageIndex(extractedText);

    const trimmedPrompt = prompt.trim();
    const systemInstructionOverride =
      trimmedPrompt && trimmedPrompt !== 'USE_DEFAULT_SYSTEM_PROMPT' ? trimmedPrompt : undefined;

    const payload = await synthesizeDocumentAnalysis({
      title,
      extractedText,
      pageIndex,
      memoryContextBlock,
      modelOverride: this.modelOverride,
      temperature: this.temperature,
      systemInstructionOverride,
    });

    const normalizedSource = normalizeWhitespace(extractedText);
    const verbatimMatchedCount = payload.highlights.filter((h) => {
      const anchor = normalizeWhitespace(h.quoteAnchor);
      return anchor.length > 0 && normalizedSource.includes(anchor);
    }).length;

    return {
      output: JSON.stringify({
        ...payload,
        _eval: {
          model: this.modelOverride?.trim() || PRIMARY_MODEL,
          highlightCap: computeConciseHighlightCap(Math.max(1, pageIndex.length)),
          totalHighlights: payload.highlights.length,
          verbatimMatchedCount,
        },
      }),
    };
  }
}
