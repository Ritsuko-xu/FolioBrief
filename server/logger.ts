/** Rotating daily JSON-lines logger with secret redaction and in-memory ring buffer for diagnostics. */
import fs from 'node:fs';
import path from 'node:path';
import type { LogEntry } from '../src/shared/types.ts';

const SECRET_KEY_PATTERN = /(api[_-]?key|authorization|bearer|token|secret|password)/i;

/** Recursively masks API keys, bearer tokens, and secret-like keys before logging. */
function sanitizeValue(value: unknown, keyHint = ''): unknown {
  if (SECRET_KEY_PATTERN.test(keyHint)) {
    return '[REDACTED]';
  }
  if (typeof value === 'string') {
    return value
      .replace(/AIza[0-9A-Za-z\-_]{20,}/g, '[REDACTED_GEMINI_KEY]')
      .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]');
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeValue(v, k);
    }
    return out;
  }
  return value;
}

/** Rotating daily JSON-lines logger with an in-memory ring buffer for Diagnostics. */
export class AppLogger {
  private readonly logDir: string;
  private readonly ringBuffer: LogEntry[] = [];
  private readonly maxBufferSize: number;

  constructor(logDir: string, maxBufferSize = 200) {
    this.logDir = logDir;
    this.maxBufferSize = maxBufferSize;
    fs.mkdirSync(this.logDir, { recursive: true });
  }

  /** Returns today's rotating log file path (`app-YYYY-MM-DD.log`). */
  private getLogFilePath(now = new Date()): string {
    const dateStr = now.toISOString().slice(0, 10);
    return path.join(this.logDir, `app-${dateStr}.log`);
  }

  /** Sanitizes, buffers in memory, and appends a structured log entry to disk. */
  private write(
    level: LogEntry['level'],
    module: string,
    message: string,
    meta?: Record<string, unknown>,
    requestId?: string
  ): LogEntry {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      ...(requestId ? { requestId } : {}),
      module,
      message: String(sanitizeValue(message)),
      ...(meta ? { meta: sanitizeValue(meta) as Record<string, unknown> } : {}),
    };

    this.ringBuffer.push(entry);
    if (this.ringBuffer.length > this.maxBufferSize) {
      this.ringBuffer.shift();
    }

    try {
      fs.mkdirSync(this.logDir, { recursive: true });
      fs.appendFileSync(this.getLogFilePath(), `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      // Never crash application flow if disk logging temporarily fails
    }

    return entry;
  }

  /** Records an informational log entry. */
  info(module: string, message: string, meta?: Record<string, unknown>, requestId?: string): LogEntry {
    return this.write('info', module, message, meta, requestId);
  }

  /** Records a warning log entry. */
  warn(module: string, message: string, meta?: Record<string, unknown>, requestId?: string): LogEntry {
    return this.write('warn', module, message, meta, requestId);
  }

  /** Records an error log entry. */
  error(module: string, message: string, meta?: Record<string, unknown>, requestId?: string): LogEntry {
    return this.write('error', module, message, meta, requestId);
  }

  /** Returns the most recent buffered log entries in reverse chronological order. */
  getRecentLogs(limit = 50): LogEntry[] {
    return this.ringBuffer.slice(-limit).reverse();
  }

  /** Returns the absolute directory where log files are written. */
  getLogDirectory(): string {
    return this.logDir;
  }
}
