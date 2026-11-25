/** Defensive JSON array/number-array parsers with structured warning logs for corrupted payloads. */
/** Minimal structured logger contract accepted by parser utilities. */
export interface StructuredLogger {
  info?(module: string, message: string, meta?: Record<string, unknown>): unknown;
  warn(module: string, message: string, meta?: Record<string, unknown>): unknown;
  error?(module: string, message: string, meta?: Record<string, unknown>): unknown;
}

function logWarn(
  logger: StructuredLogger | undefined,
  moduleName: string,
  message: string,
  meta: Record<string, unknown>
): void {
  if (logger) {
    logger.warn(moduleName, message, meta);
  } else {
    console.warn(`[${moduleName}] ${message}`, meta);
  }
}

/**
 * Safely parses a JSON-encoded array.
 * Logs a warning and falls back to `[]` on empty/null values (unless `allowNullOrEmpty`),
 * malformed JSON, or non-array shapes (`null`, `{}`, primitives), and optionally filters elements.
 */
export function safeParseArray<T>(
  raw: unknown,
  opts: {
    module?: string;
    table: string;
    rowId: string;
    column: string;
    logger?: StructuredLogger;
    allowNullOrEmpty?: boolean;
    itemGuard?: (item: unknown) => item is T;
  }
): T[] {
  const { module: moduleName = 'jsonParser', table, rowId, column, logger, allowNullOrEmpty = false, itemGuard } = opts;

  if (raw == null || (typeof raw === 'string' && raw.trim() === '')) {
    if (!allowNullOrEmpty) {
      logWarn(logger, moduleName, `Empty or null JSON array in ${table}.${column}; falling back to []`, {
        table,
        rowId,
        column,
      });
    }
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch (err) {
    logWarn(logger, moduleName, `Malformed JSON in ${table}.${column}; falling back to []`, {
      table,
      rowId,
      column,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  if (!Array.isArray(parsed)) {
    logWarn(logger, moduleName, `Expected array in ${table}.${column}; falling back to []`, {
      table,
      rowId,
      column,
      actualType: parsed === null ? 'null' : typeof parsed,
    });
    return [];
  }

  if (!itemGuard) {
    return parsed as T[];
  }

  const validItems: T[] = [];
  let droppedCount = 0;
  for (const item of parsed) {
    if (itemGuard(item)) {
      validItems.push(item);
    } else {
      droppedCount += 1;
    }
  }

  if (droppedCount > 0) {
    logWarn(logger, moduleName, `Dropped ${droppedCount} invalid element(s) from ${table}.${column}`, {
      table,
      rowId,
      column,
      droppedCount,
    });
  }

  return validItems;
}

/**
 * Safely parses an optional JSON-encoded finite `number[]` (e.g., an embedding vector).
 * Treats `null`, `undefined`, and `''` uniformly as `null`; logs a warning and returns `null`
 * on malformed JSON, non-array shapes, empty arrays, or non-finite entries.
 */
export function safeParseNumberArray(
  raw: unknown,
  opts: {
    module?: string;
    table: string;
    rowId: string;
    column: string;
    logger?: StructuredLogger;
  }
): number[] | null {
  const { module: moduleName = 'jsonParser', table, rowId, column, logger } = opts;

  if (raw == null || (typeof raw === 'string' && raw.trim() === '')) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch (err) {
    logWarn(logger, moduleName, `Malformed JSON in ${table}.${column}; returning null`, {
      table,
      rowId,
      column,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  if (!Array.isArray(parsed)) {
    logWarn(logger, moduleName, `Expected number[] in ${table}.${column}; returning null`, {
      table,
      rowId,
      column,
      actualType: parsed === null ? 'null' : typeof parsed,
    });
    return null;
  }

  if (parsed.length === 0 || !parsed.every((n): n is number => typeof n === 'number' && Number.isFinite(n))) {
    logWarn(logger, moduleName, `Invalid or non-finite vector entries in ${table}.${column}; returning null`, {
      table,
      rowId,
      column,
      length: parsed.length,
    });
    return null;
  }

  return parsed;
}

/** Runtime type guard for string array elements. */
export function isStringItem(item: unknown): item is string {
  return typeof item === 'string';
}
