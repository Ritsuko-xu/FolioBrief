/** Runtime type guards validating `HighlightItem` and `PageIndexEntry` shapes parsed from SQLite JSON. */
import type { HighlightItem, PageIndexEntry } from '../../src/shared/types.ts';

/** Runtime type guard verifying required core fields on a `HighlightItem`. */
export function isHighlightItem(item: unknown): item is HighlightItem {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const obj = item as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.page === 'number' &&
    Number.isFinite(obj.page) &&
    typeof obj.quoteAnchor === 'string' &&
    typeof obj.comment === 'string'
  );
}

/** Runtime type guard verifying required core fields on a `PageIndexEntry`. */
export function isPageIndexEntry(item: unknown): item is PageIndexEntry {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const obj = item as Record<string, unknown>;
  return (
    typeof obj.page === 'number' &&
    Number.isFinite(obj.page) &&
    typeof obj.fullText === 'string' &&
    Array.isArray(obj.spans)
  );
}
