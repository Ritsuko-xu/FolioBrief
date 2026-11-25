/** Local filesystem PDF manager handling per-document paths, atomic temp writes, and version pruning. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Manages per-document PDF files and atomic temp-file writes under `./data/pdfs`. */
export class FileStorageManager {
  public readonly baseDataDir: string;
  public readonly pdfsDir: string;
  public readonly logsDir: string;

  constructor(baseDataDir = path.resolve(process.cwd(), 'data')) {
    this.baseDataDir = baseDataDir;
    this.pdfsDir = path.join(baseDataDir, 'pdfs');
    this.logsDir = path.join(baseDataDir, 'logs');
    fs.mkdirSync(this.pdfsDir, { recursive: true });
    fs.mkdirSync(this.logsDir, { recursive: true });
  }

  /** Resolves and creates the sanitized storage directory for a document ID. */
  getDocumentDir(documentId: string): string {
    const safeId = documentId.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeId) {
      throw new Error('Invalid documentId for storage path');
    }
    const dir = path.join(this.pdfsDir, safeId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Returns the immutable `source.pdf` path (uploaded PDF or URL-rendered article), shared across all analysis revisions. */
  getSourcePdfPath(documentId: string): string {
    return path.join(this.getDocumentDir(documentId), 'source.pdf');
  }

  /** Returns the Executive Brief PDF path (`brief_v<N>.pdf`) for an `AnalysisVersion.versionNumber` (1 = initial synthesis, 2+ = chat edits or reverts). */
  getBriefPdfPath(documentId: string, versionNumber: number): string {
    return path.join(this.getDocumentDir(documentId), `brief_v${versionNumber}.pdf`);
  }

  /** Returns the lazily generated Annotated Source PDF path (`annotated_v<N>.pdf`) for an `AnalysisVersion.versionNumber`. */
  getAnnotatedPdfPath(documentId: string, versionNumber: number): string {
    return path.join(this.getDocumentDir(documentId), `annotated_v${versionNumber}.pdf`);
  }

  /** Writes data via a sibling `.tmp` file and `renameSync` to avoid partial PDFs on crash. */
  writeFileAtomic(targetPath: string, data: Uint8Array | Buffer | string): void {
    const dir = path.dirname(targetPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${targetPath}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    try {
      fs.writeFileSync(tmpPath, data);
      fs.renameSync(tmpPath, targetPath);
    } catch (error) {
      if (fs.existsSync(tmpPath)) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          // ignore cleanup failure
        }
      }
      throw error;
    }
  }

  /** Recursively removes all stored PDF files for a deleted document. */
  deleteDocumentFiles(documentId: string): void {
    const safeId = documentId.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeId) return;
    const dir = path.join(this.pdfsDir, safeId);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Deletes cached `brief_v*.pdf` / `annotated_v*.pdf` artifacts from older `AnalysisVersion` revisions, keeping `keepVersionNumber` and `source.pdf`. */
  pruneOldVersionPdfs(documentId: string, keepVersionNumber: number): void {
    const dir = this.getDocumentDir(documentId);
    if (!fs.existsSync(dir)) return;
    for (const file of fs.readdirSync(dir)) {
      const briefMatch = /^brief_v(\d+)\.pdf$/.exec(file);
      const annotMatch = /^annotated_v(\d+)\.pdf$/.exec(file);
      if (briefMatch && Number(briefMatch[1]) !== keepVersionNumber) {
        fs.unlinkSync(path.join(dir, file));
      } else if (annotMatch && Number(annotMatch[1]) !== keepVersionNumber) {
        fs.unlinkSync(path.join(dir, file));
      }
    }
  }

  /** Walks `./data/pdfs` to aggregate PDF file count, disk usage, and orphan `.tmp` files. */
  getStorageStats(): { pdfStorageBytes: number; pdfFileCount: number; orphanTempFiles: number } {
    let pdfStorageBytes = 0;
    let pdfFileCount = 0;
    let orphanTempFiles = 0;

    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          const stat = fs.statSync(fullPath);
          if (entry.name.endsWith('.tmp')) {
            orphanTempFiles += 1;
          } else if (entry.name.endsWith('.pdf')) {
            pdfFileCount += 1;
            pdfStorageBytes += stat.size;
          }
        }
      }
    };

    walk(this.pdfsDir);
    return { pdfStorageBytes, pdfFileCount, orphanTempFiles };
  }

  /** Removes leftover `.tmp` files from interrupted writes and returns how many were deleted. */
  cleanOrphanTempFiles(): number {
    let removed = 0;
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.tmp')) {
          fs.unlinkSync(fullPath);
          removed += 1;
        }
      }
    };
    walk(this.pdfsDir);
    return removed;
  }
}
