/** Zero-state ingestion workspace supporting PDF drag-and-drop, article URL fetch, and pasted text. */
import React, { useRef, useState } from 'react';
import { FileUp, Link2, FileText, ArrowRight, Loader2 } from 'lucide-react';

interface IngestionViewProps {
  onUploadPdf: (file: File) => Promise<void>;
  onIngestUrl: (url: string) => Promise<void>;
  onIngestText: (input: { title: string; text: string; sourceUrl?: string }) => Promise<void>;
}

/** Ingestion landing workspace supporting URL synthesis, PDF drag-and-drop, and pasted-text fallback. */
export const IngestionView: React.FC<IngestionViewProps> = ({
  onUploadPdf,
  onIngestUrl,
  onIngestText,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [urlInput, setUrlInput] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const [submitting, setSubmitting] = useState<'pdf' | 'url' | 'text' | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showTextFallback, setShowTextFallback] = useState(false);
  const [textTitle, setTextTitle] = useState('');
  const [textBody, setTextBody] = useState('');

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
      setErrorMsg('Please choose a valid .pdf file.');
      return;
    }
    setErrorMsg(null);
    setSubmitting('pdf');
    try {
      await onUploadPdf(file);
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setSubmitting(null);
    }
  };

  const handleUrlSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = urlInput.trim();
    if (!trimmed) {
      setErrorMsg('Enter an article or paper URL to synthesize.');
      return;
    }
    setErrorMsg(null);
    setSubmitting('url');
    try {
      await onIngestUrl(trimmed);
      setUrlInput('');
    } catch (err) {
      setErrorMsg((err as Error).message);
      setShowTextFallback(true);
    } finally {
      setSubmitting(null);
    }
  };

  const handleTextSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!textTitle.trim() || textBody.trim().length < 60) {
      setErrorMsg('Enter a title and at least 60 characters of article content.');
      return;
    }
    setErrorMsg(null);
    setSubmitting('text');
    try {
      await onIngestText({
        title: textTitle.trim(),
        text: textBody.trim(),
        sourceUrl: urlInput.trim() || undefined,
      });
      setTextTitle('');
      setTextBody('');
      setShowTextFallback(false);
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto px-8 py-12 flex flex-col items-center justify-center">
      <div className="w-full max-w-2xl space-y-8">
        <div className="space-y-3">
          <p className="text-xs font-medium text-cobalt">Personal Research & Reading Studio</p>
          <h1 className="font-display text-4xl font-semibold tracking-tight text-ink leading-tight">
            Read papers and technical articles with precision.
          </h1>
          <p className="text-base text-ink-muted leading-relaxed">
            Upload a PDF or paste an article link to generate an Executive Brief PDF, concise in-article highlights with margin notes, and a grounded chat workspace that learns your reading style.
          </p>
        </div>

        {errorMsg && (
          <div
            role="alert"
            className="p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-900 leading-relaxed"
          >
            {errorMsg}
          </div>
        )}

        {/* URL Ingestion Bar */}
        <form onSubmit={handleUrlSubmit} className="space-y-2">
          <label htmlFor="article-url-input" className="block text-xs font-medium text-ink">
            Synthesize from Article or Report URL
          </label>
          <div className="flex items-stretch gap-3">
            <div className="relative flex-1">
              <Link2 className="w-4 h-4 text-ink-muted absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                id="article-url-input"
                type="url"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="https://arxiv.org/html/... or engineering blog URL"
                className="w-full pl-10 pr-4 py-3 text-sm bg-sheet border border-hairline rounded-xl text-ink placeholder:text-ink-muted focus:outline-none focus:border-cobalt"
              />
            </div>
            <button
              type="submit"
              disabled={submitting !== null}
              className="inline-flex items-center gap-2 px-5 py-3 text-sm font-medium text-white bg-cobalt rounded-xl hover:bg-cobalt-hover disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              {submitting === 'url' ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <ArrowRight className="w-4 h-4" />
              )}
              {submitting === 'url' ? 'Rendering PDF...' : 'Fetch & Analyze'}
            </button>
          </div>
        </form>

        {/* PDF Dropzone */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragActive(false);
            void handleFile(e.dataTransfer.files?.[0]);
          }}
          className={`p-8 bg-sheet border border-dashed rounded-2xl text-center transition-colors ${
            dragActive ? 'border-cobalt bg-stone-panel/60' : 'border-hairline hover:border-ink-muted'
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            onChange={(e) => {
              void handleFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <FileUp className="w-7 h-7 text-cobalt mx-auto mb-3" />
          <p className="text-sm font-medium text-ink mb-1">
            Drop a research paper or report PDF here
          </p>
          <p className="text-xs text-ink-muted mb-4">
            Up to 30 MB · Stored privately in your local FolioBrief library
          </p>
          <button
            type="button"
            disabled={submitting !== null}
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-ink bg-stone-panel border border-hairline rounded-lg hover:bg-paper disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
          >
            {submitting === 'pdf' ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Uploading PDF...
              </>
            ) : (
              'Choose PDF File'
            )}
          </button>
        </div>

        {/* Graceful Fallback for Paywalled / Blocked URLs */}
        <div className="pt-2 border-t border-hairline">
          <button
            type="button"
            onClick={() => setShowTextFallback((v) => !v)}
            className="inline-flex items-center gap-2 text-xs font-medium text-ink-muted hover:text-ink transition-colors"
          >
            <FileText className="w-3.5 h-3.5" />
            {showTextFallback ? 'Hide pasted text fallback' : 'Site blocked or paywalled? Paste article text directly'}
          </button>

          {showTextFallback && (
            <form onSubmit={handleTextSubmit} className="mt-4 space-y-3 p-5 bg-sheet border border-hairline rounded-xl">
              <input
                type="text"
                value={textTitle}
                onChange={(e) => setTextTitle(e.target.value)}
                placeholder="Article or Paper Title"
                className="w-full px-3.5 py-2 text-sm bg-paper border border-hairline rounded-lg text-ink focus:outline-none focus:border-cobalt"
              />
              <textarea
                rows={5}
                value={textBody}
                onChange={(e) => setTextBody(e.target.value)}
                placeholder="Paste the full article prose here. FolioBrief will format it into a clean Source PDF and analyze it..."
                className="w-full px-3.5 py-2.5 text-sm bg-paper border border-hairline rounded-lg text-ink focus:outline-none focus:border-cobalt"
              />
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={submitting !== null}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-cobalt rounded-lg hover:bg-cobalt-hover disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
                >
                  {submitting === 'text' ? 'Generating PDF...' : 'Render PDF & Analyze'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
