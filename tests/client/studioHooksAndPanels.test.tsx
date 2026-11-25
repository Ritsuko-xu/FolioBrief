// @vitest-environment jsdom
/** Component and hook tests for LibrarySidebar, IngestionView, SideChatPanel, and useStudioState (jsdom). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LibrarySidebar } from '../../src/components/LibrarySidebar.tsx';
import { IngestionView } from '../../src/components/IngestionView.tsx';
import { SideChatPanel } from '../../src/components/SideChatPanel.tsx';
import { useStudioState } from '../../src/hooks/useStudioState.ts';
import type { ChatMessage, DocumentDetailResponse, DocumentListItem, HighlightItem } from '../../src/shared/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('Studio Sidebar, Ingestion, SideChat & useStudioState', () => {
  let container: HTMLDivElement;
  let root: Root;

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
    vi.restoreAllMocks();
  });

  it('LibrarySidebar renders unified documents without source tabs and handles delete/resume', () => {
    const docs: DocumentListItem[] = [
      {
        id: 'd1',
        title: 'Speculative Decoding',
        sourceType: 'pdf',
        sourceUrl: null,
        sourceDomain: null,
        jobStatus: 'ready',
        errorMessage: null,
        pageCount: 12,
        latestVersionNumber: 1,
        highlightCount: 5,
        createdAt: '2026-11-22T00:00:00.000Z',
        updatedAt: '2026-11-22T00:00:00.000Z',
      },
      {
        id: 'd2',
        title: 'Systems Blog Post',
        sourceType: 'url',
        sourceUrl: 'https://example.com/post',
        sourceDomain: 'example.com',
        jobStatus: 'interrupted',
        errorMessage: 'Server restarted',
        pageCount: 4,
        latestVersionNumber: null,
        highlightCount: 0,
        createdAt: '2026-11-22T00:00:00.000Z',
        updatedAt: '2026-11-22T00:00:00.000Z',
      },
    ];
    const onSelect = vi.fn();
    const onResume = vi.fn();
    const onDelete = vi.fn();

    act(() => {
      root.render(
        <LibrarySidebar
          documents={docs}
          selectedId="d1"
          searchQuery=""
          onSearchChange={() => {}}
          onSelect={onSelect}
          onResume={onResume}
          onDelete={onDelete}
        />
      );
    });

    expect(container.textContent).not.toContain('PDFs');
    expect(container.textContent).not.toContain('Articles');
    expect(container.textContent).toContain('Speculative Decoding');
    expect(container.textContent).toContain('example.com');

    // Resume interrupted doc
    const resumeBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Resume')
    );
    expect(resumeBtn).toBeTruthy();
    act(() => {
      resumeBtn!.click();
    });
    expect(onResume).toHaveBeenCalledWith('d2');

    // Two-step delete confirmation
    const delBtn = container.querySelector('button[aria-label="Delete Speculative Decoding"]') as HTMLButtonElement;
    act(() => {
      delBtn.click();
    });
    const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Remove');
    act(() => {
      confirmBtn!.click();
    });
    expect(onDelete).toHaveBeenCalledWith('d1');
  });

  it('IngestionView validates URL submissions and falls back cleanly to pasted text', async () => {
    const onUploadPdf = vi.fn(async () => {});
    const onIngestUrl = vi.fn(async () => {
      throw new Error('Paywalled site');
    });
    const onIngestText = vi.fn(async () => {});

    act(() => {
      root.render(
        <IngestionView
          onUploadPdf={onUploadPdf}
          onIngestUrl={onIngestUrl}
          onIngestText={onIngestText}
        />
      );
    });

    const urlInput = container.querySelector('#article-url-input') as HTMLInputElement;
    const urlForm = urlInput.closest('form')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(urlInput, 'https://example.org/post');
      urlInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      urlForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(onIngestUrl).toHaveBeenCalledWith('https://example.org/post');
    expect(container.textContent).toContain('Paywalled site');
    // Text fallback automatically opens after URL error
    expect(container.querySelector('textarea')).toBeTruthy();
  });

  it('LibrarySidebar renders empty states and cancels two-step delete safely', () => {
    const onDelete = vi.fn();

    act(() => {
      root.render(
        <LibrarySidebar
          documents={[]}
          selectedId={null}
          searchQuery=""
          onSearchChange={() => {}}
          onSelect={() => {}}
          onResume={() => {}}
          onDelete={onDelete}
        />
      );
    });
    expect(container.textContent).toContain('Your library is empty');

    act(() => {
      root.render(
        <LibrarySidebar
          documents={[]}
          selectedId={null}
          searchQuery="nonexistent"
          onSearchChange={() => {}}
          onSelect={() => {}}
          onResume={() => {}}
          onDelete={onDelete}
        />
      );
    });
    expect(container.textContent).toContain('No matching readings found.');

    const docs: DocumentListItem[] = [
      {
        id: 'd1',
        title: 'Keep Me Paper',
        sourceType: 'pdf',
        sourceUrl: null,
        sourceDomain: null,
        jobStatus: 'ready',
        errorMessage: null,
        pageCount: 5,
        latestVersionNumber: 1,
        highlightCount: 0,
        createdAt: '2026-11-22T00:00:00.000Z',
        updatedAt: '2026-11-22T00:00:00.000Z',
      },
    ];
    act(() => {
      root.render(
        <LibrarySidebar
          documents={docs}
          selectedId="d1"
          searchQuery=""
          onSearchChange={() => {}}
          onSelect={() => {}}
          onResume={() => {}}
          onDelete={onDelete}
        />
      );
    });
    const delBtn = container.querySelector('button[aria-label="Delete Keep Me Paper"]') as HTMLButtonElement;
    act(() => {
      delBtn.click();
    });
    const cancelBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Cancel');
    act(() => {
      cancelBtn!.click();
    });
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('IngestionView rejects empty URL, non-PDF files, and short pasted text without calling handlers', async () => {
    const onUploadPdf = vi.fn(async () => {});
    const onIngestUrl = vi.fn(async () => {});
    const onIngestText = vi.fn(async () => {});

    act(() => {
      root.render(
        <IngestionView
          onUploadPdf={onUploadPdf}
          onIngestUrl={onIngestUrl}
          onIngestText={onIngestText}
        />
      );
    });

    // Empty URL submit
    const urlInput = container.querySelector('#article-url-input') as HTMLInputElement;
    await act(async () => {
      urlInput.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(onIngestUrl).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Enter an article or paper URL to synthesize.');

    // Invalid file type (.txt) via file input change
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const badFile = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    Object.defineProperty(fileInput, 'files', { value: [badFile], configurable: true });
    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onUploadPdf).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Please choose a valid .pdf file.');

    // Open pasted text fallback and submit short body (< 60 chars)
    const toggleBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Paste article text directly')
    );
    act(() => {
      toggleBtn!.click();
    });
    const titleInput = container.querySelector('input[placeholder="Article or Paper Title"]') as HTMLInputElement;
    const bodyInput = container.querySelector('textarea') as HTMLTextAreaElement;
    const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    const textSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      inputSetter.call(titleInput, 'Short Title');
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
      textSetter.call(bodyInput, 'Too short.');
      bodyInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      bodyInput.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(onIngestText).not.toHaveBeenCalled();
    expect(container.textContent).toContain('at least 60 characters');
  });

  it('SideChatPanel submits messages with attached highlight IDs, ignores blank submits, shows chatError, and disables while streaming', async () => {
    const hl: HighlightItem = {
      id: 'hl-9',
      page: 2,
      quoteAnchor: 'Constant-memory KV cache',
      category: 'claim',
      comment: 'Core contribution',
    };
    const messages: ChatMessage[] = [
      {
        id: 'm1',
        documentId: 'd1',
        role: 'assistant',
        content: 'Updated Open Questions.',
        referencedHighlightIds: [],
        appliedVersionNumber: 2,
        createdAt: '2026-11-22T00:00:00.000Z',
        traces: [
          {
            id: 't1',
            documentId: 'd1',
            chatMessageId: 'm1',
            model: 'gemini-4-hydrogen',
            toolName: 'update_brief_section',
            rawArgsJson: '{"section":"openQuestions"}',
            status: 'ok',
            resultSummary: 'Updated openQuestions -> v2',
            beforeVersion: 1,
            afterVersion: 2,
            durationMs: 18,
            createdAt: '2026-11-22T00:00:00.000Z',
          },
        ],
      },
    ];
    const onSendMessage = vi.fn(async () => {});
    const onClearAttached = vi.fn();
    const onUndo = vi.fn(async () => {});

    act(() => {
      root.render(
        <SideChatPanel
          documentId="d1"
          messages={messages}
          attachedHighlight={hl}
          onClearAttachedHighlight={onClearAttached}
          onSendMessage={onSendMessage}
          onUndoToBeforeVersion={onUndo}
          streamingText=""
          streamingTraces={[]}
          isStreaming={true}
          chatError="Stream disconnected"
        />
      );
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Stream disconnected');
    expect(container.textContent).toContain('Thinking & checking document...');

    // Blank submission ignored while not streaming
    act(() => {
      root.render(
        <SideChatPanel
          documentId="d1"
          messages={messages}
          attachedHighlight={hl}
          onClearAttachedHighlight={onClearAttached}
          onSendMessage={onSendMessage}
          onUndoToBeforeVersion={onUndo}
          streamingText=""
          streamingTraces={[]}
          isStreaming={false}
          chatError={null}
        />
      );
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    const textSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      textSetter.call(textarea, '   ');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      textarea.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(onSendMessage).not.toHaveBeenCalled();

    // Toggle trace disclosure & click Undo
    const traceBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Revision v1')
    );
    expect(traceBtn).toBeTruthy();
    act(() => {
      traceBtn!.click();
    });
    expect(container.textContent).toContain('Updated openQuestions -> v2');

    const undoBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Undo')
    );
    await act(async () => {
      undoBtn!.click();
    });
    expect(onUndo).toHaveBeenCalledWith(1);

    // Submit message with attached highlight
    act(() => {
      textSetter.call(textarea, 'Clarify this claim');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      textarea.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(onClearAttached).toHaveBeenCalled();
    expect(onSendMessage).toHaveBeenCalledWith('Clarify this claim', ['hl-9']);
  });

  it('useStudioState loads library, selects documents, and updates state on revert', async () => {
    const sampleDoc: DocumentListItem = {
      id: 'doc-1',
      title: 'Attention Sinks',
      sourceType: 'pdf',
      sourceUrl: null,
      sourceDomain: null,
      jobStatus: 'ready',
      errorMessage: null,
      pageCount: 6,
      latestVersionNumber: 1,
      highlightCount: 2,
      createdAt: '2026-11-22T00:00:00.000Z',
      updatedAt: '2026-11-22T00:00:00.000Z',
    };
    const sampleDetail: DocumentDetailResponse = {
      document: {
        id: sampleDoc.id,
        title: sampleDoc.title,
        sourceType: sampleDoc.sourceType,
        sourceUrl: null,
        sourceDomain: null,
        sourcePdfPath: '/tmp/source.pdf',
        contentHash: 'abc123',
        jobStatus: 'ready',
        errorMessage: null,
        extractedText: 'Text',
        pageCount: 6,
        createdAt: sampleDoc.createdAt,
        updatedAt: sampleDoc.updatedAt,
      },
      latestVersion: {
        id: 'v1',
        documentId: 'doc-1',
        versionNumber: 1,
        summary: 'Summary',
        keyInsights: ['K1'],
        improvements: [],
        openQuestions: [],
        highlights: [],
        briefPdfPath: null,
        annotatedPdfPath: null,
        annotatedPdfDirty: false,
        revisionReason: 'Initial',
        createdAt: '2026-11-22T00:00:00.000Z',
      },
      versions: [{ id: 'v1', versionNumber: 1, revisionReason: 'Initial', createdAt: '2026-11-22T00:00:00.000Z' }],
      chatMessages: [],
      relatedDocuments: [],
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/documents?q=') || url === '/api/documents') {
        return new Response(JSON.stringify({ documents: [sampleDoc] }), { status: 200 });
      }
      if (url === '/api/documents/doc-1') {
        return new Response(JSON.stringify(sampleDetail), { status: 200 });
      }
      if (url === '/api/documents/doc-1/revert') {
        return new Response(
          JSON.stringify({
            latestVersion: { ...sampleDetail.latestVersion!, id: 'v2', versionNumber: 2 },
            versions: [
              { id: 'v2', versionNumber: 2, revisionReason: 'Revert to v1', createdAt: '2026-11-22T00:00:00.000Z' },
              ...sampleDetail.versions,
            ],
          }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    let hookApi!: ReturnType<typeof useStudioState>;
    function Harness() {
      hookApi = useStudioState();
      return null;
    }

    act(() => {
      root.render(<Harness />);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(hookApi.documents.length).toBe(1);

    await act(async () => {
      hookApi.selectDocument('doc-1');
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(hookApi.detail?.document.title).toBe('Attention Sinks');

    await act(async () => {
      await hookApi.handleRevert(1);
    });
    expect(hookApi.detail?.latestVersion?.versionNumber).toBe(2);
    expect(hookApi.toastMsg).toContain('Reverted analysis to v1');

    globalThis.fetch = originalFetch;
  });
});
