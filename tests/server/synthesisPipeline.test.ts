/** Tests for SynthesisPipeline execution, embedding tolerance, missing/scanned PDF failures, and job recovery. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { FolioDatabase } from '../../server/db.ts';
import { FileStorageManager } from '../../server/storage.ts';
import { AppLogger } from '../../server/logger.ts';
import { SynthesisPipeline } from '../../server/pipeline/synthesisPipeline.ts';

async function createSamplePdfBuffer(text?: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  if (text) {
    page.drawText(text, { x: 50, y: 720, size: 12, font });
  }
  return Buffer.from(await doc.save());
}

describe('SynthesisPipeline: Execution, Recovery & Failure Transitions', () => {
  let tmpDir: string;
  let db: FolioDatabase;
  let storage: FileStorageManager;
  let logger: AppLogger;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foliobrief-pipe-'));
    storage = new FileStorageManager(tmpDir);
    logger = new AppLogger(storage.logsDir);
    db = new FolioDatabase(path.join(tmpDir, 'foliobrief.db'), logger);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs SynthesisPipeline standalone without Express HTTP layer', async () => {
    const pdfBuf = await createSamplePdfBuffer(
      'Sparse KV Caching improves throughput by 3.2x for long documents.'
    );
    const doc = db.createDocument({
      title: 'Standalone Pipeline Paper',
      sourceType: 'pdf',
      sourcePdfPath: storage.getSourcePdfPath('standalone-1'),
      jobStatus: 'queued',
    });
    storage.writeFileAtomic(doc.sourcePdfPath!, pdfBuf);

    const pipeline = new SynthesisPipeline({
      db,
      storage,
      logger,
      synthesizer: async () => ({
        summary: 'Standalone synthesis complete.',
        keyInsights: ['Modular pipeline'],
        improvements: ['Testable outside Express'],
        openQuestions: ['Add concurrency queue later?'],
        highlights: [],
      }),
      embedder: async () => [0.2, 0.8],
    });

    await pipeline.run(doc.id, 'test-req');
    const updated = db.getDocumentById(doc.id);
    expect(updated?.jobStatus).toBe('ready');
    expect(updated?.embeddingVector).toEqual([0.2, 0.8]);
    expect(db.getLatestAnalysisVersion(doc.id)?.summary).toBe('Standalone synthesis complete.');
  });

  it('completes cleanly even when embedder returns null and ignores missing documentId', async () => {
    const pdfBuf = await createSamplePdfBuffer(
      'Wait-free ring buffers eliminate lock contention across worker threads.'
    );
    const doc = db.createDocument({
      title: 'No Embedding Paper',
      sourceType: 'pdf',
      sourcePdfPath: storage.getSourcePdfPath('no-embed-1'),
      jobStatus: 'queued',
    });
    storage.writeFileAtomic(doc.sourcePdfPath!, pdfBuf);

    const pipeline = new SynthesisPipeline({
      db,
      storage,
      logger,
      synthesizer: async () => ({
        summary: 'Works without embeddings.',
        keyInsights: ['Zero lock overhead'],
        improvements: [],
        openQuestions: [],
        highlights: [],
      }),
      embedder: async () => null,
    });

    await expect(pipeline.run('missing-doc-id')).resolves.toBeUndefined();
    await pipeline.run(doc.id);

    const updated = db.getDocumentById(doc.id);
    expect(updated?.jobStatus).toBe('ready');
    expect(updated?.embeddingVector).toBeNull();
  });

  it('marks document as failed when source PDF is missing on disk', async () => {
    const doc = db.createDocument({
      title: 'Missing Source PDF',
      sourceType: 'pdf',
      sourcePdfPath: path.join(tmpDir, 'does-not-exist.pdf'),
      jobStatus: 'queued',
    });

    const pipeline = new SynthesisPipeline({
      db,
      storage,
      logger,
      synthesizer: async () => {
        throw new Error('Should not run synthesizer');
      },
      embedder: async () => null,
    });

    await pipeline.run(doc.id, 'req-missing');
    const updated = db.getDocumentById(doc.id);
    expect(updated?.jobStatus).toBe('failed');
    expect(updated?.errorMessage).toContain('Source PDF file is missing');
  });

  it('marks document as failed for scanned or image-only PDFs with too little text', async () => {
    const blankPdf = await createSamplePdfBuffer();
    const doc = db.createDocument({
      title: 'Scanned Paper',
      sourceType: 'pdf',
      sourcePdfPath: storage.getSourcePdfPath('scanned-1'),
      jobStatus: 'queued',
    });
    storage.writeFileAtomic(doc.sourcePdfPath!, blankPdf);

    const pipeline = new SynthesisPipeline({
      db,
      storage,
      logger,
      synthesizer: async () => {
        throw new Error('Should not run synthesizer');
      },
      embedder: async () => null,
    });

    await pipeline.run(doc.id, 'req-scanned');
    const updated = db.getDocumentById(doc.id);
    expect(updated?.jobStatus).toBe('failed');
    expect(updated?.errorMessage).toContain('No extractable text found');
  });

  it('marks document as failed and logs error if synthesizer throws', async () => {
    const pdfBuf = await createSamplePdfBuffer(
      'Gradient checkpointing trades compute for reduced activation memory usage.'
    );
    const doc = db.createDocument({
      title: 'Synthesizer Failure Paper',
      sourceType: 'pdf',
      sourcePdfPath: storage.getSourcePdfPath('synth-err-1'),
      jobStatus: 'queued',
    });
    storage.writeFileAtomic(doc.sourcePdfPath!, pdfBuf);

    const pipeline = new SynthesisPipeline({
      db,
      storage,
      logger,
      synthesizer: async () => {
        throw new Error('Gemini 429 quota exceeded');
      },
      embedder: async () => [0.1, 0.9],
    });

    await pipeline.run(doc.id, 'req-synth-err');
    const updated = db.getDocumentById(doc.id);
    expect(updated?.jobStatus).toBe('failed');
    expect(updated?.errorMessage).toContain('Gemini 429 quota exceeded');
  });
});
