/** Typed frontend HTTP and SSE client wrappers for the backend `/api/*` endpoints. */
import type {
  AnalysisVersion,
  DiagnosticsSnapshot,
  DocumentDetailResponse,
  DocumentListItem,
  MemoryProfileRecord,
  ToolTraceRecord,
  ChatMessage,
} from '../shared/types.ts';

/** Unwraps JSON responses or throws an Error populated from the server's `error` payload. */
async function parseJsonOrThrow<T>(res: Response): Promise<T> {
  const rawText = await res.text();
  if (!res.ok) {
    let errMessage = `Request failed (${res.status})`;
    try {
      const data = JSON.parse(rawText) as { error?: string };
      if (data.error) errMessage = data.error;
    } catch {
      // ignore non-json error body
    }
    throw new Error(errMessage);
  }

  try {
    return JSON.parse(rawText) as T;
  } catch {
    const trimmed = rawText.trimStart().toLowerCase();
    if (trimmed.startsWith('<!doctype') || trimmed.startsWith('<html')) {
      throw new Error(
        'Server returned an HTML page instead of JSON (your preview session may have timed out or the server restarted). Refresh the page and try again, or paste the article text directly.'
      );
    }
    throw new Error(`Invalid JSON response from server (${res.status}).`);
  }
}

/** Typed REST + SSE client for FolioBrief's headless Express backend. */
export const apiClient = {
  async listDocuments(search?: string): Promise<DocumentListItem[]> {
    const q = search ? `?q=${encodeURIComponent(search)}` : '';
    const res = await fetch(`/api/documents${q}`);
    const data = await parseJsonOrThrow<{ documents: DocumentListItem[] }>(res);
    return data.documents;
  },

  async getDocument(id: string): Promise<DocumentDetailResponse> {
    const res = await fetch(`/api/documents/${encodeURIComponent(id)}`);
    return parseJsonOrThrow<DocumentDetailResponse>(res);
  },

  async uploadPdf(file: File): Promise<{ documentId: string; deduplicated?: boolean }> {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/documents/upload', {
      method: 'POST',
      body: form,
    });
    return parseJsonOrThrow<{ documentId: string; deduplicated?: boolean }>(res);
  },

  async ingestUrl(url: string): Promise<{ documentId: string; deduplicated?: boolean }> {
    const res = await fetch('/api/documents/url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    return parseJsonOrThrow<{ documentId: string; deduplicated?: boolean }>(res);
  },

  async ingestText(input: {
    title: string;
    text: string;
    sourceUrl?: string;
  }): Promise<{ documentId: string; deduplicated?: boolean }> {
    const res = await fetch('/api/documents/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    return parseJsonOrThrow<{ documentId: string; deduplicated?: boolean }>(res);
  },

  async resumeDocument(id: string): Promise<{ documentId: string }> {
    const res = await fetch(`/api/documents/${encodeURIComponent(id)}/resume`, {
      method: 'POST',
    });
    return parseJsonOrThrow<{ documentId: string }>(res);
  },

  async deleteDocument(id: string): Promise<void> {
    const res = await fetch(`/api/documents/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    await parseJsonOrThrow<{ deleted: boolean }>(res);
  },

  async revertVersion(
    documentId: string,
    versionNumber: number
  ): Promise<{
    latestVersion: AnalysisVersion;
    versions: Array<{ id: string; versionNumber: number; revisionReason: string; createdAt: string }>;
  }> {
    const res = await fetch(`/api/documents/${encodeURIComponent(documentId)}/revert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ versionNumber }),
    });
    return parseJsonOrThrow(res);
  },

  async streamChat(input: {
    documentId: string;
    message: string;
    referencedHighlightIds?: string[];
    onDelta: (text: string) => void;
    onRevision: (payload: {
      latestVersion: AnalysisVersion;
      versions: Array<{ id: string; versionNumber: number; revisionReason: string; createdAt: string }>;
    }) => void;
    onTrace: (trace: ToolTraceRecord) => void;
    onDone: (payload: {
      assistantMessage: ChatMessage;
      latestVersion: AnalysisVersion | null;
      versions: Array<{ id: string; versionNumber: number; revisionReason: string; createdAt: string }>;
    }) => void;
    onError: (message: string) => void;
  }): Promise<void> {
    const res = await fetch(`/api/documents/${encodeURIComponent(input.documentId)}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: input.message,
        referencedHighlightIds: input.referencedHighlightIds ?? [],
      }),
    });

    const contentType = res.headers.get('content-type') ?? '';
    if (!res.ok || !res.body || contentType.toLowerCase().includes('text/html')) {
      let errMessage = contentType.toLowerCase().includes('text/html')
        ? 'Server returned an HTML page instead of a chat stream. Refresh the page and try again.'
        : `Chat failed (${res.status})`;
      try {
        const data = (await res.json()) as { error?: string };
        if (data.error) errMessage = data.error;
      } catch {
        // ignore
      }
      input.onError(errMessage);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';

      for (const rawEvent of events) {
        const lines = rawEvent.split('\n');
        let eventName = 'message';
        let dataStr = '';
        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            dataStr += line.slice(5).trim();
          }
        }
        if (!dataStr) continue;
        try {
          const parsed = JSON.parse(dataStr);
          if (eventName === 'delta') {
            input.onDelta(String(parsed.text ?? ''));
          } else if (eventName === 'revision') {
            input.onRevision(parsed);
          } else if (eventName === 'trace') {
            input.onTrace(parsed.trace);
          } else if (eventName === 'done') {
            input.onDone(parsed);
          } else if (eventName === 'error') {
            input.onError(String(parsed.error ?? 'Chat error'));
          }
        } catch {
          // ignore partial JSON frame
        }
      }
    }
  },

  async listMemory(): Promise<MemoryProfileRecord[]> {
    const res = await fetch('/api/memory');
    const data = await parseJsonOrThrow<{ preferences: MemoryProfileRecord[] }>(res);
    return data.preferences;
  },

  async saveMemory(preferenceKey: string, learnedRule: string): Promise<MemoryProfileRecord> {
    const res = await fetch('/api/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferenceKey, learnedRule }),
    });
    const data = await parseJsonOrThrow<{ preference: MemoryProfileRecord }>(res);
    return data.preference;
  },

  async deleteMemory(id: string): Promise<void> {
    const res = await fetch(`/api/memory/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await parseJsonOrThrow<{ deleted: boolean }>(res);
  },

  async getDiagnostics(): Promise<DiagnosticsSnapshot> {
    const res = await fetch('/api/diagnostics');
    return parseJsonOrThrow<DiagnosticsSnapshot>(res);
  },

  async cleanOrphanTempFiles(): Promise<{ removed: number }> {
    const res = await fetch('/api/diagnostics/cleanup', { method: 'POST' });
    return parseJsonOrThrow<{ removed: number }>(res);
  },

  /** Downloads a binary/text asset via same-origin fetch + Blob URL so preview iframe cookies remain intact. */
  async downloadFile(url: string, fallbackFilename: string): Promise<void> {
    const res = await fetch(url);
    if (!res.ok) {
      let errMessage = `Download failed (${res.status})`;
      try {
        const rawText = await res.text();
        const data = JSON.parse(rawText) as { error?: string };
        if (data.error) errMessage = data.error;
      } catch {
        // ignore non-json error body
      }
      throw new Error(errMessage);
    }

    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    const blob = await res.blob();
    const blobType = blob.type.toLowerCase();
    if (contentType.includes('text/html') || blobType.includes('text/html')) {
      throw new Error(
        'Server returned an HTML page instead of the requested file. Refresh the page and try again.'
      );
    }

    // Sniff initial bytes in case a proxy served an HTML error/cookie page without text/html header
    if (typeof blob.slice === 'function') {
      const head = (await blob.slice(0, 64).text()).trimStart().toLowerCase();
      if (head.startsWith('<!doctype') || head.startsWith('<html')) {
        throw new Error(
          'Server returned an HTML page instead of the requested file. Refresh the page and try again.'
        );
      }
    }

    const cd = res.headers.get('content-disposition') ?? '';
    let filename = fallbackFilename;
    const utf8Match = cd.match(/filename\*=UTF-8''([^;\n]+)/i);
    const asciiMatch = cd.match(/filename="?([^";\n]+)"?/i);
    if (utf8Match?.[1]) {
      try {
        filename = decodeURIComponent(utf8Match[1].trim());
      } catch {
        filename = utf8Match[1].trim();
      }
    } else if (asciiMatch?.[1]) {
      filename = asciiMatch[1].trim();
    }

    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => {
      URL.revokeObjectURL(objectUrl);
    }, 1000);
  },
};
