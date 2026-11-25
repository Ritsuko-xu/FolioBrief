/** Integration tests for Express API routes, ingestion deduplication, lazy PDF export, and diagnostics. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { FolioDatabase } from '../../server/db.ts';
import { FileStorageManager } from '../../server/storage.ts';
import { AppLogger } from '../../server/logger.ts';
import { createApp } from '../../server/app.ts';

async function createSamplePdfBuffer(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText('Sparse KV Caching improves throughput by 3.2x for long documents.', {
    x: 50,
    y: 720,
    size: 12,
    font,
  });
  const bytes = await doc.save();
  return Buffer.from(bytes);
}

describe('Headless Express API, Deduplication, Lazy PDF Materialization & Diagnostics', () => {
  let tmpDir: string;
  let db: FolioDatabase;
  let storage: FileStorageManager;
  let logger: AppLogger;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foliobrief-g4-'));
    storage = new FileStorageManager(tmpDir);
    logger = new AppLogger(storage.logsDir);
    db = new FolioDatabase(path.join(tmpDir, 'foliobrief.db'));
    app = createApp({
      db,
      storage,
      logger,
      synthesizer: async ({ title }) => ({
        summary: `Executive synthesis for ${title}.`,
        keyInsights: ['Sparse KV caching slashes memory bandwidth.'],
        improvements: ['Achieves 3.2x higher serving throughput.'],
        openQuestions: ['How does it behave under multi-turn chat?'],
        highlights: [
          {
            id: 'hl-mock1',
            page: 1,
            quoteAnchor: 'Sparse KV Caching improves throughput',
            category: 'claim',
            comment: 'Headline benchmark gain',
          },
        ],
      }),
      embedder: async () => [0.5, 0.5, 0.0],
    });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uploads a PDF, synthesizes Brief, lazily builds Annotated PDF, and supports Revert', async () => {
    const pdfBuf = await createSamplePdfBuffer();

    const uploadRes = await request(app)
      .post('/api/documents/upload?sync=true')
      .attach('file', pdfBuf, 'kv-paper.pdf');

    expect(uploadRes.status).toBe(201);
    const docId = uploadRes.body.document.id as string;
    expect(uploadRes.body.document.jobStatus).toBe('ready');

    // Fetch detail
    const detailRes = await request(app).get(`/api/documents/${docId}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.latestVersion.versionNumber).toBe(1);
    expect(detailRes.body.latestVersion.annotatedPdfDirty).toBe(true);

    // Download Brief PDF
    const briefRes = await request(app).get(`/api/documents/${docId}/pdf/brief?download=1`);
    expect(briefRes.status).toBe(200);
    expect(briefRes.headers['content-type']).toContain('application/pdf');

    // Lazy Annotated PDF build on first download clears dirty flag
    const annotRes = await request(app).get(`/api/documents/${docId}/pdf/annotated?download=1`);
    expect(annotRes.status).toBe(200);
    expect(annotRes.headers['content-type']).toContain('application/pdf');

    const afterDetail = await request(app).get(`/api/documents/${docId}`);
    expect(afterDetail.body.latestVersion.annotatedPdfDirty).toBe(false);

    // Revert to v1 creates v2 cleanly
    const revertRes = await request(app)
      .post(`/api/documents/${docId}/revert`)
      .send({ versionNumber: 1 });
    expect(revertRes.status).toBe(200);
    expect(revertRes.body.latestVersion.versionNumber).toBe(2);
  });

  it('rejects unsafe SSRF URLs and supports fallback text ingestion', async () => {
    const ssrfRes = await request(app)
      .post('/api/documents/url')
      .send({ url: 'http://127.0.0.1:3000/api/health' });
    expect(ssrfRes.status).toBe(400);

    const textRes = await request(app)
      .post('/api/documents/text?sync=true')
      .send({
        title: 'Paywalled Engineering Note',
        text: 'This engineering report covers distributed consensus protocols and Raft leader election optimizations in high-latency WAN environments.',
      });
    expect(textRes.status).toBe(201);
    expect(textRes.body.document.sourceType).toBe('text');
    expect(textRes.body.document.jobStatus).toBe('ready');
  });

  it('exposes health, diagnostics, cleanup, and memory preference endpoints', async () => {
    const healthRes = await request(app).get('/api/health');
    expect(healthRes.status).toBe(200);
    expect(healthRes.body.status).toBe('healthy');
    expect(healthRes.body.sqliteWalMode.toLowerCase()).toBe('wal');

    const memRes = await request(app)
      .post('/api/memory')
      .send({ preferenceKey: 'concise_style', learnedRule: 'Keep bullet points under 18 words.' });
    expect(memRes.status).toBe(201);

    const diagRes = await request(app).get('/api/diagnostics');
    expect(diagRes.status).toBe(200);
    expect(diagRes.body.sqliteIntegrity.toLowerCase()).toBe('ok');
  });

  it('deduplicates repeated PDF uploads by content hash without creating a duplicate record', async () => {
    let synthCalls = 0;
    const countingApp = createApp({
      db,
      storage,
      logger,
      synthesizer: async ({ title }) => {
        synthCalls += 1;
        return {
          summary: `Synthesis ${title}`,
          keyInsights: ['Insight 1'],
          improvements: ['Improvement 1'],
          openQuestions: ['Question 1'],
          highlights: [],
        };
      },
      embedder: async () => [0.1, 0.2, 0.3],
    });

    const pdfBuf = await createSamplePdfBuffer();
    const first = await request(countingApp)
      .post('/api/documents/upload?sync=true')
      .attach('file', pdfBuf, 'repeat.pdf');
    expect(first.status).toBe(201);
    expect(synthCalls).toBe(1);
    expect(db.listDocuments().length).toBe(1);

    // Second upload of identical PDF bytes returns existing document with zero re-synthesis
    const second = await request(countingApp)
      .post('/api/documents/upload?sync=true')
      .attach('file', pdfBuf, 'repeat-renamed.pdf');
    expect(second.status).toBe(200);
    expect(second.body.deduplicated).toBe(true);
    expect(second.body.documentId).toBe(first.body.document.id);
    expect(synthCalls).toBe(1);
    expect(db.listDocuments().length).toBe(1);
  });

  it('deduplicates repeated URL ingests by normalized URL without creating a duplicate record', async () => {
    let synthCalls = 0;
    const countingApp = createApp({
      db,
      storage,
      logger,
      synthesizer: async ({ title }) => {
        synthCalls += 1;
        return {
          summary: `Synthesis ${title}`,
          keyInsights: ['Insight 1'],
          improvements: ['Improvement 1'],
          openQuestions: ['Question 1'],
          highlights: [],
        };
      },
      embedder: async () => [0.1, 0.2, 0.3],
    });

    const existingUrlDoc = db.createDocument({
      title: 'Cached Article',
      sourceType: 'url',
      sourceUrl: 'https://example.org/cached-article',
      sourceDomain: 'example.org',
      jobStatus: 'ready',
    });

    const dupUrl = await request(countingApp)
      .post('/api/documents/url')
      .send({ url: 'https://example.org/cached-article#section-2' });
    expect(dupUrl.status).toBe(200);
    expect(dupUrl.body.deduplicated).toBe(true);
    expect(dupUrl.body.documentId).toBe(existingUrlDoc.id);
    expect(synthCalls).toBe(0);
    expect(db.listDocuments().length).toBe(1);
  });

  it('deduplicates pasted text by normalized body regardless of title or whitespace changes', async () => {
    let synthCalls = 0;
    const countingApp = createApp({
      db,
      storage,
      logger,
      synthesizer: async ({ title }) => {
        synthCalls += 1;
        return {
          summary: `Synthesis ${title}`,
          keyInsights: ['Insight 1'],
          improvements: ['Improvement 1'],
          openQuestions: ['Question 1'],
          highlights: [],
        };
      },
      embedder: async () => [0.1, 0.2, 0.3],
    });

    const first = await request(countingApp)
      .post('/api/documents/text?sync=true')
      .send({
        title: 'Consensus Notes',
        text: 'First paragraph about distributed consensus.\n\nSecond paragraph about Raft leader election.',
      });
    expect(first.status).toBe(201);
    expect(synthCalls).toBe(1);
    expect(db.listDocuments().length).toBe(1);

    // Same body with extra spaces/CRLF and a different title reuses the existing record
    const duplicate = await request(countingApp)
      .post('/api/documents/text?sync=true')
      .send({
        title: 'Different Custom Title',
        text: 'First   paragraph about distributed consensus.\r\n\r\n  Second paragraph about\tRaft leader election.  ',
      });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.deduplicated).toBe(true);
    expect(duplicate.body.documentId).toBe(first.body.document.id);
    expect(synthCalls).toBe(1);
    expect(db.listDocuments().length).toBe(1);

    // Same title with genuinely different text creates a new record
    const differentBody = await request(countingApp)
      .post('/api/documents/text?sync=true')
      .send({
        title: 'Consensus Notes',
        text: 'Completely different article body discussing Paxos quorums and clock drift bounds.',
      });
    expect(differentBody.status).toBe(201);
    expect(differentBody.body.document.id).not.toBe(first.body.document.id);
    expect(synthCalls).toBe(2);
    expect(db.listDocuments().length).toBe(2);

    // force=true bypasses deduplication even for identical text
    const forced = await request(countingApp)
      .post('/api/documents/text?sync=true&force=true')
      .send({
        title: 'Consensus Notes',
        text: 'First paragraph about distributed consensus.\n\nSecond paragraph about Raft leader election.',
      });
    expect(forced.status).toBe(201);
    expect(forced.body.document.id).not.toBe(first.body.document.id);
    expect(synthCalls).toBe(3);
    expect(db.listDocuments().length).toBe(3);
  });

  it('re-runs failed/interrupted duplicate PDF uploads and rejects missing or invalid HTTP inputs (400/404)', async () => {
    let synthCalls = 0;
    const apiApp = createApp({
      db,
      storage,
      logger,
      synthesizer: async () => {
        synthCalls += 1;
        return {
          summary: 'Recovered synthesis',
          keyInsights: ['Recovered'],
          improvements: [],
          openQuestions: [],
          highlights: [],
        };
      },
      embedder: async () => [0.5, 0.5],
    });

    // 400 checks on invalid/missing inputs
    const missingFile = await request(apiApp).post('/api/documents/upload');
    expect(missingFile.status).toBe(400);

    const nonPdfFile = await request(apiApp)
      .post('/api/documents/upload')
      .attach('file', Buffer.from('not-a-pdf-header'), 'fake.pdf');
    expect(nonPdfFile.status).toBe(400);

    const emptyUrl = await request(apiApp).post('/api/documents/url').send({ url: '   ' });
    expect(emptyUrl.status).toBe(400);

    const shortText = await request(apiApp)
      .post('/api/documents/text')
      .send({ title: 'Short', text: 'Too short' });
    expect(shortText.status).toBe(400);

    const badMem = await request(apiApp).post('/api/memory').send({ preferenceKey: '  ', learnedRule: '' });
    expect(badMem.status).toBe(400);

    // 404 checks on nonexistent IDs
    expect((await request(apiApp).get('/api/documents/missing-id')).status).toBe(404);
    expect((await request(apiApp).delete('/api/documents/missing-id')).status).toBe(404);
    expect((await request(apiApp).post('/api/documents/missing-id/resume')).status).toBe(404);
    expect((await request(apiApp).get('/api/documents/missing-id/pdf/source')).status).toBe(404);
    expect((await request(apiApp).get('/api/documents/missing-id/pdf/brief')).status).toBe(404);
    expect((await request(apiApp).get('/api/documents/missing-id/pdf/annotated')).status).toBe(404);
    expect((await request(apiApp).delete('/api/memory/missing-mem')).status).toBe(404);

    // Chat validation (400 empty message, 404 unknown document)
    const emptyChat = await request(apiApp).post('/api/documents/any/chat').send({ message: '   ' });
    expect(emptyChat.status).toBe(400);
    const missingChat = await request(apiApp).post('/api/documents/missing-id/chat').send({ message: 'Hello' });
    expect(missingChat.status).toBe(404);

    // Re-uploading a failed duplicate PDF re-runs synthesis on the same record
    const pdfBuf = await createSamplePdfBuffer();
    const first = await request(apiApp)
      .post('/api/documents/upload?sync=true')
      .attach('file', pdfBuf, 'retry.pdf');
    const docId = first.body.document.id as string;
    db.updateDocument(docId, { jobStatus: 'failed', errorMessage: 'Simulated transient crash' });

    const retried = await request(apiApp)
      .post('/api/documents/upload?sync=true')
      .attach('file', pdfBuf, 'retry.pdf');
    expect(retried.status).toBe(200);
    expect(retried.body.deduplicated).toBe(true);
    expect(retried.body.document.jobStatus).toBe('ready');
    expect(synthCalls).toBe(2);

    // Revert invalid input (400) and out-of-range version (404)
    expect(
      (await request(apiApp).post(`/api/documents/${docId}/revert`).send({ versionNumber: 'abc' })).status
    ).toBe(400);
    expect(
      (await request(apiApp).post(`/api/documents/${docId}/revert`).send({ versionNumber: 999 })).status
    ).toBe(404);

    // Delete document removes both SQLite row and PDF directory
    expect(fs.existsSync(storage.getDocumentDir(docId))).toBe(true);
    const delDoc = await request(apiApp).delete(`/api/documents/${docId}`);
    expect(delDoc.status).toBe(200);
    expect(delDoc.body.deleted).toBe(true);
    expect(db.getDocumentById(docId)).toBeNull();
    expect(fs.existsSync(path.join(storage.pdfsDir, docId))).toBe(false);
  });

  it('supports memory deletion, diagnostics temp cleanup, and debug bundle export', async () => {
    const memCreate = await request(app)
      .post('/api/memory')
      .send({ preferenceKey: 'Memory-Budget!', learnedRule: 'Note activation memory costs.' });
    expect(memCreate.status).toBe(201);
    const memId = memCreate.body.preference.id as string;
    expect(memCreate.body.preference.preferenceKey).toBe('memory_budget_');

    const memDel = await request(app).delete(`/api/memory/${memId}`);
    expect(memDel.status).toBe(200);
    expect(db.listMemoryPreferences()).toEqual([]);

    const docDir = storage.getDocumentDir('temp-holder');
    fs.writeFileSync(path.join(docDir, 'brief_v1.pdf.deadbeef.tmp'), 'partial');

    const cleanupRes = await request(app).post('/api/diagnostics/cleanup');
    expect(cleanupRes.status).toBe(200);
    expect(cleanupRes.body.removed).toBe(1);

    const bundleRes = await request(app).get('/api/diagnostics/bundle');
    expect(bundleRes.status).toBe(200);
    expect(bundleRes.headers['content-disposition']).toContain('foliobrief-debug-');
    const parsedBundle = JSON.parse(bundleRes.text) as { health: { status?: string }; recentLogs: unknown[] };
    expect(Array.isArray(parsedBundle.recentLogs)).toBe(true);
  });
});
