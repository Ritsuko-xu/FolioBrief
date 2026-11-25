/** Deterministic editorial `pdf-lib` typesetter for structured web articles and pasted prose. */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { wrapPreLines, wrapTextLines } from './textLayout.ts';
import type { ArticleBlock, ExtractedArticle } from './articleTypes.ts';

/** Typesets an extracted web/text article into a styled, multi-page paginated Source PDF. */
export async function renderArticleToPdf(
  article: ExtractedArticle,
  sourceUrl?: string | null
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const serifFont = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const serifBold = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
  const serifItalic = await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);
  const sansFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const sansBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const monoFont = await pdfDoc.embedFont(StandardFonts.Courier);

  const pageWidth = 612;
  const pageHeight = 792;
  const marginX = 60;
  const marginTop = 62;
  const marginBottom = 60;
  const contentWidth = pageWidth - marginX * 2;

  let page = pdfDoc.addPage([pageWidth, pageHeight]);
  let cursorY = pageHeight - marginTop;

  const ensureSpace = (needed: number) => {
    if (cursorY - needed < marginBottom) {
      page = pdfDoc.addPage([pageWidth, pageHeight]);
      cursorY = pageHeight - marginTop;
      return true;
    }
    return false;
  };

  // Title
  const titleLines = wrapTextLines(article.title, contentWidth, serifBold, 20);
  for (const line of titleLines) {
    ensureSpace(26);
    page.drawText(line, {
      x: marginX,
      y: cursorY,
      size: 20,
      font: serifBold,
      color: rgb(0.11, 0.1, 0.09),
    });
    cursorY -= 26;
  }

  // Metadata line
  cursorY -= 4;
  const metaParts = [article.sourceDomain];
  if (article.byline) metaParts.push(article.byline);
  if (sourceUrl) metaParts.push(sourceUrl.slice(0, 72));
  const metaLines = wrapTextLines(metaParts.join('  |  '), contentWidth, sansFont, 9);
  for (const line of metaLines) {
    ensureSpace(14);
    page.drawText(line, {
      x: marginX,
      y: cursorY,
      size: 9,
      font: sansFont,
      color: rgb(0.35, 0.33, 0.31),
    });
    cursorY -= 14;
  }

  // Hairline rule
  cursorY -= 8;
  page.drawLine({
    start: { x: marginX, y: cursorY },
    end: { x: pageWidth - marginX, y: cursorY },
    thickness: 0.75,
    color: rgb(0.84, 0.81, 0.76),
  });
  cursorY -= 22;

  const blocks: ArticleBlock[] =
    article.blocks && article.blocks.length > 0
      ? article.blocks
      : article.paragraphs.map((text) => ({ type: 'p', text }));

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    const nextBlock = blocks[i + 1];

    if (block.type === 'h1' || block.type === 'h2' || block.type === 'h3' || block.type === 'h4') {
      const spec =
        block.type === 'h1'
          ? { size: 15.5, lineHeight: 20, topGap: 8, bottomGap: 6, color: rgb(0.11, 0.1, 0.09) }
          : block.type === 'h2'
            ? { size: 13.5, lineHeight: 18, topGap: 10, bottomGap: 5, color: rgb(0.11, 0.1, 0.09) }
            : block.type === 'h3'
              ? { size: 11.8, lineHeight: 16, topGap: 8, bottomGap: 4, color: rgb(0.18, 0.17, 0.16) }
              : { size: 10.8, lineHeight: 15, topGap: 6, bottomGap: 4, color: rgb(0.24, 0.22, 0.2) };

      if (i > 0) cursorY -= spec.topGap;
      const lines = wrapTextLines(block.text, contentWidth, sansBold, spec.size);
      // Keep heading with at least one following line on the same page
      ensureSpace(lines.length * spec.lineHeight + 24);
      for (const line of lines) {
        ensureSpace(spec.lineHeight);
        page.drawText(line, {
          x: marginX,
          y: cursorY,
          size: spec.size,
          font: sansBold,
          color: spec.color,
        });
        cursorY -= spec.lineHeight;
      }
      cursorY -= spec.bottomGap;
      continue;
    }

    if (block.type === 'blockquote') {
      const insetX = 16;
      const lines = wrapTextLines(block.text, contentWidth - insetX - 6, serifItalic, 11);
      if (lines.length === 0) continue;
      const lineHeight = 16.5;
      cursorY -= 2;
      ensureSpace(lineHeight + 6);

      let sliceTopY = cursorY + 11;
      for (let li = 0; li < lines.length; li += 1) {
        const jumped = ensureSpace(lineHeight);
        if (jumped) {
          sliceTopY = cursorY + 11;
        }
        page.drawText(lines[li], {
          x: marginX + insetX,
          y: cursorY,
          size: 11,
          font: serifItalic,
          color: rgb(0.27, 0.25, 0.23),
        });
        const lineBottomY = cursorY - 4;
        const isLastOnPage =
          li === lines.length - 1 || cursorY - lineHeight - lineHeight < marginBottom;
        if (isLastOnPage) {
          page.drawLine({
            start: { x: marginX + 6, y: sliceTopY },
            end: { x: marginX + 6, y: lineBottomY },
            thickness: 2,
            color: rgb(0.18, 0.34, 0.72),
          });
        }
        cursorY -= lineHeight;
      }
      cursorY -= 9;
      continue;
    }

    if (block.type === 'li' || block.type === 'ol-li') {
      const indentX = 20;
      const lineHeight = 16.5;
      const lines = wrapTextLines(block.text, contentWidth - indentX, serifFont, 11);
      if (lines.length === 0) continue;

      lines.forEach((line, lineIdx) => {
        ensureSpace(lineHeight);
        if (lineIdx === 0) {
          if (block.type === 'ol-li') {
            page.drawText(`${block.listIndex ?? 1}.`, {
              x: marginX + 4,
              y: cursorY,
              size: 10,
              font: sansBold,
              color: rgb(0.18, 0.34, 0.72),
            });
          } else {
            page.drawCircle({
              x: marginX + 9,
              y: cursorY + 3.5,
              size: 1.8,
              color: rgb(0.18, 0.34, 0.72),
            });
          }
        }
        page.drawText(line, {
          x: marginX + indentX,
          y: cursorY,
          size: 11,
          font: serifFont,
          color: rgb(0.12, 0.11, 0.1),
        });
        cursorY -= lineHeight;
      });

      const isEndOfList = !nextBlock || (nextBlock.type !== 'li' && nextBlock.type !== 'ol-li');
      cursorY -= isEndOfList ? 10 : 4;
      continue;
    }

    if (block.type === 'pre') {
      const padX = 12;
      const lineHeight = 12.5;
      const lines = wrapPreLines(block.text, contentWidth - padX * 2, monoFont, 8.8);
      if (lines.length === 0) continue;
      cursorY -= 4;
      ensureSpace(lineHeight + 14);

      for (const line of lines) {
        ensureSpace(lineHeight);
        page.drawRectangle({
          x: marginX,
          y: cursorY - 3.5,
          width: contentWidth,
          height: lineHeight,
          color: rgb(0.95, 0.94, 0.91),
        });
        if (line.trim().length > 0) {
          page.drawText(line, {
            x: marginX + padX,
            y: cursorY,
            size: 8.8,
            font: monoFont,
            color: rgb(0.17, 0.16, 0.15),
          });
        }
        cursorY -= lineHeight;
      }
      cursorY -= 11;
      continue;
    }

    // Standard paragraph (`p`)
    const fontSize = 11.2;
    const lineHeight = 17;
    const lines = wrapTextLines(block.text, contentWidth, serifFont, fontSize);
    for (const line of lines) {
      ensureSpace(lineHeight);
      page.drawText(line, {
        x: marginX,
        y: cursorY,
        size: fontSize,
        font: serifFont,
        color: rgb(0.12, 0.11, 0.1),
      });
      cursorY -= lineHeight;
    }
    cursorY -= 9;
  }

  // Footer page numbers
  const pages = pdfDoc.getPages();
  pages.forEach((p, idx) => {
    p.drawText(`Page ${idx + 1} of ${pages.length}`, {
      x: pageWidth - marginX - 60,
      y: 28,
      size: 8.5,
      font: sansFont,
      color: rgb(0.45, 0.43, 0.4),
    });
  });

  return pdfDoc.save();
}
