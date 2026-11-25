/** Background ingestion pipeline: text indexing, embeddings, memory lookup, `documentSynthesisAgent`, and `brief_v1.pdf`. */
import fs from 'node:fs';
import type { AnalysisPayload, PageIndexEntry } from '../../src/shared/types.ts';
import type { FolioDatabase } from '../db.ts';
import type { FileStorageManager } from '../storage.ts';
import type { AppLogger } from '../logger.ts';
import { extractPdfIndex } from '../pdf/extractor.ts';
import { generateBriefPdfBytes } from '../pdf/generator.ts';
import { generateTextEmbedding } from '../ai/geminiClient.ts';
import { synthesizeDocumentAnalysis } from '../ai/documentSynthesisAgent.ts';
import { MemoryContextRetriever } from '../memory/retriever.ts';

export type DocumentSynthesizer = (input: {
  title: string;
  extractedText: string;
  pageIndex: PageIndexEntry[];
  memoryContextBlock?: string;
}) => Promise<AnalysisPayload>;

export type TextEmbedder = (text: string) => Promise<number[] | null>;

export interface SynthesisPipelineDeps {
  db: FolioDatabase;
  storage: FileStorageManager;
  logger: AppLogger;
  synthesizer?: DocumentSynthesizer;
  embedder?: TextEmbedder;
}

/** Orchestrates background PDF indexing, embedding, memory retrieval, AI synthesis, and Brief PDF generation. */
export class SynthesisPipeline {
  private readonly db: FolioDatabase;
  private readonly storage: FileStorageManager;
  private readonly logger: AppLogger;
  private readonly synthesize: DocumentSynthesizer;
  private readonly embed: TextEmbedder;
  private readonly retriever: MemoryContextRetriever;

  constructor(deps: SynthesisPipelineDeps) {
    this.db = deps.db;
    this.storage = deps.storage;
    this.logger = deps.logger;
    this.synthesize = deps.synthesizer ?? synthesizeDocumentAnalysis;
    this.embed = deps.embedder ?? generateTextEmbedding;
    this.retriever = new MemoryContextRetriever(this.db);
  }

  /** Runs extraction -> embedding -> memory lookup -> Gemini synthesis -> Brief PDF export for `documentId`. */
  async run(documentId: string, requestId?: string): Promise<void> {
    const doc = this.db.getDocumentById(documentId);
    if (!doc) return;

    try {
      this.db.updateDocument(documentId, { jobStatus: 'extracting', errorMessage: null });

      if (!doc.sourcePdfPath || !fs.existsSync(doc.sourcePdfPath)) {
        throw new Error('Source PDF file is missing on disk.');
      }

      const sourceBytes = new Uint8Array(fs.readFileSync(doc.sourcePdfPath));
      const indexed = await extractPdfIndex(sourceBytes);

      if (!indexed.extractedText || indexed.extractedText.trim().length < 20) {
        throw new Error(
          'No extractable text found in this PDF (it may be an un-OCRed scanned image PDF).'
        );
      }

      this.db.updateDocument(documentId, {
        jobStatus: 'synthesizing',
        extractedText: indexed.extractedText,
        pageIndex: indexed.pageIndex,
        pageCount: indexed.pageCount,
      });

      const vector = await this.embed(`${doc.title}\n\n${indexed.extractedText}`);
      if (vector) {
        this.db.updateDocument(documentId, { embeddingVector: vector });
      }

      const memCtx = this.retriever.buildPersonalizedContextBlock({
        excludeDocumentId: documentId,
        queryEmbedding: vector,
        fallbackKeywords: doc.title,
      });

      const payload = await this.synthesize({
        title: doc.title,
        extractedText: indexed.extractedText,
        pageIndex: indexed.pageIndex,
        memoryContextBlock: memCtx.promptBlock,
      });

      const version = this.db.createAnalysisVersion({
        documentId,
        payload,
        annotatedPdfDirty: true,
        revisionReason: 'Initial AI synthesis',
      });

      const briefBytes = await generateBriefPdfBytes({
        title: doc.title,
        sourceDomain: doc.sourceDomain,
        version,
      });
      const briefPath = this.storage.getBriefPdfPath(documentId, version.versionNumber);
      this.storage.writeFileAtomic(briefPath, briefBytes);
      this.db.updateVersionPdfPaths(version.id, { briefPdfPath: briefPath });

      this.db.updateDocument(documentId, { jobStatus: 'ready', errorMessage: null });
      this.logger.info('pipeline', `Completed analysis for "${doc.title}"`, { documentId }, requestId);
    } catch (err) {
      const message = (err as Error).message || 'Unexpected error during analysis.';
      this.db.updateDocument(documentId, { jobStatus: 'failed', errorMessage: message });
      this.logger.error('pipeline', `Pipeline failed for ${documentId}: ${message}`, { documentId }, requestId);
    }
  }
}
