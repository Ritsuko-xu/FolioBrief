/** Client-side `pdfjs-dist` page renderer with responsive fit-width scaling, highlight overlays, and margin cards. */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, MessageSquarePlus, ZoomIn, ZoomOut } from 'lucide-react';
import type { HighlightCategory, HighlightItem } from '../shared/types.ts';

interface PdfAnnotatorCanvasProps {
  documentId: string;
  highlights: HighlightItem[];
  activeHighlightId: string | null;
  compact?: boolean;
  onSelectHighlight: (id: string) => void;
  onAskAboutHighlight: (highlight: HighlightItem) => void;
}

interface RenderedPageMeta {
  pageNumber: number;
  width: number;
  height: number;
}

interface PdfPageLike {
  getViewport: (opts: { scale: number }) => { width: number; height: number };
  render: (opts: {
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
    canvas: HTMLCanvasElement;
  }) => { promise: Promise<void>; cancel?: () => void };
}

interface PdfDocumentLike {
  numPages: number;
  getPage: (n: number) => Promise<PdfPageLike>;
  cleanup?: () => Promise<void>;
}

/** Maps highlight categories to Tailwind overlay and margin-card styles. */
function getHighlightStyle(category: HighlightCategory, isActive: boolean) {
  if (category === 'improvement') {
    return {
      overlay: isActive ? 'bg-emerald-300/55 ring-2 ring-emerald-700/60' : 'bg-emerald-200/45 hover:bg-emerald-300/55',
      label: 'Improvement',
      labelColor: 'text-emerald-900',
      cardBg: isActive ? 'bg-emerald-50/90 border-emerald-400' : 'bg-sheet border-hairline hover:border-ink-muted',
    };
  }
  if (category === 'question') {
    return {
      overlay: isActive ? 'bg-indigo-300/55 ring-2 ring-indigo-700/60' : 'bg-indigo-200/45 hover:bg-indigo-300/55',
      label: 'Open Question',
      labelColor: 'text-indigo-900',
      cardBg: isActive ? 'bg-indigo-50/90 border-indigo-400' : 'bg-sheet border-hairline hover:border-ink-muted',
    };
  }
  return {
    overlay: isActive ? 'bg-amber-300/55 ring-2 ring-amber-700/60' : 'bg-amber-200/45 hover:bg-amber-300/55',
    label: 'Key Claim',
    labelColor: 'text-amber-900',
    cardBg: isActive ? 'bg-amber-50/90 border-amber-400' : 'bg-sheet border-hairline hover:border-ink-muted',
  };
}

/** Renders paginated Source PDF canvases with fit-to-width responsiveness, interactive highlights, and margin cards. */
export const PdfAnnotatorCanvas: React.FC<PdfAnnotatorCanvasProps> = ({
  documentId,
  highlights,
  activeHighlightId,
  compact = false,
  onSelectHighlight,
  onAskAboutHighlight,
}) => {
  const [fitToWidth, setFitToWidth] = useState(true);
  const [manualScale, setManualScale] = useState(compact ? 0.72 : 1.0);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [showMarginRail, setShowMarginRail] = useState(!compact);
  const [pageMetas, setPageMetas] = useState<RenderedPageMeta[]>([]);
  const [loadedPdf, setLoadedPdf] = useState<PdfDocumentLike | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const pageContainerRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  useEffect(() => {
    setShowMarginRail(!compact);
    setFitToWidth(true);
  }, [compact, documentId]);

  // Measure the scrollable PDF viewport width so pages fit cleanly inside Annotated Source and Split View
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const updateWidth = () => {
      setViewportWidth(el.clientWidth);
    };
    updateWidth();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateWidth);
      return () => window.removeEventListener('resize', updateWidth);
    }

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setViewportWidth(Math.round(entry.contentRect.width));
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [showMarginRail, loadError]);

  const effectiveScale = useMemo(() => {
    if (!fitToWidth) return manualScale;
    if (viewportWidth > 0 && pageMetas.length > 0) {
      const maxPageWidth = Math.max(...pageMetas.map((m) => m.width));
      const available = Math.max(240, viewportWidth - 44);
      return Number(Math.max(0.45, Math.min(1.25, available / maxPageWidth)).toFixed(3));
    }
    return compact ? 0.72 : 1.0;
  }, [fitToWidth, manualScale, viewportWidth, pageMetas, compact]);

  // Load PDF bytes & page dimensions once per documentId (no re-fetch on zoom or pane resize)
  useEffect(() => {
    let cancelled = false;
    let activePdf: PdfDocumentLike | null = null;

    async function loadPdfDocument() {
      setLoading(true);
      setLoadError(null);
      setLoadedPdf(null);
      setPageMetas([]);
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          'pdfjs-dist/build/pdf.worker.min.mjs',
          import.meta.url
        ).toString();

        const res = await fetch(`/api/documents/${encodeURIComponent(documentId)}/pdf/source`);
        if (!res.ok) {
          throw new Error(`Unable to load PDF (${res.status})`);
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        const task = pdfjs.getDocument({ data: bytes });
        const pdf = (await task.promise) as unknown as PdfDocumentLike;
        activePdf = pdf;

        if (cancelled) {
          if (typeof pdf.cleanup === 'function') void pdf.cleanup();
          return;
        }

        const metas: RenderedPageMeta[] = [];
        for (let p = 1; p <= pdf.numPages; p += 1) {
          const page = await pdf.getPage(p);
          const vp = page.getViewport({ scale: 1.0 });
          metas.push({ pageNumber: p, width: vp.width, height: vp.height });
        }
        if (cancelled) return;

        setPageMetas(metas);
        setLoadedPdf(pdf);
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setLoadError((err as Error).message || 'Failed to render PDF.');
          setLoading(false);
        }
      }
    }

    void loadPdfDocument();

    return () => {
      cancelled = true;
      if (activePdf && typeof activePdf.cleanup === 'function') {
        void activePdf.cleanup();
      }
    };
  }, [documentId]);

  // Render pages onto canvases whenever scale or loadedPdf updates (canceling any prior render cleanly)
  useEffect(() => {
    if (!loadedPdf || pageMetas.length === 0) return;
    let cancelled = false;
    let activeRenderTask: { promise: Promise<void>; cancel?: () => void } | null = null;

    const timer = setTimeout(() => {
      void (async () => {
        const dpr = window.devicePixelRatio || 1;
        for (let p = 1; p <= loadedPdf.numPages; p += 1) {
          if (cancelled) break;
          const canvas = canvasRefs.current.get(p);
          if (!canvas) continue;

          try {
            const page = await loadedPdf.getPage(p);
            if (cancelled) break;
            const viewport = page.getViewport({ scale: effectiveScale });
            canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
            canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
            canvas.style.width = `${viewport.width}px`;
            canvas.style.height = `${viewport.height}px`;

            const ctx = canvas.getContext('2d');
            if (!ctx) continue;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

            activeRenderTask = page.render({ canvasContext: ctx, viewport, canvas });
            await activeRenderTask.promise;
            activeRenderTask = null;
          } catch (err) {
            if (cancelled || (err as Error)?.name === 'RenderingCancelledException') {
              break;
            }
          }
        }
      })();
    }, 35);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (activeRenderTask && typeof activeRenderTask.cancel === 'function') {
        activeRenderTask.cancel();
      }
    };
  }, [loadedPdf, pageMetas, effectiveScale]);

  const adjustManualZoom = (delta: number) => {
    const next = Math.min(2.0, Math.max(0.45, Number((effectiveScale + delta).toFixed(2))));
    setFitToWidth(false);
    setManualScale(next);
  };

  const jumpToHighlight = (hl: HighlightItem) => {
    onSelectHighlight(hl.id);
    const pageEl = pageContainerRefs.current.get(hl.page);
    if (pageEl) {
      pageEl.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    }
  };

  if (loadError) {
    return (
      <div className="p-8 text-center text-sm text-red-800 bg-red-50 border border-red-200 rounded-xl m-4">
        {loadError}
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-w-0 min-h-0 overflow-hidden">
      {/* Sticky Toolbar + Scrollable PDF Canvas Column */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-stone-panel/45">
        <div className="px-4 py-2.5 bg-paper/90 border-b border-hairline flex items-center justify-between gap-2 shrink-0">
          <span className="text-xs text-ink-muted tabular-nums truncate">
            {loading ? 'Rendering pages...' : `${pageMetas.length} pages · ${highlights.length} highlights`}
          </span>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => adjustManualZoom(-0.12)}
              aria-label="Zoom out"
              className="p-1.5 text-ink-muted hover:text-ink bg-sheet border border-hairline rounded-md transition-colors"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <span className="text-xs font-mono text-ink-muted w-11 text-center tabular-nums">
              {Math.round(effectiveScale * 100)}%
            </span>
            <button
              type="button"
              onClick={() => adjustManualZoom(0.12)}
              aria-label="Zoom in"
              className="p-1.5 text-ink-muted hover:text-ink bg-sheet border border-hairline rounded-md transition-colors"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setFitToWidth(true)}
              title="Fit page to pane width"
              className={`ml-1 inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium border rounded-md transition-colors whitespace-nowrap shrink-0 ${
                fitToWidth
                  ? 'text-cobalt bg-cobalt/8 border-cobalt/35'
                  : 'text-ink-muted hover:text-ink bg-sheet border-hairline'
              }`}
            >
              <Maximize2 className="w-3 h-3" />
              Fit
            </button>
            <button
              type="button"
              onClick={() => setShowMarginRail((v) => !v)}
              className="ml-1 px-2.5 py-1 text-xs font-medium text-ink bg-sheet border border-hairline rounded-md hover:bg-paper transition-colors whitespace-nowrap shrink-0"
            >
              {showMarginRail ? 'Hide Notes' : `Notes (${highlights.length})`}
            </button>
          </div>
        </div>

        {/* 2D scrollable viewport using w-fit min-w-full so horizontal zoom never clips the left margin */}
        <div ref={viewportRef} className="flex-1 min-w-0 min-h-0 overflow-auto">
          <div className="w-fit min-w-full px-5 py-5 flex flex-col items-center gap-5">
            {loading ? (
              <div className="w-full max-w-[600px] h-[720px] bg-sheet border border-hairline rounded-lg animate-pulse" />
            ) : (
              pageMetas.map((meta) => {
                const pageHighlights = highlights.filter((h) => h.page === meta.pageNumber);
                return (
                  <div
                    key={meta.pageNumber}
                    ref={(el) => {
                      if (el) pageContainerRefs.current.set(meta.pageNumber, el);
                      else pageContainerRefs.current.delete(meta.pageNumber);
                    }}
                    className="relative bg-sheet border border-hairline shadow-sm rounded-sm overflow-hidden shrink-0"
                    style={{
                      width: `${meta.width * effectiveScale}px`,
                      height: `${meta.height * effectiveScale}px`,
                    }}
                  >
                    <canvas
                      ref={(el) => {
                        if (el) canvasRefs.current.set(meta.pageNumber, el);
                        else canvasRefs.current.delete(meta.pageNumber);
                      }}
                      className="block"
                    />

                    {/* Highlight Rect Overlays */}
                    {pageHighlights.map((hl) => {
                      const style = getHighlightStyle(hl.category, activeHighlightId === hl.id);
                      return (hl.rects ?? []).map((rect, idx) => {
                        const topPx = (meta.height - rect.y - rect.height) * effectiveScale;
                        const leftPx = rect.x * effectiveScale;
                        const widthPx = Math.max(8, rect.width * effectiveScale);
                        const heightPx = Math.max(10, rect.height * effectiveScale);

                        return (
                          <button
                            key={`${hl.id}-${idx}`}
                            type="button"
                            onClick={() => onSelectHighlight(hl.id)}
                            title={`${style.label}: ${hl.comment}`}
                            aria-label={`Highlight: ${hl.quoteAnchor}`}
                            className={`absolute rounded-[2px] transition-colors cursor-pointer ${style.overlay}`}
                            style={{
                              left: `${leftPx}px`,
                              top: `${topPx}px`,
                              width: `${widthPx}px`,
                              height: `${heightPx}px`,
                            }}
                          />
                        );
                      });
                    })}

                    <span className="absolute bottom-2 right-3 text-[10px] font-mono text-ink-muted/70 tabular-nums pointer-events-none">
                      p.{meta.pageNumber}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* Synchronized Margin Comments Rail */}
      {showMarginRail && (
        <div
          className={`${compact ? 'w-56' : 'w-68'} border-l border-hairline bg-paper overflow-y-auto p-4 space-y-3 shrink-0`}
        >
          <div className="pb-2 border-b border-hairline">
            <h3 className="font-display text-sm font-semibold text-ink">Margin Notes</h3>
            <p className="text-[11px] text-ink-muted mt-0.5 tabular-nums">
              {highlights.length} concise annotations
            </p>
          </div>

          {highlights.length === 0 ? (
            <p className="text-xs text-ink-muted leading-relaxed py-4">
              No highlights recorded yet. Ask the side chat to add concise highlights on key passages.
            </p>
          ) : (
            highlights.map((hl) => {
              const style = getHighlightStyle(hl.category, activeHighlightId === hl.id);
              return (
                <div
                  key={hl.id}
                  onClick={() => jumpToHighlight(hl)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      jumpToHighlight(hl);
                    }
                  }}
                  className={`p-3 rounded-xl border transition-colors cursor-pointer space-y-2 ${style.cardBg}`}
                >
                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    <span className={`font-semibold ${style.labelColor}`}>{style.label}</span>
                    <span className="font-mono text-ink-muted tabular-nums">Page {hl.page}</span>
                  </div>

                  <p className="text-xs italic text-ink-muted line-clamp-3 leading-relaxed">
                    “{hl.quoteAnchor}”
                  </p>

                  <p className="text-xs text-ink leading-relaxed">{hl.comment}</p>

                  <div className="pt-1 flex justify-end">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onAskAboutHighlight(hl);
                      }}
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-cobalt hover:underline whitespace-nowrap shrink-0"
                    >
                      <MessageSquarePlus className="w-3 h-3" />
                      Ask in chat
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
};
