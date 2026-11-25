/** Readability + JSDOM HTML parser that extracts clean, deduplicated structured article blocks. */
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import type { ArticleBlock, ArticleBlockType, ExtractedArticle } from './articleTypes.ts';

const NESTED_BLOCK_SELECTOR = 'h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, ul, ol';

/** Walks parsed HTML top-down to emit unique styled blocks without double-extracting nested tags like `<blockquote><p>`. */
function extractStructuredBlocks(root: Element | null): ArticleBlock[] {
  if (!root) return [];
  const rawBlocks: ArticleBlock[] = [];

  const pushNormalized = (type: ArticleBlockType, rawText: string, listIndex?: number) => {
    if (type === 'pre') {
      const preText = rawText.replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '');
      if (preText.trim().length > 0) {
        rawBlocks.push({ type: 'pre', text: preText });
      }
      return;
    }
    const clean = rawText.replace(/\s+/g, ' ').trim();
    if (clean.length > 0) {
      rawBlocks.push(listIndex !== undefined ? { type, text: clean, listIndex } : { type, text: clean });
    }
  };

  const walk = (node: Element, inBlockquote: boolean) => {
    const tag = node.tagName.toUpperCase();

    if (tag === 'PRE') {
      pushNormalized('pre', node.textContent ?? '');
      return;
    }

    if (tag === 'H1' || tag === 'H2' || tag === 'H3' || tag === 'H4' || tag === 'H5' || tag === 'H6') {
      const hType = (tag === 'H5' || tag === 'H6' ? 'H4' : tag).toLowerCase() as 'h1' | 'h2' | 'h3' | 'h4';
      pushNormalized(hType, node.textContent ?? '');
      return;
    }

    if (tag === 'BLOCKQUOTE') {
      if (node.querySelector(NESTED_BLOCK_SELECTOR)) {
        for (const child of Array.from(node.children)) {
          walk(child, true);
        }
      } else {
        pushNormalized('blockquote', node.textContent ?? '');
      }
      return;
    }

    if (tag === 'LI') {
      const parent = node.parentElement;
      const isOrdered = parent?.tagName.toUpperCase() === 'OL';
      const liType: ArticleBlockType = isOrdered ? 'ol-li' : 'li';
      let listIndex: number | undefined;
      if (isOrdered && parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName.toUpperCase() === 'LI');
        listIndex = Math.max(1, siblings.indexOf(node) + 1);
      }

      if (!node.querySelector(NESTED_BLOCK_SELECTOR)) {
        pushNormalized(liType, node.textContent ?? '', listIndex);
        return;
      }

      // Handle `<li><p>Item text</p>...</li>` or `<li>Lead text<ul><li>Sub</li></ul></li>` cleanly
      let emittedBullet = false;
      let inlineBuffer = '';
      const flushInline = () => {
        const trimmed = inlineBuffer.replace(/\s+/g, ' ').trim();
        inlineBuffer = '';
        if (trimmed) {
          pushNormalized(!emittedBullet ? liType : 'p', trimmed, !emittedBullet ? listIndex : undefined);
          emittedBullet = true;
        }
      };

      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) {
          inlineBuffer += ` ${child.textContent ?? ''}`;
        } else if (child.nodeType === 1) {
          const el = child as Element;
          const childTag = el.tagName.toUpperCase();
          const isBlockChild =
            childTag === 'P' ||
            childTag === 'UL' ||
            childTag === 'OL' ||
            childTag === 'BLOCKQUOTE' ||
            childTag === 'PRE' ||
            /^H[1-6]$/.test(childTag);
          if (!isBlockChild) {
            inlineBuffer += ` ${el.textContent ?? ''}`;
          } else {
            flushInline();
            if (childTag === 'P' && !emittedBullet) {
              pushNormalized(liType, el.textContent ?? '', listIndex);
              emittedBullet = true;
            } else {
              walk(el, inBlockquote);
            }
          }
        }
      }
      flushInline();
      return;
    }

    if (tag === 'P') {
      if (node.querySelector('pre, blockquote')) {
        for (const child of Array.from(node.children)) {
          walk(child, inBlockquote);
        }
        return;
      }
      pushNormalized(inBlockquote ? 'blockquote' : 'p', node.textContent ?? '');
      return;
    }

    for (const child of Array.from(node.children)) {
      walk(child, inBlockquote);
    }
  };

  walk(root, false);

  // Deduplicate immediate identical adjacent blocks caused by duplicate mobile/desktop wrappers
  const deduped: ArticleBlock[] = [];
  for (const b of rawBlocks) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.type === b.type && prev.text === b.text) {
      continue;
    }
    deduped.push(b);
  }
  return deduped;
}

/** Parses readable article title, metadata, and structured blocks from HTML via Readability + JSDOM. */
export function extractArticleFromHtml(html: string, sourceUrl: string): ExtractedArticle {
  const urlObj = new URL(sourceUrl);
  const dom = new JSDOM(html, { url: sourceUrl });
  const reader = new Readability(dom.window.document);
  const parsed = reader.parse();

  const rawTitle =
    parsed?.title?.trim() ||
    dom.window.document.title?.trim() ||
    urlObj.hostname;

  let blocks: ArticleBlock[] = [];
  if (parsed?.content) {
    const contentDom = new JSDOM(parsed.content);
    blocks = extractStructuredBlocks(contentDom.window.document.body);
  }

  if (blocks.length === 0) {
    const rawText =
      parsed?.textContent?.trim() ||
      dom.window.document.querySelector('article, main')?.textContent?.trim() ||
      dom.window.document.body?.textContent?.trim() ||
      '';
    for (const chunk of rawText.split(/\n+/)) {
      const clean = chunk.replace(/\s+/g, ' ').trim();
      if (clean.length > 0) blocks.push({ type: 'p', text: clean });
    }
  }

  const paragraphs = blocks.map((b) => b.text);
  const totalChars = paragraphs.reduce((acc, p) => acc + p.length, 0);
  if (paragraphs.length === 0 || totalChars < 60) {
    throw new Error(
      'Could not extract readable article prose from this URL (it may be behind a login/paywall or require JavaScript). Try pasting the article text directly or uploading a PDF.'
    );
  }

  return {
    title: rawTitle,
    byline: parsed?.byline?.trim() || null,
    siteName: parsed?.siteName?.trim() || null,
    sourceDomain: urlObj.hostname.replace(/^www\./, ''),
    textContent: paragraphs.join('\n\n'),
    paragraphs,
    blocks,
  };
}
