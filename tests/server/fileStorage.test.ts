/** Tests for FileStorageManager atomic writes, path-traversal guards, version PDF pruning, and cleanup. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileStorageManager } from '../../server/storage.ts';

describe('FileStorageManager: Atomic Writes, Path Guards, Pruning & Cleanup', () => {
  let tmpDir: string;
  let storage: FileStorageManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foliobrief-fs-'));
    storage = new FileStorageManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes PDF files atomically and cleans orphan temp files', () => {
    const docDir = storage.getDocumentDir('doc-123');
    const briefPath = storage.getBriefPdfPath('doc-123', 1);
    storage.writeFileAtomic(briefPath, Buffer.from('%PDF-1.4\n%test'));
    expect(fs.existsSync(briefPath)).toBe(true);

    fs.writeFileSync(path.join(docDir, 'annotated_v1.pdf.abcd.tmp'), 'partial');
    let stats = storage.getStorageStats();
    expect(stats.pdfFileCount).toBe(1);
    expect(stats.orphanTempFiles).toBe(1);

    const cleaned = storage.cleanOrphanTempFiles();
    expect(cleaned).toBe(1);
    stats = storage.getStorageStats();
    expect(stats.orphanTempFiles).toBe(0);
  });

  it('rejects empty or path-traversal-only document IDs', () => {
    expect(() => storage.getDocumentDir('')).toThrow('Invalid documentId for storage path');
    expect(() => storage.getDocumentDir('../..')).toThrow('Invalid documentId for storage path');
    expect(() => storage.getDocumentDir('///...')).toThrow('Invalid documentId for storage path');
  });

  it('prunes superseded version PDFs while preserving source.pdf and keepVersionNumber', () => {
    const docId = 'doc-prune';
    const sourcePath = storage.getSourcePdfPath(docId);
    const brief1 = storage.getBriefPdfPath(docId, 1);
    const annot1 = storage.getAnnotatedPdfPath(docId, 1);
    const brief2 = storage.getBriefPdfPath(docId, 2);
    const annot2 = storage.getAnnotatedPdfPath(docId, 2);

    for (const p of [sourcePath, brief1, annot1, brief2, annot2]) {
      storage.writeFileAtomic(p, Buffer.from('%PDF-1.4\n%data'));
    }

    storage.pruneOldVersionPdfs(docId, 2);

    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(brief1)).toBe(false);
    expect(fs.existsSync(annot1)).toBe(false);
    expect(fs.existsSync(brief2)).toBe(true);
    expect(fs.existsSync(annot2)).toBe(true);
  });

  it('deletes all stored files for a document recursively and ignores unknown IDs', () => {
    const briefPath = storage.getBriefPdfPath('doc-del', 1);
    storage.writeFileAtomic(briefPath, Buffer.from('%PDF-1.4\n%bye'));
    expect(fs.existsSync(storage.getDocumentDir('doc-del'))).toBe(true);

    storage.deleteDocumentFiles('doc-del');
    expect(fs.existsSync(path.join(storage.pdfsDir, 'doc-del'))).toBe(false);

    expect(() => storage.deleteDocumentFiles('nonexistent-doc')).not.toThrow();
    expect(() => storage.deleteDocumentFiles('')).not.toThrow();
  });
});
