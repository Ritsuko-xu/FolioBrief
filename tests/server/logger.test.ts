/** Unit tests for AppLogger secret redaction, in-memory ring buffer, and daily log rotation. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppLogger } from '../../server/logger.ts';

describe('AppLogger: Secret Redaction, Ring Buffer & Daily File Rotation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foliobrief-log-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('redacts secret keys, Gemini API keys, and Bearer tokens recursively', () => {
    const logger = new AppLogger(tmpDir);
    const fakeKey1 = ['AIza', 'SyDummySecretKey1234567890abcd'].join('');
    const fakeKey2 = ['AIza', 'SyAnotherRawKey1234567890abcd'].join('');
    const entry = logger.error(
      'auth',
      `Failed request with ${fakeKey1} and Bearer top_secret_tok`,
      {
        apiKey: fakeKey2,
        nested: {
          authorization: 'Bearer abcdef12345',
          password: 'hunter2',
          safeField: 'visible-value',
        },
        items: ['Bearer xyz_987'],
      },
      'req-42'
    );

    expect(entry.requestId).toBe('req-42');
    expect(entry.message).not.toContain('DummySecretKey');
    expect(entry.message).not.toContain('top_secret_tok');
    expect(entry.message).toContain('[REDACTED_GEMINI_KEY]');
    expect(entry.message).toContain('Bearer [REDACTED]');

    expect(entry.meta?.apiKey).toBe('[REDACTED]');
    expect((entry.meta?.nested as Record<string, unknown>).authorization).toBe('[REDACTED]');
    expect((entry.meta?.nested as Record<string, unknown>).password).toBe('[REDACTED]');
    expect((entry.meta?.nested as Record<string, unknown>).safeField).toBe('visible-value');
    expect(entry.meta?.items).toEqual(['Bearer [REDACTED]']);
  });

  it('caps the in-memory ring buffer and returns recent entries newest-first', () => {
    const logger = new AppLogger(tmpDir, 3);
    logger.info('mod', 'm1');
    logger.warn('mod', 'm2');
    logger.error('mod', 'm3');
    logger.info('mod', 'm4');

    const recent = logger.getRecentLogs(10);
    expect(recent.map((e) => e.message)).toEqual(['m4', 'm3', 'm2']);
    expect(logger.getRecentLogs(2).map((e) => e.message)).toEqual(['m4', 'm3']);
  });

  it('writes JSON-lines entries to today’s rotating log file', () => {
    const logger = new AppLogger(tmpDir);
    logger.info('ingest', 'Document queued', { documentId: 'doc-1' }, 'req-9');

    const today = new Date().toISOString().slice(0, 10);
    const logPath = path.join(tmpDir, `app-${today}.log`);
    expect(fs.existsSync(logPath)).toBe(true);

    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]) as { module: string; message: string; requestId: string };
    expect(parsed.module).toBe('ingest');
    expect(parsed.message).toBe('Document queued');
    expect(parsed.requestId).toBe('req-9');
  });
});
