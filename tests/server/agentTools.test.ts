/** Tests for agent tool executors, ToolTrace logging, highlight caps, and MemoryContextRetriever. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FolioDatabase } from '../../server/db.ts';
import { FileStorageManager } from '../../server/storage.ts';
import { executeAgentTool } from '../../server/ai/agentTools.ts';
import { cosineSimilarity, MemoryContextRetriever } from '../../server/memory/retriever.ts';
import { computeConciseHighlightCap } from '../../server/ai/geminiClient.ts';

describe('Agent Tool Executors, ToolTraces & Memory Retriever', () => {
  let tmpDir: string;
  let db: FolioDatabase;
  let storage: FileStorageManager;
  let docId: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foliobrief-g3-'));
    storage = new FileStorageManager(tmpDir);
    db = new FolioDatabase(path.join(tmpDir, 'foliobrief.db'));

    const doc = db.createDocument({
      title: 'Attention Sink Mitigation',
      sourceType: 'pdf',
      jobStatus: 'ready',
      pageCount: 2,
      extractedText: '[Page 1]\nAttention sinks stabilize streaming language model generation over infinite windows.',
      pageIndex: [
        {
          page: 1,
          width: 612,
          height: 792,
          fullText: 'Attention sinks stabilize streaming language model generation over infinite windows.',
          spans: [
            { text: 'Attention sinks stabilize streaming language model generation', x: 50, y: 700, width: 320, height: 12 },
          ],
        },
        {
          page: 2,
          width: 612,
          height: 792,
          fullText: 'Rolling KV cache eviction preserves initial token states.',
          spans: [{ text: 'Rolling KV cache eviction preserves initial token states.', x: 50, y: 700, width: 300, height: 12 }],
        },
      ],
    });
    docId = doc.id;
    db.updateDocument(docId, { embeddingVector: [1, 0, 0] });

    db.createAnalysisVersion({
      documentId: docId,
      payload: {
        summary: 'Original summary.',
        keyInsights: ['Initial tokens act as attention sinks.', 'Sliding windows drop perplexity when anchors remain.'],
        improvements: ['Enables constant-memory 4M-token streaming.'],
        openQuestions: ['How does sink behavior interact with MoE routing?'],
        highlights: [
          {
            id: 'hl-init1',
            page: 1,
            quoteAnchor: 'Attention sinks stabilize streaming language model generation',
            category: 'claim',
            comment: 'Core thesis',
          },
        ],
      },
      revisionReason: 'Initial AI synthesis',
    });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('modifies ONLY the targeted brief section and logs a ToolTrace', async () => {
    const outcome = await executeAgentTool(
      { db, storage, documentId: docId },
      'update_brief_section',
      {
        section: 'openQuestions',
        operation: 'replace_section',
        content: '- What happens to latency on multi-tenant GPUs?\n- Can sink tokens be learned offline?',
      }
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.newVersion?.versionNumber).toBe(2);
    // Untouched sections remain identical
    expect(outcome.newVersion?.keyInsights).toEqual([
      'Initial tokens act as attention sinks.',
      'Sliding windows drop perplexity when anchors remain.',
    ]);
    expect(outcome.newVersion?.openQuestions).toEqual([
      'What happens to latency on multi-tenant GPUs?',
      'Can sink tokens be learned offline?',
    ]);
    // Brief PDF materialized on disk
    expect(outcome.newVersion?.briefPdfPath).toBeTruthy();
    expect(fs.existsSync(outcome.newVersion!.briefPdfPath!)).toBe(true);

    const traces = db.listToolTracesByDocument(docId);
    expect(traces.length).toBe(1);
    expect(traces[0].toolName).toBe('update_brief_section');
    expect(traces[0].status).toBe('ok');
    expect(traces[0].beforeVersion).toBe(1);
    expect(traces[0].afterVersion).toBe(2);
  });

  it('enforces concise highlight cap and validates page bounds in upsert_highlight / delete_highlight', async () => {
    const cap = computeConciseHighlightCap(2); // 4
    expect(cap).toBe(4);

    // Out of bounds page rejected and traced
    const badPage = await executeAgentTool(
      { db, storage, documentId: docId },
      'upsert_highlight',
      { page: 99, quoteAnchor: 'nonexistent', category: 'claim', comment: 'bad' }
    );
    expect(badPage.ok).toBe(false);

    // Add 3 more highlights to reach cap=4
    for (let i = 0; i < 3; i += 1) {
      const res = await executeAgentTool(
        { db, storage, documentId: docId },
        'upsert_highlight',
        {
          page: 2,
          quoteAnchor: 'Rolling KV cache eviction',
          category: 'improvement',
          comment: `Note ${i}`,
        }
      );
      expect(res.ok).toBe(true);
    }

    // 5th highlight exceeds cap and is rejected
    const overCap = await executeAgentTool(
      { db, storage, documentId: docId },
      'upsert_highlight',
      {
        page: 1,
        quoteAnchor: 'Attention sinks',
        category: 'question',
        comment: 'Too many highlights',
      }
    );
    expect(overCap.ok).toBe(false);

    // Deleting hl-init1 works and creates new version
    const delRes = await executeAgentTool(
      { db, storage, documentId: docId },
      'delete_highlight',
      { highlightId: 'hl-init1' }
    );
    expect(delRes.ok).toBe(true);
    expect(delRes.newVersion?.highlights.some((h) => h.id === 'hl-init1')).toBe(false);
  });

  it('retrieves related prior documents by vector cosine similarity and MemoryProfile rules', async () => {
    const prior = db.createDocument({
      title: 'KV Cache Quantization',
      sourceType: 'url',
      sourceUrl: 'https://example.org/kv',
      jobStatus: 'ready',
      extractedText: 'INT4 KV cache quantization cuts memory footprint.',
    });
    db.updateDocument(prior.id, { embeddingVector: [0.95, 0.05, 0] });
    db.createAnalysisVersion({
      documentId: prior.id,
      payload: {
        summary: 'INT4 KV cache reduces memory by 4x.',
        keyInsights: ['Minimal perplexity loss'],
        improvements: ['Fused dequantization kernel'],
        openQuestions: ['How does it pair with sparse attention?'],
        highlights: [],
      },
      revisionReason: 'Initial',
    });

    await executeAgentTool(
      { db, storage, documentId: docId },
      'update_memory_preference',
      { preferenceKey: 'focus', rule: 'Prioritize GPU memory bandwidth and latency metrics.' }
    );

    const retriever = new MemoryContextRetriever(db);
    const block = retriever.buildPersonalizedContextBlock({
      excludeDocumentId: docId,
      queryEmbedding: [1, 0, 0],
    });

    expect(cosineSimilarity([1, 0, 0], [0.95, 0.05, 0])).toBeGreaterThan(0.95);
    expect(block.relatedDocuments.length).toBe(1);
    expect(block.relatedDocuments[0].title).toBe('KV Cache Quantization');
    expect(block.promptBlock).toContain('Prioritize GPU memory bandwidth');
  });

  it('executes search_prior_readings excluding current document, clamping limit, and logging ToolTrace', async () => {
    const seedPrior = (title: string, extractedText: string, summary: string) => {
      const prior = db.createDocument({
        title,
        sourceType: 'text',
        jobStatus: 'ready',
        extractedText,
      });
      db.createAnalysisVersion({
        documentId: prior.id,
        payload: {
          summary,
          keyInsights: ['Insight'],
          improvements: ['Improvement'],
          openQuestions: ['Question'],
          highlights: [],
        },
        revisionReason: 'Initial',
      });
      return prior;
    };

    const p1 = seedPrior(
      'Streaming Attention Paper',
      'Streaming attention reduces KV footprint in long sessions.',
      'Streaming attention summary.'
    );
    const p2 = seedPrior(
      'Sparse Attention Routing',
      'Sparse attention skips low-weight blocks dynamically.',
      'Sparse attention summary.'
    );
    const p3 = seedPrior(
      'Flash Attention Kernels',
      'Tiled attention avoids HBM round-trips.',
      'Flash attention summary.'
    );
    seedPrior('Unrelated Compiler Paper', 'Register allocation via graph coloring.', 'Compiler summary.');

    const res = await executeAgentTool(
      { db, storage, documentId: docId },
      'search_prior_readings',
      { query: 'attention', limit: 2 }
    );
    expect(res.ok).toBe(true);
    expect(res.newVersion).toBeUndefined();
    const matches = res.result.matches as Array<{ id: string; title: string; summary: string }>;
    expect(matches.length).toBe(2);
    expect(matches.every((m) => [p1.id, p2.id, p3.id].includes(m.id))).toBe(true);
    expect(matches.some((m) => m.id === docId)).toBe(false);

    // limit <= 0 clamps to 1
    const clampedMin = await executeAgentTool(
      { db, storage, documentId: docId },
      'search_prior_readings',
      { query: 'attention', limit: 0 }
    );
    expect(clampedMin.ok).toBe(true);
    expect((clampedMin.result.matches as unknown[]).length).toBe(1);

    const traces = db.listToolTracesByDocument(docId);
    expect(traces[0].toolName).toBe('search_prior_readings');
    expect(traces[0].status).toBe('ok');
    expect(traces[0].beforeVersion).toBe(1);
    expect(traces[0].afterVersion).toBe(1);
  });

  it('supports summary, append_item, edit_item, and remove_item in update_brief_section and rejects invalid args', async () => {
    const sumRes = await executeAgentTool(
      { db, storage, documentId: docId },
      'update_brief_section',
      { section: 'summary', operation: 'replace_section', content: 'Updated executive summary.' }
    );
    expect(sumRes.ok).toBe(true);
    expect(sumRes.newVersion?.summary).toBe('Updated executive summary.');

    const appendRes = await executeAgentTool(
      { db, storage, documentId: docId },
      'update_brief_section',
      { section: 'keyInsights', operation: 'append_item', content: '- Third insight appended.' }
    );
    expect(appendRes.ok).toBe(true);
    expect(appendRes.newVersion?.keyInsights).toHaveLength(3);
    expect(appendRes.newVersion?.keyInsights[2]).toBe('Third insight appended.');

    const editRes = await executeAgentTool(
      { db, storage, documentId: docId },
      'update_brief_section',
      { section: 'keyInsights', operation: 'edit_item', itemIndex: 1, content: 'Edited second insight.' }
    );
    expect(editRes.ok).toBe(true);
    expect(editRes.newVersion?.keyInsights[1]).toBe('Edited second insight.');

    const removeRes = await executeAgentTool(
      { db, storage, documentId: docId },
      'update_brief_section',
      { section: 'keyInsights', operation: 'remove_item', itemIndex: 0 }
    );
    expect(removeRes.ok).toBe(true);
    expect(removeRes.newVersion?.keyInsights).toEqual(['Edited second insight.', 'Third insight appended.']);

    const badSection = await executeAgentTool(
      { db, storage, documentId: docId },
      'update_brief_section',
      { section: 'unknownSection', operation: 'replace_section', content: 'x' }
    );
    const badIndex = await executeAgentTool(
      { db, storage, documentId: docId },
      'update_brief_section',
      { section: 'improvements', operation: 'remove_item', itemIndex: 99 }
    );
    const badOp = await executeAgentTool(
      { db, storage, documentId: docId },
      'update_brief_section',
      { section: 'improvements', operation: 'bogus_op', content: 'x' }
    );

    expect(badSection.ok).toBe(false);
    expect(badIndex.ok).toBe(false);
    expect(badOp.ok).toBe(false);
    expect(db.getLatestAnalysisVersion(docId)?.versionNumber).toBe(5);
  });

  it('updates existing highlights at cap, rejects invalid highlight/delete/memory inputs, and traces unknown tools', async () => {
    // Fill to cap=4 (1 initial + 3 added)
    for (let i = 0; i < 3; i += 1) {
      const added = await executeAgentTool(
        { db, storage, documentId: docId },
        'upsert_highlight',
        { page: 2, quoteAnchor: 'Rolling KV cache eviction', category: 'improvement', comment: `Cap ${i}` }
      );
      expect(added.ok).toBe(true);
    }

    // Updating an existing highlightId succeeds even at cap
    const updated = await executeAgentTool(
      { db, storage, documentId: docId },
      'upsert_highlight',
      {
        highlightId: 'hl-init1',
        page: 1,
        quoteAnchor: 'Attention sinks stabilize streaming language model generation',
        category: 'claim',
        comment: 'Refined thesis comment',
      }
    );
    expect(updated.ok).toBe(true);
    expect(updated.newVersion?.highlights).toHaveLength(4);
    expect(updated.newVersion?.highlights.find((h) => h.id === 'hl-init1')?.comment).toBe('Refined thesis comment');

    const missingHighlight = await executeAgentTool(
      { db, storage, documentId: docId },
      'delete_highlight',
      { highlightId: 'hl-missing' }
    );
    expect(missingHighlight.ok).toBe(false);

    const sanitizedMem = await executeAgentTool(
      { db, storage, documentId: docId },
      'update_memory_preference',
      { preferenceKey: 'Systems-Focus', rule: 'Flag KV cache memory trade-offs.' }
    );
    expect(sanitizedMem.ok).toBe(true);
    expect((sanitizedMem.result.preference as { preferenceKey: string }).preferenceKey).toBe('systems_focus');

    const emptyMem = await executeAgentTool(
      { db, storage, documentId: docId },
      'update_memory_preference',
      { preferenceKey: '   ', rule: '' }
    );
    expect(emptyMem.ok).toBe(false);

    const unknown = await executeAgentTool(
      { db, storage, documentId: docId },
      'nonexistent_tool',
      { foo: 'bar' }
    );
    expect(unknown.ok).toBe(false);
    expect(unknown.result.error).toContain('Unknown tool');

    const traces = db.listToolTracesByDocument(docId);
    const unknownTrace = traces.find((t) => t.toolName === 'nonexistent_tool');
    expect(unknownTrace?.status).toBe('rejected');

    const emptyQuote = await executeAgentTool(
      { db, storage, documentId: docId },
      'upsert_highlight',
      { page: 1, quoteAnchor: '  ', comment: 'Note' }
    );
    expect(emptyQuote.ok).toBe(false);

    const missingDoc = await executeAgentTool(
      { db, storage, documentId: 'nonexistent-doc-id' },
      'search_prior_readings',
      { query: 'attention' }
    );
    expect(missingDoc.ok).toBe(false);
    expect(missingDoc.result.error).toBe('Document not found');
  });
});
