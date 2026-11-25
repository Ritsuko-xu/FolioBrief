/** Shared Gemini SDK client, model aliases, transient-error retries, embeddings, and highlight budget helper. */
import { GoogleGenAI } from '@google/genai';

export const PRIMARY_MODEL = 'gemini-4-hydrogen';
export const FAST_MEMORY_MODEL = 'gemini-3.1-flash-lite';
export const EMBEDDING_MODEL = 'gemini-embedding-2';

/** Initializes an authenticated `@google/genai` client with the required User-Agent header. */
export function createGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error(
      'GEMINI_API_KEY is not configured. Add your key in Settings > Secrets (or .env) to run AI synthesis.'
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

/** Retries transient Gemini API errors (429/503) using exponential backoff with jitter. */
export async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const msg = (err as Error)?.message ?? '';
      const status = (err as { status?: number })?.status;
      const isTransient =
        status === 429 ||
        status === 503 ||
        /429|503|RESOURCE_EXHAUSTED|UNAVAILABLE|overloaded/i.test(msg);

      if (!isTransient || attempt === maxAttempts) {
        throw err;
      }
      const delayMs = 600 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 250);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

/** Caps highlights between 4 and 12 (`ceil(pageCount * 1.5)`) to keep annotations concise. */
export function computeConciseHighlightCap(pageCount: number): number {
  return Math.min(12, Math.max(4, Math.ceil(pageCount * 1.5)));
}

/** Computes a document embedding vector (`gemini-embedding-2`), returning `null` on failure. */
export async function generateTextEmbedding(text: string): Promise<number[] | null> {
  try {
    const ai = createGeminiClient();
    const snippet = text.slice(0, 8000);
    const result = await withRetry(() =>
      ai.models.embedContent({
        model: EMBEDDING_MODEL,
        contents: snippet,
      })
    );
    const values = result.embeddings?.[0]?.values;
    return Array.isArray(values) && values.length > 0 ? values : null;
  } catch {
    return null;
  }
}
