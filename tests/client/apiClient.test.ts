// @vitest-environment jsdom
/** Unit tests for the frontend REST/SSE API client (src/api/client.ts) running in jsdom. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { apiClient } from '../../src/api/client.ts';
import type { AnalysisVersion, ChatMessage, ToolTraceRecord } from '../../src/shared/types.ts';

function makeStreamResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('Frontend apiClient: REST Errors & Chunked SSE Stream Parsing', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('encodes search queries and throws server error payloads from REST endpoints', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ documents: [] }), { status: 200 })
    );
    await apiClient.listDocuments('kv cache');
    expect(fetchMock).toHaveBeenCalledWith('/api/documents?q=kv%20cache');

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Document not found.' }), { status: 404 })
    );
    await expect(apiClient.getDocument('doc-404')).rejects.toThrow('Document not found.');

    fetchMock.mockResolvedValueOnce(new Response('Internal error', { status: 500 }));
    await expect(apiClient.listMemory()).rejects.toThrow('Request failed (500)');

    fetchMock.mockResolvedValueOnce(
      new Response('<!doctype html><html><body>Login</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })
    );
    await expect(apiClient.ingestUrl('https://example.com/article')).rejects.toThrow(
      'Server returned an HTML page instead of JSON'
    );

    fetchMock.mockResolvedValueOnce(new Response('not-json', { status: 200 }));
    await expect(apiClient.getDiagnostics()).rejects.toThrow('Invalid JSON response from server (200).');
  });

  it('parses delta, revision, trace, and done SSE events even when split across stream chunks', async () => {
    const mockVersion: AnalysisVersion = {
      id: 'ver-2',
      documentId: 'doc-1',
      versionNumber: 2,
      summary: 'Updated summary',
      keyInsights: ['Insight 1'],
      improvements: [],
      openQuestions: [],
      highlights: [],
      briefPdfPath: null,
      annotatedPdfPath: null,
      annotatedPdfDirty: false,
      revisionReason: 'Edit',
      createdAt: '2026-11-22T00:00:00.000Z',
    };
    const mockTrace: ToolTraceRecord = {
      id: 'tr-1',
      documentId: 'doc-1',
      chatMessageId: null,
      model: 'gemini-4-hydrogen',
      toolName: 'update_brief_section',
      rawArgsJson: '{}',
      status: 'ok',
      resultSummary: 'Updated summary',
      beforeVersion: 1,
      afterVersion: 2,
      durationMs: 12,
      createdAt: '2026-11-22T00:00:00.000Z',
    };
    const mockMsg: ChatMessage = {
      id: 'msg-2',
      documentId: 'doc-1',
      role: 'assistant',
      content: 'Hello world',
      referencedHighlightIds: [],
      appliedVersionNumber: 2,
      createdAt: '2026-11-22T00:00:00.000Z',
    };

    // Intentionally split SSE frames mid-JSON across chunks
    const sseChunks = [
      'event: delta\ndata: {"text":"Hello ',
      'world"}\n\nevent: trace\ndata: ' + JSON.stringify({ trace: mockTrace }) + '\n\n',
      'event: revision\ndata: ' +
        JSON.stringify({ latestVersion: mockVersion, versions: [] }) +
        '\n\nevent: done\ndata: ' +
        JSON.stringify({ assistantMessage: mockMsg, latestVersion: mockVersion, versions: [] }) +
        '\n\n',
    ];

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(makeStreamResponse(sseChunks));

    const deltas: string[] = [];
    const revisions: number[] = [];
    const traces: string[] = [];
    let doneContent = '';
    const errors: string[] = [];

    await apiClient.streamChat({
      documentId: 'doc-1',
      message: 'Refine summary',
      referencedHighlightIds: ['hl-1'],
      onDelta: (t) => deltas.push(t),
      onRevision: (p) => revisions.push(p.latestVersion.versionNumber),
      onTrace: (tr) => traces.push(tr.toolName),
      onDone: (p) => {
        doneContent = p.assistantMessage.content;
      },
      onError: (err) => errors.push(err),
    });

    expect(errors).toEqual([]);
    expect(deltas).toEqual(['Hello ' + 'world']);
    expect(traces).toEqual(['update_brief_section']);
    expect(revisions).toEqual([2]);
    expect(doneContent).toBe('Hello world');
  });

  it('invokes onError when streamChat receives a non-OK HTTP response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Message cannot be empty.' }), { status: 400 })
    );

    const errors: string[] = [];
    await apiClient.streamChat({
      documentId: 'doc-1',
      message: '',
      onDelta: () => {},
      onRevision: () => {},
      onTrace: () => {},
      onDone: () => {},
      onError: (m) => errors.push(m),
    });

    expect(errors).toEqual(['Message cannot be empty.']);
  });

  it('calls remaining REST endpoints with expected methods, encoded URLs, payloads, and unwrapped results', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);

    // uploadPdf (FormData)
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ documentId: 'doc-up', deduplicated: false }), { status: 202 })
    );
    const pdfFile = new File(['%PDF-1.4'], 'paper.pdf', { type: 'application/pdf' });
    const upRes = await apiClient.uploadPdf(pdfFile);
    expect(upRes).toEqual({ documentId: 'doc-up', deduplicated: false });
    const [upUrl, upInit] = fetchMock.mock.calls.at(-1)!;
    expect(upUrl).toBe('/api/documents/upload');
    expect(upInit?.method).toBe('POST');
    expect(upInit?.body).toBeInstanceOf(FormData);
    expect((upInit?.body as FormData).get('file')).toBe(pdfFile);

    // ingestUrl
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ documentId: 'doc-url', deduplicated: true }), { status: 200 })
    );
    expect(await apiClient.ingestUrl('https://example.com/a')).toEqual({
      documentId: 'doc-url',
      deduplicated: true,
    });
    expect(fetchMock.mock.calls.at(-1)![0]).toBe('/api/documents/url');

    // ingestText
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ documentId: 'doc-txt' }), { status: 201 })
    );
    expect(
      await apiClient.ingestText({ title: 'Notes', text: 'Body', sourceUrl: 'https://x.io' })
    ).toEqual({ documentId: 'doc-txt' });
    expect(fetchMock.mock.calls.at(-1)![0]).toBe('/api/documents/text');

    // resumeDocument & deleteDocument & revertVersion (URL encoding check)
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ documentId: 'doc/1' }), { status: 200 })
    );
    expect(await apiClient.resumeDocument('doc/1')).toEqual({ documentId: 'doc/1' });
    expect(fetchMock.mock.calls.at(-1)![0]).toBe('/api/documents/doc%2F1/resume');

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ deleted: true }), { status: 200 }));
    await apiClient.deleteDocument('doc/1');
    expect(fetchMock.mock.calls.at(-1)).toEqual(['/api/documents/doc%2F1', { method: 'DELETE' }]);

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ latestVersion: { versionNumber: 3 }, versions: [] }), {
        status: 200,
      })
    );
    const rev = await apiClient.revertVersion('doc/1', 1);
    expect(rev.latestVersion.versionNumber).toBe(3);
    expect(fetchMock.mock.calls.at(-1)![0]).toBe('/api/documents/doc%2F1/revert');

    // saveMemory & deleteMemory
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          preference: {
            id: 'mem-1',
            preferenceKey: 'latency',
            learnedRule: 'Highlight p99 latency.',
            sourceEvidence: 'User added',
            confidence: 1,
            updatedAt: '2026-11-22T00:00:00.000Z',
          },
        }),
        { status: 200 }
      )
    );
    const savedPref = await apiClient.saveMemory('latency', 'Highlight p99 latency.');
    expect(savedPref.id).toBe('mem-1');
    expect(fetchMock.mock.calls.at(-1)![0]).toBe('/api/memory');

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ deleted: true }), { status: 200 }));
    await apiClient.deleteMemory('mem/1');
    expect(fetchMock.mock.calls.at(-1)).toEqual(['/api/memory/mem%2F1', { method: 'DELETE' }]);

    // getDiagnostics & cleanOrphanTempFiles
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'healthy', documentCount: 2 }), { status: 200 })
    );
    const diag = await apiClient.getDiagnostics();
    expect(diag.status).toBe('healthy');
    expect(fetchMock.mock.calls.at(-1)![0]).toBe('/api/diagnostics');

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ removed: 4 }), { status: 200 }));
    expect(await apiClient.cleanOrphanTempFiles()).toEqual({ removed: 4 });
    expect(fetchMock.mock.calls.at(-1)).toEqual(['/api/diagnostics/cleanup', { method: 'POST' }]);
  });

  it('handles SSE error events, malformed SSE frames, non-JSON HTTP errors, and null stream bodies', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);

    // 1. In-stream SSE `event: error` + malformed JSON frame skipped gracefully
    const sseChunks = [
      'event: delta\ndata: {bad-json\n\n',
      'event: delta\ndata: {"text":"Partial"}\n\n',
      'event: error\ndata: {"error":"Gemini upstream timeout"}\n\n',
    ];
    fetchMock.mockResolvedValueOnce(makeStreamResponse(sseChunks));

    const deltas: string[] = [];
    const errors: string[] = [];
    await apiClient.streamChat({
      documentId: 'doc-1',
      message: 'Check stream error',
      onDelta: (t) => deltas.push(t),
      onRevision: () => {},
      onTrace: () => {},
      onDone: () => {},
      onError: (m) => errors.push(m),
    });
    expect(deltas).toEqual(['Partial']);
    expect(errors).toEqual(['Gemini upstream timeout']);

    // 2. Non-OK non-JSON stream response
    fetchMock.mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }));
    const httpErrors: string[] = [];
    await apiClient.streamChat({
      documentId: 'doc-1',
      message: 'Trigger 502',
      onDelta: () => {},
      onRevision: () => {},
      onTrace: () => {},
      onDone: () => {},
      onError: (m) => httpErrors.push(m),
    });
    expect(httpErrors).toEqual(['Chat failed (502)']);

    // 3. OK response with null body
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const bodyErrors: string[] = [];
    await apiClient.streamChat({
      documentId: 'doc-1',
      message: 'Null body',
      onDelta: () => {},
      onRevision: () => {},
      onTrace: () => {},
      onDone: () => {},
      onError: (m) => bodyErrors.push(m),
    });
    expect(bodyErrors).toEqual(['Chat failed (200)']);
  });

  it('downloadFile saves binary PDF blobs via object URL and rejects HTML cookie-check redirects', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    const createObjectUrlMock = vi.fn(() => 'blob:mock-pdf');
    const revokeObjectUrlMock = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectUrlMock, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectUrlMock, configurable: true });

    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': 'attachment; filename="Agents-annotated-v1.pdf"',
        },
      })
    );

    await apiClient.downloadFile('/api/documents/doc-1/pdf/annotated?download=1', 'fallback.pdf');
    expect(createObjectUrlMock).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);

    // Rejects __cookie_check HTML page even if returned with HTTP 200
    fetchMock.mockResolvedValueOnce(
      new Response('<!doctype html><html><title>Cookie check</title></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })
    );
    await expect(
      apiClient.downloadFile('/api/documents/doc-1/pdf/annotated?download=1', 'fallback.pdf')
    ).rejects.toThrow('Server returned an HTML page instead of the requested file');

    // Surfaces JSON error from non-OK download
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Failed to generate annotated PDF.' }), { status: 500 })
    );
    await expect(
      apiClient.downloadFile('/api/documents/doc-1/pdf/annotated?download=1', 'fallback.pdf')
    ).rejects.toThrow('Failed to generate annotated PDF.');
  });
});
