/** Renders the structured Executive Brief view (summary, insights, improvements, and open questions). */
import React from 'react';
import type { AnalysisVersion } from '../shared/types.ts';

interface BriefCanvasProps {
  title: string;
  sourceDomain: string | null;
  pageCount: number;
  version: AnalysisVersion;
  relatedDocuments: Array<{
    id: string;
    title: string;
    sourceDomain: string | null;
    similarity: number;
    createdAt: string;
  }>;
  onSelectDocument: (id: string) => void;
}

/** Renders the structured Executive Brief sheet and clickable related prior readings. */
export const BriefCanvas: React.FC<BriefCanvasProps> = ({
  title,
  sourceDomain,
  pageCount,
  version,
  relatedDocuments,
  onSelectDocument,
}) => {
  const generatedDate = new Date(version.createdAt).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  return (
    <div className="flex-1 overflow-y-auto px-8 py-8 bg-paper">
      <article className="max-w-3xl mx-auto bg-sheet border border-hairline rounded-2xl p-8 md:p-10 space-y-8">
        <header className="pb-6 border-b border-hairline space-y-3">
          <div className="flex items-center flex-wrap gap-x-2 gap-y-1 text-xs text-ink-muted tabular-nums">
            <span className="font-medium text-cobalt">Executive Brief</span>
            <span aria-hidden="true">·</span>
            <span>Revision v{version.versionNumber}</span>
            <span aria-hidden="true">·</span>
            <span>{sourceDomain ?? 'PDF Upload'}</span>
            <span aria-hidden="true">·</span>
            <span>{pageCount} pages</span>
            <span aria-hidden="true">·</span>
            <span>{generatedDate}</span>
          </div>

          <h2 className="font-display text-2xl md:text-3xl font-semibold text-ink leading-snug">
            {title}
          </h2>

          <p className="text-xs text-ink-muted">{version.revisionReason}</p>
        </header>

        <section className="space-y-3">
          <h3 className="font-display text-lg font-semibold text-ink">Executive Summary</h3>
          <p className="text-[15px] text-ink leading-[1.7]">{version.summary}</p>
        </section>

        <section className="pt-6 border-t border-hairline space-y-3">
          <h3 className="font-display text-lg font-semibold text-ink">Key Insights</h3>
          <ul className="space-y-2.5 list-disc pl-5 text-[15px] text-ink leading-[1.65]">
            {version.keyInsights.map((item, idx) => (
              <li key={idx}>{item}</li>
            ))}
          </ul>
        </section>

        <section className="pt-6 border-t border-hairline space-y-3">
          <h3 className="font-display text-lg font-semibold text-ink">
            Novel Improvements & Contributions
          </h3>
          <ul className="space-y-2.5 list-disc pl-5 text-[15px] text-ink leading-[1.65]">
            {version.improvements.map((item, idx) => (
              <li key={idx}>{item}</li>
            ))}
          </ul>
        </section>

        <section className="pt-6 border-t border-hairline space-y-3">
          <h3 className="font-display text-lg font-semibold text-ink">Open-Ended Questions</h3>
          <ul className="space-y-2.5 list-disc pl-5 text-[15px] text-ink leading-[1.65]">
            {version.openQuestions.map((item, idx) => (
              <li key={idx}>{item}</li>
            ))}
          </ul>
        </section>

        {relatedDocuments.length > 0 && (
          <section className="pt-6 border-t border-hairline space-y-3">
            <h3 className="font-display text-base font-semibold text-ink">
              Related Prior Readings in Your Memory
            </h3>
            <div className="divide-y divide-hairline border border-hairline rounded-xl overflow-hidden">
              {relatedDocuments.map((rel) => (
                <button
                  key={rel.id}
                  type="button"
                  onClick={() => onSelectDocument(rel.id)}
                  className="w-full px-4 py-3 text-left bg-paper/50 hover:bg-stone-panel/60 transition-colors flex items-center justify-between gap-4"
                >
                  <span className="text-sm font-medium text-ink truncate">{rel.title}</span>
                  <span className="text-xs text-ink-muted font-mono tabular-nums whitespace-nowrap shrink-0">
                    {rel.sourceDomain ?? 'PDF'} · {Math.round(rel.similarity * 100)}% match
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
      </article>
    </div>
  );
};
