/** Pure root layout shell wiring studio routes, library sidebar, active workspace, and toast banner. */
import { TopBar } from './components/TopBar.tsx';
import { LibrarySidebar } from './components/LibrarySidebar.tsx';
import { IngestionView } from './components/IngestionView.tsx';
import { DocumentWorkspace } from './components/DocumentWorkspace.tsx';
import { MemoryView } from './components/MemoryView.tsx';
import { DiagnosticsView } from './components/DiagnosticsView.tsx';
import { useStudioState } from './hooks/useStudioState.ts';

/** Renders the top-level studio shell backed by `useStudioState`. */
export default function App() {
  const studio = useStudioState();

  return (
    <div className="h-screen flex flex-col bg-paper text-ink overflow-hidden">
      <TopBar
        activeRoute={studio.activeRoute}
        onNavigate={studio.setActiveRoute}
        onNewReading={studio.startNewReading}
      />

      <main className="flex-1 flex min-h-0 overflow-hidden">
        {studio.activeRoute === 'workspace' && (
          <>
            <LibrarySidebar
              documents={studio.documents}
              selectedId={studio.selectedDocId}
              searchQuery={studio.searchQuery}
              onSearchChange={studio.setSearchQuery}
              onSelect={studio.selectDocument}
              onResume={studio.handleResume}
              onDelete={studio.handleDelete}
            />
            {!studio.selectedDocId || !studio.detail ? (
              <IngestionView
                onUploadPdf={studio.handleUploadPdf}
                onIngestUrl={studio.handleIngestUrl}
                onIngestText={studio.handleIngestText}
              />
            ) : (
              <DocumentWorkspace
                detail={studio.detail}
                viewMode={studio.viewMode}
                onChangeViewMode={studio.setViewMode}
                activeHighlightId={studio.activeHighlightId}
                onSelectHighlight={studio.setActiveHighlightId}
                attachedHighlight={studio.attachedHighlight}
                onAttachHighlight={studio.setAttachedHighlight}
                onSelectDocument={studio.setSelectedDocId}
                onResume={studio.handleResume}
                onRevert={studio.handleRevert}
                onSendMessage={studio.handleSendMessage}
                streamingText={studio.streamingText}
                streamingTraces={studio.streamingTraces}
                isStreaming={studio.isStreaming}
                chatError={studio.chatError}
                onNotify={studio.showToast}
              />
            )}
          </>
        )}

        {studio.activeRoute === 'memory' && <MemoryView />}
        {studio.activeRoute === 'diagnostics' && <DiagnosticsView />}
      </main>

      {studio.toastMsg && (
        <div
          role="status"
          className="fixed bottom-5 right-5 z-50 px-4 py-2.5 bg-ink text-paper text-xs font-medium rounded-xl shadow-lg"
        >
          {studio.toastMsg}
        </div>
      )}
    </div>
  );
}
