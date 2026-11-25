/** Collapsible left rail listing ingested readings with search, status badges, resume, and delete actions. */
import React, { useState } from 'react';
import { Search, Trash2, RotateCw, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import type { DocumentListItem } from '../shared/types.ts';

interface LibrarySidebarProps {
  documents: DocumentListItem[];
  selectedId: string | null;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onSelect: (id: string) => void;
  onResume: (id: string) => void;
  onDelete: (id: string) => void;
}

/** Collapsible reading library sidebar with FTS search, resume, and delete actions. */
export const LibrarySidebar: React.FC<LibrarySidebarProps> = ({
  documents,
  selectedId,
  searchQuery,
  onSearchChange,
  onSelect,
  onResume,
  onDelete,
}) => {
  const [collapsed, setCollapsed] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  if (collapsed) {
    return (
      <aside className="w-12 bg-stone-panel border-r border-hairline flex flex-col items-center py-4 shrink-0">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          title="Expand Library"
          aria-label="Expand Library"
          className="p-2 text-ink-muted hover:text-ink rounded-lg hover:bg-paper transition-colors"
        >
          <PanelLeftOpen className="w-4 h-4" />
        </button>
      </aside>
    );
  }

  return (
    <aside className="w-64 bg-stone-panel border-r border-hairline flex flex-col shrink-0 min-h-0">
      <div className="px-4 pt-4 pb-3 border-b border-hairline space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-sm font-semibold text-ink">Reading Library</h2>
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            title="Collapse Library"
            aria-label="Collapse Library"
            className="p-1.5 text-ink-muted hover:text-ink rounded-md hover:bg-paper transition-colors"
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
        </div>

        <div className="relative">
          <Search className="w-3.5 h-3.5 text-ink-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search papers & notes..."
            aria-label="Search library"
            className="w-full pl-8 pr-3 py-1.5 text-xs bg-paper border border-hairline rounded-lg text-ink placeholder:text-ink-muted focus:outline-none focus:border-cobalt"
          />
        </div>

      </div>

      <div className="flex-1 overflow-y-auto divide-y divide-hairline">
        {documents.length === 0 ? (
          <div className="p-6 text-center">
            <p className="text-xs text-ink-muted leading-relaxed">
              {searchQuery ? 'No matching readings found.' : 'Your library is empty. Upload a PDF or paste an article link to begin.'}
            </p>
          </div>
        ) : (
          documents.map((doc) => {
            const isSelected = doc.id === selectedId;
            const dateLabel = new Date(doc.createdAt).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
            });
            const needsRecovery = doc.jobStatus === 'interrupted' || doc.jobStatus === 'failed';
            const isProcessing =
              doc.jobStatus === 'queued' ||
              doc.jobStatus === 'extracting' ||
              doc.jobStatus === 'synthesizing';

            return (
              <div
                key={doc.id}
                className={`group px-4 py-3 transition-colors ${
                  isSelected ? 'bg-paper' : 'hover:bg-paper/60'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => onSelect(doc.id)}
                    className="text-left flex-1 min-w-0 focus-visible:outline-none"
                  >
                    <p
                      className={`text-sm leading-snug line-clamp-2 ${
                        isSelected ? 'font-semibold text-cobalt' : 'font-medium text-ink'
                      }`}
                    >
                      {doc.title}
                    </p>
                    <div className="mt-1.5 flex items-center flex-wrap gap-x-1.5 gap-y-0.5 text-[11px] text-ink-muted tabular-nums">
                      {doc.sourceDomain && (
                        <>
                          <span>{doc.sourceDomain}</span>
                          <span aria-hidden="true">·</span>
                        </>
                      )}
                      <span>{doc.pageCount > 0 ? `${doc.pageCount}p` : 'Pending'}</span>
                      <span aria-hidden="true">·</span>
                      <span>{dateLabel}</span>
                    </div>
                  </button>

                  <div className="flex items-center shrink-0">
                    {confirmDeleteId === doc.id ? (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            setConfirmDeleteId(null);
                            onDelete(doc.id);
                          }}
                          className="px-2 py-1 text-[11px] font-medium text-red-700 hover:underline"
                        >
                          Remove
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="px-1.5 py-1 text-[11px] text-ink-muted hover:text-ink"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(doc.id)}
                        title="Delete reading"
                        aria-label={`Delete ${doc.title}`}
                        className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1.5 text-ink-muted hover:text-red-700 rounded transition-opacity"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                {isProcessing && (
                  <p className="mt-1.5 text-[11px] text-cobalt font-medium capitalize">
                    {doc.jobStatus}...
                  </p>
                )}

                {needsRecovery && (
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <span className="text-[11px] text-amber-800 truncate">
                      {doc.jobStatus === 'interrupted' ? 'Interrupted' : 'Failed'}
                    </span>
                    <button
                      type="button"
                      onClick={() => onResume(doc.id)}
                      className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-cobalt hover:underline whitespace-nowrap shrink-0"
                    >
                      <RotateCw className="w-3 h-3" />
                      Resume
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
};
