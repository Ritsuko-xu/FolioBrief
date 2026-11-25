/** Deterministic non-AI PDF renderer: builds `brief_v<N>.pdf` and lazily draws highlights/notes into `annotated_v<N>.pdf`. */
import {
  PDFArray,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFString,
  StandardFonts,
  rgb,
} from 'pdf-lib';
import type {
  AnalysisVersion,
  HighlightCategory,
  HighlightItem,
  PageIndexEntry,
} from '../../src/shared/types.ts';
import { findQuoteRects } from './extractor.ts';
import { sanitizePdfText, wrapTextLines } from './textLayout.ts';

/** Renders a formatted Executive Brief PDF containing summary, insights, improvements, and questions. */
export async function generateBriefPdfBytes(input: {
  title: string;
  sourceDomain: string | null;
  version: AnalysisVersion;
}): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const serifBold = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
  const sans = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const sansBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const pageWidth = 612;
  const pageHeight = 792;
  const marginX = 56;
  const marginTop = 58;
  const marginBottom = 56;
  const contentWidth = pageWidth - marginX * 2;

  let page = pdfDoc.addPage([pageWidth, pageHeight]);
  let cursorY = pageHeight - marginTop;

  const ensureSpace = (needed: number) => {
    if (cursorY - needed < marginBottom) {
      page = pdfDoc.addPage([pageWidth, pageHeight]);
      cursorY = pageHeight - marginTop;
    }
  };

  // Kicker
  page.drawText(`FOLIOBRIEF EXECUTIVE SYNTHESIS  |  REVISION V${input.version.versionNumber}`, {
    x: marginX,
    y: cursorY,
    size: 8.5,
    font: sansBold,
    color: rgb(0.12, 0.25, 0.69),
  });
  cursorY -= 20;

  // Title
  const titleLines = wrapTextLines(input.title, contentWidth, serifBold, 19);
  for (const line of titleLines) {
    ensureSpace(24);
    page.drawText(line, {
      x: marginX,
      y: cursorY,
      size: 19,
      font: serifBold,
      color: rgb(0.11, 0.1, 0.09),
    });
    cursorY -= 24;
  }

  // Meta
  const metaText = [
    input.sourceDomain ?? 'Uploaded PDF',
    `Generated ${new Date(input.version.createdAt).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })}`,
    input.version.revisionReason,
  ].join('  |  ');
  const metaLines = wrapTextLines(metaText, contentWidth, sans, 9);
  for (const line of metaLines) {
    ensureSpace(14);
    page.drawText(line, {
      x: marginX,
      y: cursorY,
      size: 9,
      font: sans,
      color: rgb(0.35, 0.33, 0.31),
    });
    cursorY -= 14;
  }

  cursorY -= 6;
  page.drawLine({
    start: { x: marginX, y: cursorY },
    end: { x: pageWidth - marginX, y: cursorY },
    thickness: 0.75,
    color: rgb(0.84, 0.81, 0.76),
  });
  cursorY -= 22;

  const drawSectionHeading = (heading: string) => {
    ensureSpace(28);
    cursorY -= 4;
    page.drawText(sanitizePdfText(heading), {
      x: marginX,
      y: cursorY,
      size: 12.5,
      font: sansBold,
      color: rgb(0.11, 0.1, 0.09),
    });
    cursorY -= 16;
  };

  const drawParagraph = (text: string) => {
    const lines = wrapTextLines(text, contentWidth, sans, 10.5);
    for (const line of lines) {
      ensureSpace(15);
      page.drawText(line, {
        x: marginX,
        y: cursorY,
        size: 10.5,
        font: sans,
        color: rgb(0.16, 0.15, 0.14),
      });
      cursorY -= 15;
    }
    cursorY -= 8;
  };

  const drawBullets = (items: string[]) => {
    if (items.length === 0) {
      drawParagraph('No items recorded.');
      return;
    }
    for (const item of items) {
      const bulletIndent = 14;
      const lines = wrapTextLines(item, contentWidth - bulletIndent, sans, 10.2);
      lines.forEach((line, idx) => {
        ensureSpace(15);
        if (idx === 0) {
          page.drawText('*', {
            x: marginX + 2,
            y: cursorY - 1,
            size: 11,
            font: sansBold,
            color: rgb(0.12, 0.25, 0.69),
          });
        }
        page.drawText(line, {
          x: marginX + bulletIndent,
          y: cursorY,
          size: 10.2,
          font: sans,
          color: rgb(0.16, 0.15, 0.14),
        });
        cursorY -= 14.5;
      });
      cursorY -= 5;
    }
    cursorY -= 6;
  };

  drawSectionHeading('Executive Summary');
  drawParagraph(input.version.summary);

  drawSectionHeading('Key Insights');
  drawBullets(input.version.keyInsights);

  drawSectionHeading('Novel Improvements & Contributions');
  drawBullets(input.version.improvements);

  drawSectionHeading('Open-Ended Questions');
  drawBullets(input.version.openQuestions);

  const pages = pdfDoc.getPages();
  pages.forEach((p, idx) => {
    p.drawText(`FolioBrief  |  Page ${idx + 1} of ${pages.length}`, {
      x: pageWidth - marginX - 110,
      y: 26,
      size: 8.5,
      font: sans,
      color: rgb(0.45, 0.43, 0.4),
    });
  });

  return pdfDoc.save();
}

/** Maps a highlight category to its RGB highlight tint. */
function getCategoryRgb(category: HighlightCategory): [number, number, number] {
  switch (category) {
    case 'improvement':
      return [0.73, 0.94, 0.8]; // Sage green
    case 'question':
      return [0.78, 0.84, 0.99]; // Pale indigo
    case 'claim':
    default:
      return [0.99, 0.9, 0.54]; // Warm amber
  }
}

/** Embeds translucent highlight washes, `/Highlight` QuadPoints, and margin `/Text` notes into the Source PDF. */
export async function generateAnnotatedPdfBytes(input: {
  sourcePdfBytes: Uint8Array;
  highlights: HighlightItem[];
  pageIndex: PageIndexEntry[];
}): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(input.sourcePdfBytes);
  const pages = pdfDoc.getPages();

  for (let idx = 0; idx < input.highlights.length; idx += 1) {
    const h = input.highlights[idx];
    const resolved =
      h.rects && h.rects.length > 0
        ? { page: h.page, rects: h.rects }
        : findQuoteRects(input.pageIndex, h.page, h.quoteAnchor);

    const pageIdx = Math.min(Math.max(resolved.page - 1, 0), pages.length - 1);
    const page = pages[pageIdx];
    if (!page) continue;

    const { width: pageWidth, height: pageHeight } = page.getSize();
    const [r, g, b] = getCategoryRgb(h.category);
    const noteText = sanitizePdfText(`[${h.category.toUpperCase()}] ${h.comment}\n\n"${h.quoteAnchor}"`);

    const rectsToDraw =
      resolved.rects.length > 0
        ? resolved.rects
        : [
            {
              x: 48,
              y: Math.max(60, pageHeight - 90 - (idx % 6) * 28),
              width: Math.min(280, pageWidth - 96),
              height: 14,
            },
          ];

    // Add standard PDF Highlight annotation with QuadPoints + Contents comment
    const quadPoints: number[] = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const rect of rectsToDraw) {
      const x1 = Math.max(0, rect.x - 1);
      const y1 = Math.max(0, rect.y - 2);
      const x2 = Math.min(pageWidth, rect.x + rect.width + 1);
      const y2 = Math.min(pageHeight, rect.y + rect.height + 2);

      minX = Math.min(minX, x1);
      minY = Math.min(minY, y1);
      maxX = Math.max(maxX, x2);
      maxY = Math.max(maxY, y2);

      // PDF QuadPoints order: top-left, top-right, bottom-left, bottom-right
      quadPoints.push(x1, y2, x2, y2, x1, y1, x2, y1);

      // Subtle translucent visual wash so highlights remain visible across all viewers
      page.drawRectangle({
        x: x1,
        y: y1,
        width: Math.max(4, x2 - x1),
        height: Math.max(6, y2 - y1),
        color: rgb(r, g, b),
        opacity: 0.28,
      });
    }

    const annotsKey = PDFName.of('Annots');
    let annots = page.node.lookupMaybe(annotsKey, PDFArray);
    if (!annots) {
      annots = pdfDoc.context.obj([]);
      page.node.set(annotsKey, annots);
    }

    const quadArray = pdfDoc.context.obj(quadPoints.map((n) => PDFNumber.of(Number(n.toFixed(2)))));
    const rectArray = pdfDoc.context.obj([
      PDFNumber.of(Number(minX.toFixed(2))),
      PDFNumber.of(Number(minY.toFixed(2))),
      PDFNumber.of(Number(maxX.toFixed(2))),
      PDFNumber.of(Number(maxY.toFixed(2))),
    ]);
    const colorArray = pdfDoc.context.obj([
      PDFNumber.of(r),
      PDFNumber.of(g),
      PDFNumber.of(b),
    ]);

    const highlightAnnot = pdfDoc.context.obj({
      Type: PDFName.of('Annot'),
      Subtype: PDFName.of('Highlight'),
      Rect: rectArray,
      QuadPoints: quadArray,
      C: colorArray,
      CA: PDFNumber.of(0.45),
      T: PDFString.of('FolioBrief AI'),
      Contents: PDFString.of(noteText),
      F: PDFNumber.of(4),
    });
    const highlightRef = pdfDoc.context.register(highlightAnnot);
    annots.push(highlightRef);

    // Sticky note comment icon in right margin for instant review in macOS Preview / Acrobat
    const noteX = Math.min(pageWidth - 34, maxX + 8);
    const noteY = Math.min(pageHeight - 30, maxY - 12);
    const textAnnot = pdfDoc.context.obj({
      Type: PDFName.of('Annot'),
      Subtype: PDFName.of('Text'),
      Rect: pdfDoc.context.obj([
        PDFNumber.of(Number(noteX.toFixed(2))),
        PDFNumber.of(Number(noteY.toFixed(2))),
        PDFNumber.of(Number((noteX + 18).toFixed(2))),
        PDFNumber.of(Number((noteY + 18).toFixed(2))),
      ]),
      C: colorArray,
      Name: PDFName.of('Comment'),
      T: PDFString.of('FolioBrief AI'),
      Contents: PDFString.of(noteText),
      Open: false,
      F: PDFNumber.of(4),
    });
    annots.push(pdfDoc.context.register(textAnnot));
  }

  return pdfDoc.save();
}
