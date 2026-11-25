// @vitest-environment jsdom
/** Component tests for MemoryView, DiagnosticsView, DocumentWorkspace, and ErrorBoundary (jsdom, mocked PDF canvas). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../src/components/PdfAnnotatorCanvas.tsx', () => ({
  PdfAnnotatorCanvas: ({ documentId }: { documentId: string }) => (
    <div data-testid="mock-pdf-canvas">PDF Canvas: {documentId}</div>
  ),
}));

import { MemoryView } from '../../src/components/MemoryView.tsx';
import { DiagnosticsView } from '../../src/components/DiagnosticsView.tsx';
import { DocumentWorkspace } from '../../src/components/DocumentWorkspace.tsx';
import { ErrorBoundary } from '../../src/components/ErrorBoundary.tsx';
import type { DocumentDetailResponse } from '../../src/shared/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeDetail(overrides?: Partial<DocumentDetailResponse['document']>): DocumentDetailResponse {
  return {
    document: {
      id: 'doc-1',
      title: 'Attention Sink Analysis',
      sourceType: 'pdf',
      sourceUrl: null,
      sourceDomain: null,
      sourcePdfPath: '/tmp/source.pdf',
      contentHash: 'hash-1',
      jobStatus: 'ready',
      errorMessage: null,
      extractedText: 'Extracted prose',
      pageCount: 8,
      createdAt: '2026-11-22T00:00:00.000Z',
      updatedAt: '2026-11-22T00:00:00.000Z',
      ...overrides,
    },
    latestVersion: {
      id: 'v2',
      documentId: 'doc-1',
      versionNumber: 2,
      summary: 'Concise v2 summary.',
      keyInsights: ['Insight A'],
      improvements: ['Improvement B'],
      openQuestions: ['Question C?'],
      highlights: [],
      briefPdfPath: '/tmp/brief_v2.pdf',
      annotatedPdfPath: null,
      annotatedPdfDirty: true,
      revisionReason: 'Updated questions',
      createdAt: '2026-11-22T00:00:00.000Z',
    },
    versions: [
      { id: 'v2', versionNumber: 2, revisionReason: 'Updated questions', createdAt: '2026-11-22T00:00:00.000Z' },
      { id: 'v1', versionNumber: 1, revisionReason: 'Initial AI synthesis', createdAt: '2026-11-22T00:00:00.000Z' },
    ],
    chatMessages: [],
    relatedDocuments: [],
  };
}

describe('Studio Secondary Views: MemoryView, DiagnosticsView, DocumentWorkspace & ErrorBoundary', () => {
  let container: HTMLDivElement;
  let root: Root;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('MemoryView loads rules, ignores blank submissions, saves new rules, and deletes existing rules', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/memory' && (!init?.method || init.method === 'GET')) {
        return new Response(
          JSON.stringify({
            preferences: [
              {
                id: 'm1',
                preferenceKey: 'latency_focus',
                learnedRule: 'Highlight p99 tail latency.',
                sourceEvidence: 'User added',
                confidence: 0.9,
                updatedAt: '2026-11-22T00:00:00.000Z',
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (url === '/api/memory' && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            preference: {
              id: 'm2',
              preferenceKey: 'memory_cap',
              learnedRule: 'Flag VRAM budgets.',
              sourceEvidence: 'User added',
              confidence: 1,
              updatedAt: '2026-11-22T00:00:00.000Z',
            },
          }),
          { status: 201 }
        );
      }
      if (url === '/api/memory/m1' && init?.method === 'DELETE') {
        return new Response(JSON.stringify({ deleted: true }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await act(async () => {
      root.render(<MemoryView />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(container.textContent).toContain('latency_focus');

    // Blank submission does not POST
    const form = container.querySelector('form')!;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(fetchMock.mock.calls.filter((c) => c[1]?.method === 'POST')).toHaveLength(0);

    // Valid rule save
    const inputs = container.querySelectorAll('form input');
    const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      inputSetter.call(inputs[0], 'memory_cap');
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      inputSetter.call(inputs[1], 'Flag VRAM budgets.');
      inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(fetchMock.mock.calls.filter((c) => c[1]?.method === 'POST')).toHaveLength(1);

    // Delete rule
    const delBtn = container.querySelector('button[aria-label="Delete latency_focus"]') as HTMLButtonElement;
    await act(async () => {
      delBtn.click();
    });
    expect(container.textContent).not.toContain('Highlight p99 tail latency.');
  });

  it('DiagnosticsView renders snapshot metrics, traces, logs, and runs temp-file cleanup', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/diagnostics') {
        return new Response(
          JSON.stringify({
            status: 'healthy',
            sqliteIntegrity: 'ok',
            sqliteWalMode: 'wal',
            documentCount: 4,
            interruptedJobs: 0,
            pdfStorageBytes: 2048,
            pdfFileCount: 6,
            orphanTempFiles: 1,
            recentLogs: [
              {
                timestamp: '2026-11-22T12:00:00.000Z',
                level: 'info',
                module: 'pipeline',
                message: 'Synthesis complete',
                requestId: 'req-1',
              },
            ],
            recentTraces: [
              {
                id: 'tr-1',
                documentId: 'doc-1',
                chatMessageId: null,
                model: 'gemini-4-hydrogen',
                toolName: 'update_brief_section',
                rawArgsJson: '{}',
                status: 'ok',
                resultSummary: 'Updated summary -> v2',
                beforeVersion: 1,
                afterVersion: 2,
                durationMs: 14,
                createdAt: '2026-11-22T12:00:00.000Z',
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (url === '/api/diagnostics/cleanup' && init?.method === 'POST') {
        return new Response(JSON.stringify({ removed: 1 }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;

    await act(async () => {
      root.render(<DiagnosticsView />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(container.textContent).toContain('ok · wal');
    expect(container.textContent).toContain('2.0 KB (6 files)');
    expect(container.textContent).toContain('update_brief_section');
    expect(container.textContent).toContain('Synthesis complete');

    const cleanBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Clean Temp Files')
    );
    await act(async () => {
      cleanBtn!.click();
    });
    expect(container.textContent).toContain('Removed 1 orphan temporary file(s).');
  });

  it('DocumentWorkspace switches view modes, triggers Undo, and shows processing/failed Resume states', async () => {
    const onChangeViewMode = vi.fn();
    const onRevert = vi.fn(async () => {});
    const onResume = vi.fn(async () => {});

    act(() => {
      root.render(
        <DocumentWorkspace
          detail={makeDetail()}
          viewMode="split"
          onChangeViewMode={onChangeViewMode}
          activeHighlightId={null}
          onSelectHighlight={() => {}}
          attachedHighlight={null}
          onAttachHighlight={() => {}}
          onSelectDocument={() => {}}
          onResume={onResume}
          onRevert={onRevert}
          onSendMessage={async () => {}}
          streamingText=""
          streamingTraces={[]}
          isStreaming={false}
          chatError={null}
        />
      );
    });

    expect(container.querySelector('[data-testid="mock-pdf-canvas"]')).toBeTruthy();
    expect(container.textContent).toContain('Concise v2 summary.');

    const briefTab = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent === 'Executive Brief'
    );
    act(() => {
      briefTab!.click();
    });
    expect(onChangeViewMode).toHaveBeenCalledWith('brief');

    const undoBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Undo')
    );
    await act(async () => {
      undoBtn!.click();
    });
    expect(onRevert).toHaveBeenCalledWith(1);

    // PDF download controls use button + fetch rather than raw <a download> links
    expect(container.querySelectorAll('a[download]')).toHaveLength(0);
    const onNotify = vi.fn();
    globalThis.fetch = vi.fn(async () =>
      new Response('<!doctype html><html><body>Cookie check</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })
    ) as unknown as typeof fetch;

    act(() => {
      root.render(
        <DocumentWorkspace
          detail={makeDetail()}
          viewMode="split"
          onChangeViewMode={onChangeViewMode}
          activeHighlightId={null}
          onSelectHighlight={() => {}}
          attachedHighlight={null}
          onAttachHighlight={() => {}}
          onSelectDocument={() => {}}
          onResume={onResume}
          onRevert={onRevert}
          onSendMessage={async () => {}}
          streamingText=""
          streamingTraces={[]}
          isStreaming={false}
          chatError={null}
          onNotify={onNotify}
        />
      );
    });

    const annotBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Annotated PDF')
    );
    expect(annotBtn).toBeTruthy();
    await act(async () => {
      annotBtn!.click();
    });
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/documents/doc-1/pdf/annotated?download=1');
    expect(onNotify).toHaveBeenCalledWith(
      expect.stringContaining('Server returned an HTML page instead of the requested file')
    );

    // Processing spinner state
    act(() => {
      root.render(
        <DocumentWorkspace
          detail={{ ...makeDetail({ jobStatus: 'synthesizing' }), latestVersion: null }}
          viewMode="split"
          onChangeViewMode={onChangeViewMode}
          activeHighlightId={null}
          onSelectHighlight={() => {}}
          attachedHighlight={null}
          onAttachHighlight={() => {}}
          onSelectDocument={() => {}}
          onResume={onResume}
          onRevert={onRevert}
          onSendMessage={async () => {}}
          streamingText=""
          streamingTraces={[]}
          isStreaming={false}
          chatError={null}
        />
      );
    });
    expect(container.textContent).toContain('synthesizing document...');

    // Interrupted / failed Resume state
    act(() => {
      root.render(
        <DocumentWorkspace
          detail={{
            ...makeDetail({ jobStatus: 'failed', errorMessage: 'Upstream timeout' }),
            latestVersion: null,
          }}
          viewMode="split"
          onChangeViewMode={onChangeViewMode}
          activeHighlightId={null}
          onSelectHighlight={() => {}}
          attachedHighlight={null}
          onAttachHighlight={() => {}}
          onSelectDocument={() => {}}
          onResume={onResume}
          onRevert={onRevert}
          onSendMessage={async () => {}}
          streamingText=""
          streamingTraces={[]}
          isStreaming={false}
          chatError={null}
        />
      );
    });
    expect(container.textContent).toContain('Analysis Failed');
    expect(container.textContent).toContain('Upstream timeout');
    const resumeBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Resume Analysis')
    );
    await act(async () => {
      resumeBtn!.click();
    });
    expect(onResume).toHaveBeenCalledWith('doc-1');
  });

  it('ErrorBoundary catches child render errors and recovers when Retry View is clicked', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let shouldThrow = true;

    function FlakyChild() {
      if (shouldThrow) {
        throw new Error('Corrupt PDF page stream');
      }
      return <div>Recovered PDF Canvas</div>;
    }

    act(() => {
      root.render(
        <ErrorBoundary fallbackTitle="PDF Page Renderer Error">
          <FlakyChild />
        </ErrorBoundary>
      );
    });

    expect(container.textContent).toContain('PDF Page Renderer Error');
    expect(container.textContent).toContain('Corrupt PDF page stream');

    shouldThrow = false;
    const retryBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Retry View')
    );
    act(() => {
      retryBtn!.click();
    });

    expect(container.textContent).toContain('Recovered PDF Canvas');
    consoleSpy.mockRestore();
  });
});
