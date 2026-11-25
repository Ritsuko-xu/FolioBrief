/** Docked side-chat panel supporting highlight citations, SSE streaming, tool traces, and version undo. */
import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Send, ChevronDown, ChevronRight, Undo2, X, Loader2 } from 'lucide-react';
import type { ChatMessage, HighlightItem, ToolTraceRecord } from '../shared/types.ts';

interface SideChatPanelProps {
  documentId: string;
  messages: ChatMessage[];
  attachedHighlight: HighlightItem | null;
  onClearAttachedHighlight: () => void;
  onSendMessage: (message: string, referencedHighlightIds: string[]) => Promise<void>;
  onUndoToBeforeVersion: (versionNumber: number) => Promise<void>;
  streamingText: string;
  streamingTraces: ToolTraceRecord[];
  isStreaming: boolean;
  chatError: string | null;
}

const STARTER_PROMPTS = [
  'Explain the core improvements in plain terms.',
  'Make Open-Ended Questions more focused on real-world trade-offs.',
  'Compare this article with my prior related readings.',
];

/** Docked side-chat panel streaming grounded explanations, tool-call traces, and one-click revision undo. */
export const SideChatPanel: React.FC<SideChatPanelProps> = ({
  messages,
  attachedHighlight,
  onClearAttachedHighlight,
  onSendMessage,
  onUndoToBeforeVersion,
  streamingText,
  streamingTraces,
  isStreaming,
  chatError,
}) => {
  const [input, setInput] = useState('');
  const [expandedTraceMsgIds, setExpandedTraceMsgIds] = useState<Set<string>>(new Set());
  const scrollEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, streamingText]);

  const toggleTrace = (id: string) => {
    setExpandedTraceMsgIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;
    const refIds = attachedHighlight ? [attachedHighlight.id] : [];
    setInput('');
    onClearAttachedHighlight();
    await onSendMessage(trimmed, refIds);
  };

  return (
    <aside className="w-96 bg-stone-panel border-l border-hairline flex flex-col shrink-0 min-h-0">
      <div className="px-4 py-3.5 border-b border-hairline bg-paper/60">
        <h2 className="font-display text-sm font-semibold text-ink">Reading Side Chat</h2>
        <p className="text-[11px] text-ink-muted mt-0.5">
          Ask questions or instruct AI to revise Brief & Highlights
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && !isStreaming && (
          <div className="space-y-3 py-2">
            <p className="text-xs text-ink-muted leading-relaxed">
              Ask for clarifications on any section, or ask to rewrite insights, add highlights, or adjust focus.
            </p>
            <div className="space-y-2">
              {STARTER_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => void onSendMessage(prompt, attachedHighlight ? [attachedHighlight.id] : [])}
                  className="w-full text-left px-3 py-2 text-xs text-ink bg-sheet border border-hairline rounded-lg hover:border-cobalt transition-colors leading-relaxed"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => {
          const isUser = msg.role === 'user';
          const traces = msg.traces ?? [];
          const hasTraces = traces.length > 0;
          const isExpanded = expandedTraceMsgIds.has(msg.id);
          const mutationTrace = traces.find((t) => t.afterVersion != null && t.beforeVersion != null);

          return (
            <div key={msg.id} className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
              <div
                className={`max-w-[92%] rounded-xl px-3.5 py-2.5 text-[13.5px] leading-relaxed ${
                  isUser
                    ? 'bg-cobalt text-white'
                    : 'bg-sheet border border-hairline text-ink'
                }`}
              >
                {isUser ? (
                  <p className="whitespace-pre-wrap">{msg.content}</p>
                ) : (
                  <div className="text-ink space-y-2 [&>p]:leading-relaxed [&>ul]:list-disc [&>ul]:pl-4 [&>ul]:space-y-1 [&>ol]:list-decimal [&>ol]:pl-4 [&>ol]:space-y-1 [&>pre]:bg-paper [&>pre]:p-2 [&>pre]:rounded [&>pre]:overflow-x-auto [&>code]:font-mono [&>code]:text-xs">
                    <ReactMarkdown>{msg.content}</ReactMarkdown>
                  </div>
                )}
              </div>

              {!isUser && hasTraces && (
                <div className="mt-1.5 w-full max-w-[92%]">
                  <div className="flex items-center justify-between gap-2 text-[11px] text-ink-muted">
                    <button
                      type="button"
                      onClick={() => toggleTrace(msg.id)}
                      className="inline-flex items-center gap-1 hover:text-ink transition-colors"
                    >
                      {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                      <span>
                        {mutationTrace
                          ? `Revision v${mutationTrace.beforeVersion} → v${mutationTrace.afterVersion} · ${mutationTrace.toolName}`
                          : `${traces.length} tool trace(s)`}
                      </span>
                    </button>

                    {mutationTrace?.beforeVersion != null && (
                      <button
                        type="button"
                        onClick={() => void onUndoToBeforeVersion(mutationTrace.beforeVersion!)}
                        className="inline-flex items-center gap-1 text-cobalt hover:underline font-medium whitespace-nowrap shrink-0"
                      >
                        <Undo2 className="w-3 h-3" />
                        Undo
                      </button>
                    )}
                  </div>

                  {isExpanded && (
                    <div className="mt-1.5 p-2.5 bg-paper border border-hairline rounded-lg space-y-1.5 text-[11px] font-mono text-ink-muted">
                      {traces.map((t) => (
                        <div key={t.id} className="space-y-0.5">
                          <div className="flex items-center justify-between text-ink">
                            <span>{t.toolName}</span>
                            <span className="tabular-nums">{t.durationMs}ms · {t.status}</span>
                          </div>
                          <p className="text-[10px] break-all">{t.resultSummary}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {isStreaming && (
          <div className="flex flex-col items-start space-y-2">
            {streamingTraces.length > 0 && (
              <div className="text-[11px] font-mono text-cobalt">
                Applied {streamingTraces.map((t) => t.toolName).join(', ')}...
              </div>
            )}
            <div className="max-w-[92%] rounded-xl px-3.5 py-2.5 text-[13.5px] leading-relaxed bg-sheet border border-hairline text-ink">
              {streamingText ? (
                <div className="prose prose-sm max-w-none prose-p:my-1.5 text-ink">
                  <ReactMarkdown>{streamingText}</ReactMarkdown>
                </div>
              ) : (
                <span className="inline-flex items-center gap-2 text-xs text-ink-muted">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Thinking & checking document...
                </span>
              )}
            </div>
          </div>
        )}

        {chatError && (
          <div role="alert" className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-900">
            {chatError}
          </div>
        )}

        <div ref={scrollEndRef} />
      </div>

      <form onSubmit={handleSubmit} className="p-3 border-t border-hairline bg-paper space-y-2">
        {attachedHighlight && (
          <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 bg-stone-panel border border-hairline rounded-lg text-[11px]">
            <span className="truncate text-ink">
              Context: Page {attachedHighlight.page} · “{attachedHighlight.quoteAnchor}”
            </span>
            <button
              type="button"
              onClick={onClearAttachedHighlight}
              aria-label="Remove highlight context"
              className="text-ink-muted hover:text-ink shrink-0"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        <div className="flex items-end gap-2">
          <textarea
            rows={2}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSubmit(e);
              }
            }}
            placeholder="Ask a question or request a revision..."
            className="flex-1 px-3 py-2 text-sm bg-sheet border border-hairline rounded-xl text-ink placeholder:text-ink-muted focus:outline-none focus:border-cobalt resize-none"
          />
          <button
            type="submit"
            disabled={!input.trim() || isStreaming}
            aria-label="Send message"
            className="p-2.5 bg-cobalt text-white rounded-xl hover:bg-cobalt-hover disabled:opacity-40 transition-colors shrink-0"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </form>
    </aside>
  );
};
