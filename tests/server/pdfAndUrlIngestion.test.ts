/** Tests for URL SSRF validation, Readability extraction, PDF text indexing, and PDF brief/annotation generation. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import dns from 'node:dns/promises';
import { PDFDocument } from 'pdf-lib';
import { isPrivateOrReservedIp, validateSafePublicUrl } from '../../server/pdf/urlIngestor.ts';
import { extractArticleFromHtml } from '../../server/pdf/htmlArticleExtractor.ts';
import { renderArticleToPdf } from '../../server/pdf/articlePdfRenderer.ts';
import { extractPdfIndex, findQuoteRects } from '../../server/pdf/extractor.ts';
import { generateAnnotatedPdfBytes, generateBriefPdfBytes } from '../../server/pdf/generator.ts';
import type { AnalysisVersion, PageIndexEntry } from '../../src/shared/types.ts';

describe('URL Ingestion, SSRF Guard, PDF Extractor & PDF Generator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('blocks private, loopback, IPv6, CGNAT, internal hostnames, DNS-resolved private IPs, and non-HTTP URLs against SSRF', async () => {
    await expect(validateSafePublicUrl('not-a-url')).rejects.toThrow();
    await expect(validateSafePublicUrl('ftp://example.com/file.pdf')).rejects.toThrow();
    await expect(validateSafePublicUrl('file:///etc/passwd')).rejects.toThrow();
    await expect(validateSafePublicUrl('http://127.0.0.1:3000/secret')).rejects.toThrow();
    await expect(validateSafePublicUrl('http://localhost:3000')).rejects.toThrow();
    await expect(validateSafePublicUrl('http://printer.local/status')).rejects.toThrow();
    await expect(validateSafePublicUrl('http://metadata.google.internal')).rejects.toThrow();
    await expect(validateSafePublicUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow();
    await expect(validateSafePublicUrl('http://192.168.1.10/admin')).rejects.toThrow();
    await expect(validateSafePublicUrl('http://10.0.0.5/internal')).rejects.toThrow();
    await expect(validateSafePublicUrl('http://172.16.0.1/internal')).rejects.toThrow();
    await expect(validateSafePublicUrl('http://100.64.0.1/cgnat')).rejects.toThrow();
    await expect(validateSafePublicUrl('http://0.0.0.0:8080')).rejects.toThrow();
    await expect(validateSafePublicUrl('http://[::1]:3000')).rejects.toThrow();
    await expect(validateSafePublicUrl('http://[fc00::1]/')).rejects.toThrow();

    expect(isPrivateOrReservedIp('invalid-ip')).toBe(true);
    expect(isPrivateOrReservedIp('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('8.8.8.8')).toBe(false);

    vi.spyOn(dns, 'lookup').mockResolvedValueOnce([
      { address: '10.20.30.40', family: 4 },
    ] as unknown as Awaited<ReturnType<typeof dns.lookup>>);
    await expect(validateSafePublicUrl('https://rebind.example.com/article')).rejects.toThrow(
      'restricted internal network address'
    );
  });

  it('extracts clean article prose from HTML, renders Source PDF, and indexes coordinates', async () => {
    const sampleHtml = `
      <!doctype html>
      <html>
        <head><title>Sparse Attention in Practice</title></head>
        <body>
          <nav>Home | About | Login</nav>
          <article>
            <h1>Sparse Attention in Practice</h1>
            <p class="byline">By Ada Lovelace</p>
            <p>Modern long-context transformers face quadratic KV-cache memory pressure during decoding.</p>
            <p>Our sparse block-selection kernel reduces memory bandwidth by 68 percent without degrading accuracy on needle-in-a-haystack benchmarks.</p>
            <p>Remaining challenges include dynamic sequence length scheduling across heterogeneous GPU clusters.</p>
          </article>
        </body>
      </html>
    `;

    const article = extractArticleFromHtml(sampleHtml, 'https://research.example.org/sparse-attention');
    expect(article.title).toContain('Sparse Attention');
    expect(article.sourceDomain).toBe('research.example.org');
    expect(article.paragraphs.length).toBeGreaterThanOrEqual(3);

    const sourcePdf = await renderArticleToPdf(article, 'https://research.example.org/sparse-attention');
    expect(Buffer.from(sourcePdf.slice(0, 5)).toString()).toBe('%PDF-');

    const indexed = await extractPdfIndex(sourcePdf);
    expect(indexed.pageCount).toBe(1);
    expect(indexed.extractedText).toContain('sparse block-selection kernel');
    expect(indexed.pageIndex[0].spans.length).toBeGreaterThan(5);

    const match = findQuoteRects(
      indexed.pageIndex,
      1,
      'sparse block-selection kernel reduces memory bandwidth'
    );
    expect(match.page).toBe(1);
    expect(match.rects.length).toBeGreaterThan(0);
    expect(match.rects[0].width).toBeGreaterThan(10);
  });

  it('rejects empty/paywalled HTML and handles quote edge cases (empty, unmatched, cross-page)', () => {
    expect(() =>
      extractArticleFromHtml('<html><body><p>Subscribe to read.</p></body></html>', 'https://example.org/paywall')
    ).toThrow();

    const fallbackHtml =
      '<html><head><title>Plain Body</title></head><body><main>Distributed consensus relies on quorum intersections and bounded clock skew across replicas.</main></body></html>';
    const fallbackArticle = extractArticleFromHtml(fallbackHtml, 'https://example.org/plain');
    expect(fallbackArticle.paragraphs.join(' ')).toContain('quorum intersections');

    const twoPageIndex: PageIndexEntry[] = [
      {
        page: 1,
        width: 612,
        height: 792,
        fullText: 'Introduction to tensor parallelism.',
        spans: [{ text: 'Introduction to tensor parallelism.', x: 40, y: 700, width: 200, height: 12 }],
      },
      {
        page: 2,
        width: 612,
        height: 792,
        fullText: 'Ring all-reduce overlaps communication with backward pass!',
        spans: [{ text: 'Ring all-reduce overlaps communication with backward pass!', x: 40, y: 680, width: 320, height: 12 }],
      },
    ];

    expect(findQuoteRects(twoPageIndex, 1, '   ').rects).toEqual([]);
    expect(findQuoteRects(twoPageIndex, 1, 'completely absent sentence').rects).toEqual([]);

    const relocated = findQuoteRects(twoPageIndex, 1, 'ring all reduce overlaps communication');
    expect(relocated.page).toBe(2);
    expect(relocated.rects.length).toBeGreaterThan(0);
  });

  it('generates valid Executive Brief PDF and embeds Highlight + Text annotations (including Unicode & fallback rects)', async () => {
    const article = extractArticleFromHtml(
      `<html><head><title>Test Paper</title></head><body><article>
        <h1>Test Paper 🚀</h1>
        <p>First important finding on speculative verification speedups across batch sizes.</p>
        <p>Second paragraph discussing open engineering trade-offs in production serving.</p>
      </article></body></html>`,
      'https://example.org/test-paper'
    );
    const sourcePdf = await renderArticleToPdf(article, 'https://example.org/test-paper');
    const indexed = await extractPdfIndex(sourcePdf);

    const version: AnalysisVersion = {
      id: 'ver-1',
      documentId: 'doc-1',
      versionNumber: 1,
      summary: 'A concise synthesis — testing Unicode sanitization “smart quotes” and emoji 🔍.',
      keyInsights: ['Speculative verification achieves 2.1x speedup on small batches.'],
      improvements: ['Introduces adaptive draft tree pruning.'],
      openQuestions: ['How does acceptance rate degrade under multi-tenant load?'],
      highlights: [
        {
          id: 'h1',
          page: 1,
          quoteAnchor: 'speculative verification speedups across batch sizes',
          category: 'claim',
          comment: 'Primary empirical claim ✅',
        },
        {
          id: 'h2',
          page: 99,
          quoteAnchor: 'unmatched quote triggering fallback rect',
          category: 'question',
          comment: 'Fallback margin rect check',
        },
      ],
      briefPdfPath: null,
      annotatedPdfPath: null,
      annotatedPdfDirty: true,
      revisionReason: 'Initial AI synthesis',
      createdAt: new Date().toISOString(),
    };

    const briefBytes = await generateBriefPdfBytes({
      title: 'Test Paper 🚀',
      sourceDomain: 'example.org',
      version,
    });
    expect(Buffer.from(briefBytes.slice(0, 5)).toString()).toBe('%PDF-');
    const loadedBrief = await PDFDocument.load(briefBytes);
    expect(loadedBrief.getPageCount()).toBeGreaterThanOrEqual(1);

    const briefIndexed = await extractPdfIndex(briefBytes);
    expect(briefIndexed.extractedText).toContain('Executive Summary');
    expect(briefIndexed.extractedText).toContain('Speculative verification achieves 2.1x speedup');
    expect(briefIndexed.extractedText).not.toContain('Concise Reading Margin Notes');

    const annotatedBytes = await generateAnnotatedPdfBytes({
      sourcePdfBytes: sourcePdf,
      highlights: version.highlights,
      pageIndex: indexed.pageIndex,
    });
    expect(Buffer.from(annotatedBytes.slice(0, 5)).toString()).toBe('%PDF-');

    const loadedAnnotated = await PDFDocument.load(annotatedBytes);
    const page1 = loadedAnnotated.getPages()[0];
    const annots = page1.node.get(page1.node.context.obj('Annots'));
    expect(annots).toBeDefined();
  });

  it('deduplicates nested blockquote/list paragraphs and preserves headings, lists, quotes, and code blocks', async () => {
    const htmlWithNestedBlocks = `
      <!doctype html>
      <html>
        <head><title>Agents in a Loop</title></head>
        <body>
          <article>
            <h1>Agents in a Loop</h1>
            <blockquote><p>Hi, My name is Lee Cuong, welcome to my blog!</p></blockquote>
            <p>An LLM agent runs tools in a bounded loop to achieve a clear user goal cleanly. Rather than acting like a mysterious mind, it repeatedly selects a tool, inspects the returned observation, adjusts its plan, and stops as soon as the exit condition is satisfied or budgets are reached.</p>
            <p>When engineers structure tools around small deterministic steps, even modest language models can compile projects, inspect logs, run test suites, and repair syntax issues without drifting away from the original task specification.</p>
            <h2>My setup in VS Code</h2>
            <p>Inside my daily workflow, every automated assistant step maps directly to concrete workspace tools:</p>
            <ul>
              <li><p>Build and test tools: run build, lint, and unit tests.</p></li>
              <li>Extensions and MCP servers for automation and documentation lookups.</li>
            </ul>
            <ol>
              <li>Plan the next tool call carefully.</li>
              <li>Inspect tool output and adjust the next edit.</li>
            </ol>
            <pre>while (!done) {
  callTool();
}</pre>
          </article>
        </body>
      </html>
    `;

    const article = extractArticleFromHtml(htmlWithNestedBlocks, 'https://example.com/agents');
    const introOccurrences = article.paragraphs.filter((p) =>
      p.includes('Hi, My name is Lee Cuong, welcome to my blog!')
    );
    expect(introOccurrences).toHaveLength(1);
    expect(article.blocks?.some((b) => b.type === 'blockquote')).toBe(true);
    expect(article.blocks?.some((b) => b.type === 'h2' && b.text === 'My setup in VS Code')).toBe(true);
    expect(article.blocks?.filter((b) => b.type === 'li')).toHaveLength(2);
    expect(article.blocks?.filter((b) => b.type === 'ol-li').map((b) => b.listIndex)).toEqual([1, 2]);
    expect(article.blocks?.some((b) => b.type === 'pre' && b.text.includes('while (!done)'))).toBe(true);

    const styledPdf = await renderArticleToPdf(article, 'https://example.com/agents');
    const indexed = await extractPdfIndex(styledPdf);
    expect(indexed.extractedText).toContain('My setup in VS Code');
    expect(indexed.extractedText).toContain('while (!done)');
    const firstIdx = indexed.extractedText.indexOf('Hi, My name is Lee Cuong');
    const lastIdx = indexed.extractedText.lastIndexOf('Hi, My name is Lee Cuong');
    expect(firstIdx).toBeGreaterThan(-1);
    expect(lastIdx).toBe(firstIdx);
  });
});
