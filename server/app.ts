/** Headless Express REST and SSE API router for ingestion, PDF streaming, side chat, memory, and diagnostics. */
import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type {
  DiagnosticsSnapshot,
  DocumentDetailResponse,
} from '../src/shared/types.ts';
import type { FolioDatabase } from './db.ts';
import type { FileStorageManager } from './storage.ts';
import type { AppLogger } from './logger.ts';
import { fetchAndExtractUrl } from './pdf/urlIngestor.ts';
import { renderArticleToPdf } from './pdf/articlePdfRenderer.ts';
import { generateAnnotatedPdfBytes, generateBriefPdfBytes } from './pdf/generator.ts';
import { runSideChatTurn } from './ai/sideChatRevisionAgent.ts';
import { MemoryContextRetriever } from './memory/retriever.ts';
import {
  SynthesisPipeline,
  type DocumentSynthesizer,
  type TextEmbedder,
} from './pipeline/synthesisPipeline.ts';

export interface AppDependencies {
  db: FolioDatabase;
  storage: FileStorageManager;
  logger: AppLogger;
  synthesizer?: DocumentSynthesizer;
  embedder?: TextEmbedder;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
});

/** Strips URL fragments (`#...`) and outer whitespace for canonical URL deduplication. */
function normalizeUrlForLookup(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl.trim());
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return rawUrl.trim();
  }
}

/**
 * Builds the headless Express HTTP/SSE transport layer for FolioBrief.
 * Exposes ingestion, deduplication, PDF streaming, SSE chat, memory, and diagnostics routes.
 */
export function createApp(deps: AppDependencies) {
  const app = express();
  const { db, storage, logger } = deps;
  const retriever = new MemoryContextRetriever(db);
  const pipeline = new SynthesisPipeline({
    db,
    storage,
    logger,
    synthesizer: deps.synthesizer,
    embedder: deps.embedder,
  });

  app.use(express.json({ limit: '4mb' }));

  // Attach requestId for structured tracing
  app.use((req, res, next) => {
    const requestId = (req.headers['x-request-id'] as string) || crypto.randomUUID().slice(0, 8);
    res.locals.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    next();
  });

  // Health & Diagnostics
  app.get('/api/health', (_req, res) => {
    const health = db.getHealthInfo();
    res.json({
      status: health.sqliteIntegrity === 'ok' ? 'healthy' : 'degraded',
      ...health,
      uptimeSec: Math.round(process.uptime()),
    });
  });

  app.get('/api/diagnostics', (_req, res) => {
    const health = db.getHealthInfo();
    const storeStats = storage.getStorageStats();
    const snapshot: DiagnosticsSnapshot = {
      status: health.sqliteIntegrity === 'ok' ? 'healthy' : 'degraded',
      ...health,
      ...storeStats,
      recentLogs: logger.getRecentLogs(60),
      recentTraces: db.listRecentToolTraces(40),
    };
    res.json(snapshot);
  });

  app.post('/api/diagnostics/cleanup', (req, res) => {
    const removed = storage.cleanOrphanTempFiles();
    logger.info('maintenance', `Cleaned ${removed} orphan temp files`, { removed }, res.locals.requestId);
    res.json({ removed });
  });

  app.get('/api/diagnostics/bundle', (_req, res) => {
    const health = db.getHealthInfo();
    const storeStats = storage.getStorageStats();
    const bundle = {
      exportedAt: new Date().toISOString(),
      health,
      storage: storeStats,
      recentLogs: logger.getRecentLogs(150),
      recentTraces: db.listRecentToolTraces(100),
      memoryPreferences: db.listMemoryPreferences(),
    };
    const dateSlug = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="foliobrief-debug-${dateSlug}.json"`);
    res.send(JSON.stringify(bundle, null, 2));
  });

  // Document Library
  app.get('/api/documents', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : undefined;
    res.json({ documents: db.listDocuments(q) });
  });

  // Upload PDF
  app.post('/api/documents/upload', upload.single('file'), async (req, res) => {
    const requestId = res.locals.requestId;
    try {
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'Please select a PDF file to upload.' });
        return;
      }

      const header = Buffer.from(file.buffer.subarray(0, 5)).toString('utf8');
      if (header !== '%PDF-') {
        res.status(400).json({ error: 'Uploaded file is not a valid PDF document.' });
        return;
      }

      const contentHash = crypto.createHash('sha256').update(file.buffer).digest('hex');
      const force = req.query.force === 'true';
      const sync = req.query.sync === 'true';

      if (!force) {
        const existing = db.findDocumentByContentHash(contentHash);
        if (existing) {
          if (existing.jobStatus === 'interrupted' || existing.jobStatus === 'failed') {
            if (sync) {
              await pipeline.run(existing.id, requestId);
              res.status(200).json({
                documentId: existing.id,
                deduplicated: true,
                document: db.getDocumentById(existing.id),
              });
            } else {
              void pipeline.run(existing.id, requestId);
              res.status(202).json({ documentId: existing.id, deduplicated: true, jobStatus: 'queued' });
            }
            return;
          }
          logger.info('upload', `Deduplicated PDF upload -> ${existing.id}`, { contentHash }, requestId);
          res.status(200).json({
            documentId: existing.id,
            deduplicated: true,
            document: existing,
          });
          return;
        }
      }

      const docId = crypto.randomUUID();
      const rawName = (file.originalname || 'uploaded-paper.pdf').replace(/\.pdf$/i, '');
      const title = rawName.replace(/[_-]+/g, ' ').trim() || 'Uploaded Paper';
      const sourcePath = storage.getSourcePdfPath(docId);
      storage.writeFileAtomic(sourcePath, file.buffer);

      db.createDocument({
        id: docId,
        title,
        sourceType: 'pdf',
        sourcePdfPath: sourcePath,
        contentHash,
        jobStatus: 'queued',
      });

      if (sync) {
        await pipeline.run(docId, requestId);
        res.status(201).json({ document: db.getDocumentById(docId) });
      } else {
        void pipeline.run(docId, requestId);
        res.status(202).json({ documentId: docId, jobStatus: 'queued' });
      }
    } catch (err) {
      logger.error('upload', (err as Error).message, undefined, requestId);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Ingest URL -> Generate Source PDF -> Synthesize
  app.post('/api/documents/url', async (req, res) => {
    const requestId = res.locals.requestId;
    const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    if (!rawUrl) {
      res.status(400).json({ error: 'Please enter a valid article URL.' });
      return;
    }

    const normalizedUrl = normalizeUrlForLookup(rawUrl);
    const force = req.query.force === 'true';
    const sync = req.query.sync === 'true';

    try {
      if (!force) {
        const existing = db.findDocumentByUrl(normalizedUrl);
        if (existing) {
          if (existing.jobStatus === 'interrupted' || existing.jobStatus === 'failed') {
            if (sync) {
              await pipeline.run(existing.id, requestId);
              res.status(200).json({
                documentId: existing.id,
                deduplicated: true,
                document: db.getDocumentById(existing.id),
              });
            } else {
              void pipeline.run(existing.id, requestId);
              res.status(202).json({ documentId: existing.id, deduplicated: true, jobStatus: 'queued' });
            }
            return;
          }
          logger.info('url-ingest', `Deduplicated URL ingest -> ${existing.id}`, { normalizedUrl }, requestId);
          res.status(200).json({
            documentId: existing.id,
            deduplicated: true,
            document: existing,
          });
          return;
        }
      }

      const article = await fetchAndExtractUrl(normalizedUrl);
      const docId = crypto.randomUUID();
      const pdfBytes = await renderArticleToPdf(article, normalizedUrl);
      const contentHash = crypto.createHash('sha256').update(pdfBytes).digest('hex');
      const sourcePath = storage.getSourcePdfPath(docId);
      storage.writeFileAtomic(sourcePath, pdfBytes);

      db.createDocument({
        id: docId,
        title: article.title,
        sourceType: 'url',
        sourceUrl: normalizedUrl,
        sourceDomain: article.sourceDomain,
        sourcePdfPath: sourcePath,
        contentHash,
        jobStatus: 'queued',
      });

      if (sync) {
        await pipeline.run(docId, requestId);
        res.status(201).json({ document: db.getDocumentById(docId) });
      } else {
        void pipeline.run(docId, requestId);
        res.status(202).json({ documentId: docId, jobStatus: 'queued' });
      }
    } catch (err) {
      const message = (err as Error).message;
      logger.warn('url-ingest', `URL ingest rejected/failed: ${message}`, { rawUrl }, requestId);
      const statusCode =
        /invalid|restricted|blocked|private|localhost|http/i.test(message) ? 400 : 422;
      res.status(statusCode).json({ error: message });
    }
  });

  // Fallback Text Paste Ingestion (when a site blocks scraping/paywalls)
  app.post('/api/documents/text', async (req, res) => {
    const requestId = res.locals.requestId;
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    const sourceUrl = typeof req.body?.sourceUrl === 'string' ? req.body.sourceUrl.trim() : null;

    if (!title || text.length < 60) {
      res.status(400).json({ error: 'Provide a title and at least 60 characters of article text.' });
      return;
    }

    try {
      const paragraphs = text
        .split(/\n{2,}|\r\n\r\n/)
        .map((p: string) => p.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      const normalizedText = paragraphs.join('\n\n');
      const contentHash = crypto.createHash('sha256').update(`text:${normalizedText}`).digest('hex');
      const force = req.query.force === 'true';
      const sync = req.query.sync === 'true';

      if (!force) {
        const existing = db.findDocumentByContentHash(contentHash);
        if (existing) {
          if (existing.jobStatus === 'interrupted' || existing.jobStatus === 'failed') {
            if (sync) {
              await pipeline.run(existing.id, requestId);
              res.status(200).json({
                documentId: existing.id,
                deduplicated: true,
                document: db.getDocumentById(existing.id),
              });
            } else {
              void pipeline.run(existing.id, requestId);
              res.status(202).json({ documentId: existing.id, deduplicated: true, jobStatus: 'queued' });
            }
            return;
          }
          logger.info('text-ingest', `Deduplicated text ingest -> ${existing.id}`, { contentHash }, requestId);
          res.status(200).json({
            documentId: existing.id,
            deduplicated: true,
            document: existing,
          });
          return;
        }
      }

      const docId = crypto.randomUUID();
      let sourceDomain = 'Pasted Text';
      if (sourceUrl) {
        try {
          sourceDomain = new URL(sourceUrl).hostname.replace(/^www\./, '');
        } catch {
          sourceDomain = 'Pasted Text';
        }
      }

      const pdfBytes = await renderArticleToPdf(
        {
          title,
          byline: null,
          siteName: null,
          sourceDomain,
          textContent: normalizedText,
          paragraphs,
        },
        sourceUrl
      );

      const sourcePath = storage.getSourcePdfPath(docId);
      storage.writeFileAtomic(sourcePath, pdfBytes);

      db.createDocument({
        id: docId,
        title,
        sourceType: 'text',
        sourceUrl,
        sourceDomain,
        sourcePdfPath: sourcePath,
        contentHash,
        jobStatus: 'queued',
      });

      if (sync) {
        await pipeline.run(docId, requestId);
        res.status(201).json({ document: db.getDocumentById(docId) });
      } else {
        void pipeline.run(docId, requestId);
        res.status(202).json({ documentId: docId, jobStatus: 'queued' });
      }
    } catch (err) {
      logger.error('text-ingest', (err as Error).message, undefined, requestId);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Resume Interrupted or Failed Analysis
  app.post('/api/documents/:id/resume', async (req, res) => {
    const doc = db.getDocumentById(req.params.id);
    if (!doc) {
      res.status(404).json({ error: 'Document not found.' });
      return;
    }
    const sync = req.query.sync === 'true';
    if (sync) {
      await pipeline.run(doc.id, res.locals.requestId);
      res.json({ document: db.getDocumentById(doc.id) });
    } else {
      void pipeline.run(doc.id, res.locals.requestId);
      res.status(202).json({ documentId: doc.id, jobStatus: 'queued' });
    }
  });

  // Document Detail
  app.get('/api/documents/:id', (req, res) => {
    const doc = db.getDocumentById(req.params.id);
    if (!doc) {
      res.status(404).json({ error: 'Document not found.' });
      return;
    }

    const latestVersion = db.getLatestAnalysisVersion(doc.id);
    const versions = db.listAnalysisVersions(doc.id);
    const chatMessages = db.listChatMessages(doc.id);
    const relatedDocuments = retriever.findRelatedDocuments({
      excludeDocumentId: doc.id,
      queryEmbedding: doc.embeddingVector,
      fallbackKeywords: doc.title,
      limit: 3,
    });

    const { pageIndex: _pi, embeddingVector: _ev, ...docSummary } = doc;
    const payload: DocumentDetailResponse = {
      document: docSummary,
      latestVersion,
      versions,
      chatMessages,
      relatedDocuments: relatedDocuments.map((r) => ({
        id: r.id,
        title: r.title,
        sourceDomain: r.sourceDomain,
        similarity: r.similarity,
        createdAt: r.createdAt,
      })),
    };
    res.json(payload);
  });

  // Delete Document
  app.delete('/api/documents/:id', (req, res) => {
    const deleted = db.deleteDocument(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Document not found.' });
      return;
    }
    storage.deleteDocumentFiles(req.params.id);
    res.json({ deleted: true });
  });

  // Stream Source PDF (original uploaded PDF or URL-generated PDF)
  app.get('/api/documents/:id/pdf/source', (req, res) => {
    const doc = db.getDocumentById(req.params.id);
    if (!doc || !doc.sourcePdfPath || !fs.existsSync(doc.sourcePdfPath)) {
      res.status(404).json({ error: 'Source PDF not found.' });
      return;
    }
    const safeName = doc.title.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60) || 'article';
    const disposition = req.query.download === '1' ? 'attachment' : 'inline';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${disposition}; filename="${safeName}-source.pdf"`);
    fs.createReadStream(doc.sourcePdfPath).pipe(res);
  });

  // Stream Executive Brief PDF
  app.get('/api/documents/:id/pdf/brief', async (req, res) => {
    const doc = db.getDocumentById(req.params.id);
    const latest = doc ? db.getLatestAnalysisVersion(doc.id) : null;
    if (!doc || !latest) {
      res.status(404).json({ error: 'Executive Brief PDF is not ready yet.' });
      return;
    }

    const briefBytes = await generateBriefPdfBytes({
      title: doc.title,
      sourceDomain: doc.sourceDomain,
      version: latest,
    });
    const briefPath = storage.getBriefPdfPath(doc.id, latest.versionNumber);
    storage.writeFileAtomic(briefPath, briefBytes);
    if (latest.briefPdfPath !== briefPath) {
      db.updateVersionPdfPaths(latest.id, { briefPdfPath: briefPath });
    }

    const safeName = doc.title.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60) || 'brief';
    const disposition = req.query.download === '1' ? 'attachment' : 'inline';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `${disposition}; filename="${safeName}-brief-v${latest.versionNumber}.pdf"`
    );
    fs.createReadStream(briefPath).pipe(res);
  });

  // Stream Annotated Source PDF (Lazy Materialization)
  app.get('/api/documents/:id/pdf/annotated', async (req, res) => {
    const doc = db.getDocumentById(req.params.id);
    const latest = doc ? db.getLatestAnalysisVersion(doc.id) : null;
    if (!doc || !latest || !doc.sourcePdfPath || !fs.existsSync(doc.sourcePdfPath)) {
      res.status(404).json({ error: 'Annotated PDF cannot be generated because source PDF is missing.' });
      return;
    }

    try {
      let annotatedPath = latest.annotatedPdfPath;
      if (latest.annotatedPdfDirty || !annotatedPath || !fs.existsSync(annotatedPath)) {
        const sourceBytes = new Uint8Array(fs.readFileSync(doc.sourcePdfPath));
        const annotatedBytes = await generateAnnotatedPdfBytes({
          sourcePdfBytes: sourceBytes,
          highlights: latest.highlights,
          pageIndex: doc.pageIndex,
        });
        annotatedPath = storage.getAnnotatedPdfPath(doc.id, latest.versionNumber);
        storage.writeFileAtomic(annotatedPath, annotatedBytes);
        db.updateVersionPdfPaths(latest.id, {
          annotatedPdfPath: annotatedPath,
          annotatedPdfDirty: false,
        });
        storage.pruneOldVersionPdfs(doc.id, latest.versionNumber);
      }

      const safeName = doc.title.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60) || 'annotated';
      const disposition = req.query.download === '1' ? 'attachment' : 'inline';
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `${disposition}; filename="${safeName}-annotated-v${latest.versionNumber}.pdf"`
      );
      fs.createReadStream(annotatedPath).pipe(res);
    } catch (err) {
      logger.error('annotated-pdf', (err as Error).message, { documentId: doc.id }, res.locals.requestId);
      res.status(500).json({ error: 'Failed to generate annotated PDF.' });
    }
  });

  // Revert Analysis Version (One-Click Undo)
  app.post('/api/documents/:id/revert', async (req, res) => {
    const doc = db.getDocumentById(req.params.id);
    const targetVersion = Number(req.body?.versionNumber);
    if (!doc || !Number.isFinite(targetVersion)) {
      res.status(400).json({ error: 'Valid document ID and versionNumber are required.' });
      return;
    }

    const reverted = db.revertToVersion(doc.id, targetVersion);
    if (!reverted) {
      res.status(404).json({ error: `Version v${targetVersion} not found.` });
      return;
    }

    const briefBytes = await generateBriefPdfBytes({
      title: doc.title,
      sourceDomain: doc.sourceDomain,
      version: reverted,
    });
    const briefPath = storage.getBriefPdfPath(doc.id, reverted.versionNumber);
    storage.writeFileAtomic(briefPath, briefBytes);
    db.updateVersionPdfPaths(reverted.id, { briefPdfPath: briefPath });
    reverted.briefPdfPath = briefPath;

    res.json({
      latestVersion: reverted,
      versions: db.listAnalysisVersions(doc.id),
    });
  });

  // Side Chat & Live Revision SSE Stream
  app.post('/api/documents/:id/chat', async (req, res) => {
    const requestId = res.locals.requestId;
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    const referencedHighlightIds = Array.isArray(req.body?.referencedHighlightIds)
      ? req.body.referencedHighlightIds.map(String)
      : [];

    if (!message) {
      res.status(400).json({ error: 'Message cannot be empty.' });
      return;
    }

    const doc = db.getDocumentById(req.params.id);
    if (!doc) {
      res.status(404).json({ error: 'Document not found.' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const sendEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const outcome = await runSideChatTurn({
        db,
        storage,
        logger,
        documentId: doc.id,
        userMessage: message,
        referencedHighlightIds,
        callbacks: {
          onDelta: (text) => sendEvent('delta', { text }),
          onRevision: (version) =>
            sendEvent('revision', {
              latestVersion: version,
              versions: db.listAnalysisVersions(doc.id),
            }),
          onTrace: (trace) => sendEvent('trace', { trace }),
        },
      });

      sendEvent('done', {
        assistantMessage: outcome.assistantMessage,
        latestVersion: outcome.latestVersion,
        versions: db.listAnalysisVersions(doc.id),
      });
      res.end();
    } catch (err) {
      const errMsg = (err as Error).message || 'Chat failed.';
      logger.error('chat', errMsg, { documentId: doc.id }, requestId);
      sendEvent('error', { error: errMsg });
      res.end();
    }
  });

  // Long-Term Memory Preferences
  app.get('/api/memory', (_req, res) => {
    res.json({ preferences: db.listMemoryPreferences() });
  });

  app.post('/api/memory', (req, res) => {
    const preferenceKey = typeof req.body?.preferenceKey === 'string' ? req.body.preferenceKey.trim() : '';
    const learnedRule = typeof req.body?.learnedRule === 'string' ? req.body.learnedRule.trim() : '';
    if (!preferenceKey || !learnedRule) {
      res.status(400).json({ error: 'preferenceKey and learnedRule are required.' });
      return;
    }
    const cleanKey = preferenceKey.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
    const record = db.upsertMemoryPreference({
      preferenceKey: cleanKey,
      learnedRule,
      sourceEvidence: 'Added manually in Memory Preferences',
      confidence: 1.0,
    });
    res.status(201).json({ preference: record });
  });

  app.delete('/api/memory/:id', (req, res) => {
    const ok = db.deleteMemoryPreference(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'Preference not found.' });
      return;
    }
    res.json({ deleted: true });
  });

  return app;
}
