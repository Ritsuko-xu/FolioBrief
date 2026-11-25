/** Active document workspace rendering the toolbar, job states, PDF/Brief canvas modes, and side chat. */
import React, { useState } from 'react';
import { Download, Loader2, RotateCcw, RotateCw } from 'lucide-react';
import type {
  CanvasViewMode,
  DocumentDetailResponse,
  HighlightItem,
  ToolTraceRecord,
} from '../shared/types.ts';
import { apiClient } from '../api/client.ts';
import { BriefCanvas } from './BriefCanvas.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { PdfAnnotatorCanvas } from './PdfAnnotatorCanvas.tsx';
import { SideChatPanel } from './SideChatPanel.tsx';

interface DocumentWorkspaceProps {
  detail: DocumentDetailResponse;
  viewMode: CanvasViewMode;
  onChangeViewMode: (mode: CanvasViewMode) => void;
  activeHighlightId: string | null;
  onSelectHighlight: (id: string | null) => void;
  attachedHighlight: HighlightItem | null;
  onAttachHighlight: (hl: HighlightItem | null) => void;
  onSelectDocument: (id: string) => void;
  onResume: (id: string) => Promise<void>;
  onRevert: (versionNumber: number) => Promise<void>;
  onSendMessage: (message: string, referencedHighlightIds: string[]) => Promise<void>;
  streamingText: string;
  streamingTraces: ToolTraceRecord[];
  isStreaming: boolean;
  chatError: string | null;
  onNotify?: (message: string) => void;
}

const VIEW_TABS: ReadonlyArray<{ id: CanvasViewMode; label: string }> = [
  { id: 'annotated', label: 'Annotated Source' },
  { id: 'brief', label: 'Executive Brief' },
  { id: 'split', label: 'Split View' },
];

/** Renders the active document toolbar, job-progress fallback states, reader canvases, and side chat. */
export const DocumentWorkspace: React.FC<DocumentWorkspaceProps> = ({
  detail,
  viewMode,
  onChangeViewMode,
  activeHighlightId,
  onSelectHighlight,
  attachedHighlight,
  onAttachHighlight,
  onSelectDocument,
  onResume,
  onRevert,
  onSendMessage,
  streamingText,
  streamingTraces,
  isStreaming,
  chatError,
  onNotify,
}) => {
  const [downloadingKind, setDownloadingKind] = useState<'source' | 'brief' | 'annotated' | null>(null);
  const { document, latestVersion, versions, chatMessages, relatedDocuments } = detail;
  const isProcessing =
    document.jobStatus === 'queued' ||
    document.jobStatus === 'extracting' ||
    document.jobStatus === 'synthesizing';
  const isBroken = document.jobStatus === 'interrupted' || document.jobStatus === 'failed';

  const safeBaseName =
    document.title.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60) || 'document';

  const handleDownloadPdf = async (kind: 'source' | 'brief' | 'annotated') => {
    if (downloadingKind) return;
    setDownloadingKind(kind);
    try {
      const url = `/api/documents/${encodeURIComponent(document.id)}/pdf/${kind}?download=1`;
      const suffix =
        kind === 'source'
          ? 'source.pdf'
          : `${kind}-v${latestVersion?.versionNumber ?? 1}.pdf`;
      await apiClient.downloadFile(url, `${safeBaseName}-${suffix}`);
    } catch (err) {
      onNotify?.((err as Error).message || 'Failed to download PDF.');
    } finally {
      setDownloadingKind(null);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0">
      {/* Document Workspace Toolbar */}
      <div className="px-6 py-3 bg-paper border-b border-hairline flex flex-wrap items-center justify-between gap-4 shrink-0">
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-lg font-semibold text-ink truncate">
            {document.title}
          </h1>
          <div className="flex items-center gap-2 text-xs text-ink-muted tabular-nums">
            <span>{document.sourceDomain ?? 'Uploaded PDF'}</span>
            <span aria-hidden="true">·</span>
            <span>{document.pageCount || '—'} pages</span>
            {latestVersion && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono">v{latestVersion.versionNumber}</span>
              </>
            )}
          </div>
        </div>

        {/* Segmented Canvas Mode Switcher */}
        <div className="flex items-center gap-1 p-1 bg-stone-panel border border-hairline rounded-lg shrink-0">
          {VIEW_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => onChangeViewMode(tab.id)}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                viewMode === tab.id
                  ? 'bg-sheet text-ink shadow-xs'
                  : 'text-ink-muted hover:text-ink'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Export & Undo Actions */}
        <div className="flex items-center gap-2 shrink-0">
          {versions.length > 1 && latestVersion && (
            <button
              type="button"
              onClick={() => void onRevert(versions[1].versionNumber)}
              title={`Undo to v${versions[1].versionNumber}`}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-ink bg-sheet border border-hairline rounded-lg hover:bg-stone-panel transition-colors whitespace-nowrap shrink-0"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Undo
            </button>
          )}

          <button
            type="button"
            disabled={downloadingKind !== null}
            onClick={() => void handleDownloadPdf('source')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-ink bg-sheet border border-hairline rounded-lg hover:bg-stone-panel disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
          >
            {downloadingKind === 'source' ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Download className="w-3.5 h-3.5" />
            )}
            Source PDF
          </button>

          {latestVersion && (
            <>
              <button
                type="button"
                disabled={downloadingKind !== null}
                onClick={() => void handleDownloadPdf('brief')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-ink bg-sheet border border-hairline rounded-lg hover:bg-stone-panel disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
              >
                {downloadingKind === 'brief' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Download className="w-3.5 h-3.5" />
                )}
                Brief PDF
              </button>
              <button
                type="button"
                disabled={downloadingKind !== null}
                onClick={() => void handleDownloadPdf('annotated')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-cobalt rounded-lg hover:bg-cobalt-hover disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
              >
                {downloadingKind === 'annotated' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Download className="w-3.5 h-3.5" />
                )}
                Annotated PDF
              </button>
            </>
          )}
        </div>
      </div>

      {/* Center Canvas + Docked Side Chat */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {isProcessing ? (
          <div className="flex-1 flex flex-col items-center justify-center p-10 text-center space-y-4">
            <Loader2 className="w-7 h-7 text-cobalt animate-spin" />
            <div className="space-y-1">
              <h2 className="font-display text-xl font-semibold text-ink capitalize">
                {document.jobStatus} document...
              </h2>
              <p className="text-sm text-ink-muted max-w-md">
                Extracting page anchors, retrieving prior reading context, and synthesizing your Executive Brief & concise highlights.
              </p>
            </div>
          </div>
        ) : isBroken || !latestVersion ? (
          <div className="flex-1 flex flex-col items-center justify-center p-10 text-center space-y-4">
            <div className="p-6 bg-sheet border border-hairline rounded-2xl max-w-md space-y-3">
              <h2 className="font-display text-lg font-semibold text-ink">
                {document.jobStatus === 'interrupted' ? 'Analysis Interrupted' : 'Analysis Failed'}
              </h2>
              <p className="text-sm text-ink-muted leading-relaxed">
                {document.errorMessage ?? 'The analysis job did not complete.'}
              </p>
              <button
                type="button"
                onClick={() => void onResume(document.id)}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-cobalt rounded-lg hover:bg-cobalt-hover transition-colors whitespace-nowrap shrink-0"
              >
                <RotateCw className="w-3.5 h-3.5" />
                Resume Analysis
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex-1 flex min-w-0 min-h-0 overflow-hidden">
              {(viewMode === 'annotated' || viewMode === 'split') && (
                <div
                  className={`flex min-w-0 min-h-0 ${
                    viewMode === 'split' ? 'w-1/2 border-r border-hairline' : 'flex-1'
                  }`}
                >
                  <ErrorBoundary fallbackTitle="PDF Page Renderer Error">
                    <PdfAnnotatorCanvas
                      documentId={document.id}
                      highlights={latestVersion.highlights}
                      activeHighlightId={activeHighlightId}
                      compact={viewMode === 'split'}
                      onSelectHighlight={onSelectHighlight}
                      onAskAboutHighlight={onAttachHighlight}
                    />
                  </ErrorBoundary>
                </div>
              )}

              {(viewMode === 'brief' || viewMode === 'split') && (
                <div className={`flex min-w-0 min-h-0 ${viewMode === 'split' ? 'w-1/2' : 'flex-1'}`}>
                  <BriefCanvas
                    title={document.title}
                    sourceDomain={document.sourceDomain}
                    pageCount={document.pageCount}
                    version={latestVersion}
                    relatedDocuments={relatedDocuments}
                    onSelectDocument={onSelectDocument}
                  />
                </div>
              )}
            </div>

            <SideChatPanel
              documentId={document.id}
              messages={chatMessages}
              attachedHighlight={attachedHighlight}
              onClearAttachedHighlight={() => onAttachHighlight(null)}
              onSendMessage={onSendMessage}
              onUndoToBeforeVersion={onRevert}
              streamingText={streamingText}
              streamingTraces={streamingTraces}
              isStreaming={isStreaming}
              chatError={chatError}
            />
          </>
        )}
      </div>
    </div>
  );
};
