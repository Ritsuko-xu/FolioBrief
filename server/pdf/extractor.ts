/** PDF text-span extractor (`pdfjs-dist`) and quote-to-bounding-box coordinate matcher (`findQuoteRects`). */
import type { HighlightRect, PageIndexEntry, PageTextSpan } from '../../src/shared/types.ts';

interface PdfjsTextItem {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
}

/** Extracts per-page prose and PDF-coordinate text span bounding boxes via `pdfjs-dist`. */
export async function extractPdfIndex(pdfBytes: Uint8Array): Promise<{
  extractedText: string;
  pageIndex: PageIndexEntry[];
  pageCount: number;
}> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(pdfBytes),
    useWorkerFetch: false,
    useSystemFonts: true,
    verbosity: 0,
  });

  const pdfDoc = await loadingTask.promise;
  const pageCount = pdfDoc.numPages;
  const pageIndex: PageIndexEntry[] = [];
  const pageTexts: string[] = [];

  for (let pageNum = 1; pageNum <= pageCount; pageNum += 1) {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.0 });
    const textContent = await page.getTextContent();

    const spans: PageTextSpan[] = [];
    const tokens: string[] = [];

    for (const rawItem of textContent.items as PdfjsTextItem[]) {
      const str = (rawItem.str ?? '').trim();
      if (!str) continue;
      const transform = rawItem.transform ?? [1, 0, 0, 1, 0, 0];
      const fontHeight = Math.abs(transform[3]) || Math.abs(transform[0]) || rawItem.height || 10;
      const x = Number(transform[4] ?? 0);
      // PDF y-origin is bottom-left; keep PDF-space y for pdf-lib and normalized top-left via viewport.height
      const yBottom = Number(transform[5] ?? 0);
      const width = Math.max(Number(rawItem.width ?? str.length * fontHeight * 0.5), 4);
      const height = Math.max(fontHeight, 8);

      spans.push({
        text: str,
        x,
        y: yBottom,
        width,
        height,
      });
      tokens.push(str);
    }

    const fullText = tokens.join(' ').replace(/\s+/g, ' ').trim();
    pageTexts.push(`[Page ${pageNum}]\n${fullText}`);
    pageIndex.push({
      page: pageNum,
      width: viewport.width,
      height: viewport.height,
      fullText,
      spans,
    });
  }

  if (typeof (pdfDoc as { cleanup?: () => Promise<void> }).cleanup === 'function') {
    await (pdfDoc as { cleanup: () => Promise<void> }).cleanup();
  }
  if (typeof (loadingTask as { destroy?: () => Promise<void> }).destroy === 'function') {
    await (loadingTask as { destroy: () => Promise<void> }).destroy();
  }
  return {
    extractedText: pageTexts.join('\n\n'),
    pageIndex,
    pageCount,
  };
}

/** Lowercases and strips punctuation to enable resilient quote-anchor matching. */
function normalizeForMatch(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Resolves PDF bounding rectangles for a verbatim quote anchor (preferred page first, then neighbors). */
export function findQuoteRects(
  pageIndex: PageIndexEntry[],
  preferredPage: number,
  quoteAnchor: string
): { page: number; rects: HighlightRect[] } {
  const normQuote = normalizeForMatch(quoteAnchor);
  if (!normQuote) {
    return { page: preferredPage, rects: [] };
  }

  // Search preferred page first, then neighboring pages
  const orderedPages = [...pageIndex].sort((a, b) => {
    if (a.page === preferredPage) return -1;
    if (b.page === preferredPage) return 1;
    return Math.abs(a.page - preferredPage) - Math.abs(b.page - preferredPage);
  });

  const quoteWords = normQuote.split(' ').filter(Boolean);
  const searchPhrases: string[] = [normQuote];
  if (quoteWords.length > 6) {
    searchPhrases.push(quoteWords.slice(0, 6).join(' '));
    searchPhrases.push(quoteWords.slice(0, 4).join(' '));
  }

  for (const pageEntry of orderedPages) {
    if (pageEntry.spans.length === 0) continue;

    // Build sliding span index mapping normalized text offsets to span indices
    const spanOffsets: Array<{ start: number; end: number; span: PageTextSpan }> = [];
    let cursor = 0;
    const normChunks: string[] = [];

    for (const span of pageEntry.spans) {
      const normSpan = normalizeForMatch(span.text);
      if (!normSpan) continue;
      if (normChunks.length > 0) {
        normChunks.push(' ');
        cursor += 1;
      }
      const start = cursor;
      normChunks.push(normSpan);
      cursor += normSpan.length;
      spanOffsets.push({ start, end: cursor, span });
    }

    const combinedNorm = normChunks.join('');
    for (const phrase of searchPhrases) {
      const matchIdx = combinedNorm.indexOf(phrase);
      if (matchIdx === -1) continue;

      const matchEnd = matchIdx + phrase.length;
      const matchedSpans = spanOffsets
        .filter((item) => item.end > matchIdx && item.start < matchEnd)
        .map((item) => item.span);

      if (matchedSpans.length > 0) {
        return {
          page: pageEntry.page,
          rects: mergeAdjacentSpansToLineRects(matchedSpans),
        };
      }
    }
  }

  return { page: preferredPage, rects: [] };
}

/** Merges adjacent matched spans sharing the same line baseline into unified highlight rectangles. */
function mergeAdjacentSpansToLineRects(spans: PageTextSpan[]): HighlightRect[] {
  const sorted = [...spans].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: HighlightRect[] = [];

  for (const span of sorted) {
    const existing = lines.find((line) => Math.abs(line.y - span.y) <= Math.max(span.height, 8) * 0.6);
    if (existing) {
      const minX = Math.min(existing.x, span.x);
      const maxX = Math.max(existing.x + existing.width, span.x + span.width);
      const minY = Math.min(existing.y, span.y);
      const maxY = Math.max(existing.y + existing.height, span.y + span.height);
      existing.x = minX;
      existing.y = minY;
      existing.width = maxX - minX;
      existing.height = maxY - minY;
    } else {
      lines.push({
        x: span.x,
        y: span.y,
        width: span.width,
        height: span.height,
      });
    }
  }

  return lines;
}
