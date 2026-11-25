/** Diagnostics dashboard showing SQLite health, disk usage, temp-file cleanup, logs, and tool traces. */
import React, { useEffect, useState } from 'react';
import { Download, RefreshCw, Sparkles } from 'lucide-react';
import type { DiagnosticsSnapshot } from '../shared/types.ts';
import { apiClient } from '../api/client.ts';

/** Formats a byte count into human-readable B/KB/MB units. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Displays SQLite health, disk usage, temp-file cleanup, debug bundle export, tool traces, and logs. */
export const DiagnosticsView: React.FC = () => {
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [exportingBundle, setExportingBundle] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const data = await apiClient.getDiagnostics();
      setSnapshot(data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const handleCleanup = async () => {
    const res = await apiClient.cleanOrphanTempFiles();
    setStatusMsg(`Removed ${res.removed} orphan temporary file(s).`);
    await refresh();
  };

  const handleExportBundle = async () => {
    if (exportingBundle) return;
    setExportingBundle(true);
    try {
      const dateSlug = new Date().toISOString().slice(0, 10);
      await apiClient.downloadFile('/api/diagnostics/bundle', `foliobrief-debug-${dateSlug}.json`);
    } catch (err) {
      setStatusMsg((err as Error).message || 'Failed to export debug bundle.');
    } finally {
      setExportingBundle(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto px-8 py-8 bg-paper">
      <div className="max-w-4xl mx-auto space-y-8">
        <header className="flex flex-wrap items-center justify-between gap-4 pb-6 border-b border-hairline">
          <div className="space-y-1">
            <h1 className="font-display text-3xl font-semibold text-ink">
              Diagnostics & Maintenance
            </h1>
            <p className="text-sm text-ink-muted">
              Inspect SQLite WAL health, PDF disk storage, tool-calling traces, and redacted logs.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refresh()}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-ink bg-sheet border border-hairline rounded-lg hover:bg-stone-panel transition-colors whitespace-nowrap shrink-0"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Refresh
            </button>
            <button
              type="button"
              onClick={() => void handleCleanup()}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-ink bg-sheet border border-hairline rounded-lg hover:bg-stone-panel transition-colors whitespace-nowrap shrink-0"
            >
              <Sparkles className="w-3.5 h-3.5" />
              Clean Temp Files
            </button>
            <button
              type="button"
              disabled={exportingBundle}
              onClick={() => void handleExportBundle()}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-cobalt rounded-lg hover:bg-cobalt-hover disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              {exportingBundle ? 'Exporting...' : 'Export Debug Bundle'}
            </button>
          </div>
        </header>

        {statusMsg && (
          <div className="p-3 bg-stone-panel border border-hairline rounded-lg text-xs text-ink">
            {statusMsg}
          </div>
        )}

        {loading || !snapshot ? (
          <div className="h-40 bg-sheet border border-hairline rounded-2xl animate-pulse" />
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="p-4 bg-sheet border border-hairline rounded-xl">
                <p className="text-xs text-ink-muted">SQLite Integrity</p>
                <p className="mt-1 font-mono text-base font-medium text-ink uppercase">
                  {snapshot.sqliteIntegrity} · {snapshot.sqliteWalMode}
                </p>
              </div>
              <div className="p-4 bg-sheet border border-hairline rounded-xl">
                <p className="text-xs text-ink-muted">PDF Storage on Disk</p>
                <p className="mt-1 font-mono text-base font-medium text-ink tabular-nums">
                  {formatBytes(snapshot.pdfStorageBytes)} ({snapshot.pdfFileCount} files)
                </p>
              </div>
              <div className="p-4 bg-sheet border border-hairline rounded-xl">
                <p className="text-xs text-ink-muted">Indexed Readings</p>
                <p className="mt-1 font-mono text-base font-medium text-ink tabular-nums">
                  {snapshot.documentCount}
                </p>
              </div>
              <div className="p-4 bg-sheet border border-hairline rounded-xl">
                <p className="text-xs text-ink-muted">Orphan Temp / Interrupted</p>
                <p className="mt-1 font-mono text-base font-medium text-ink tabular-nums">
                  {snapshot.orphanTempFiles} / {snapshot.interruptedJobs}
                </p>
              </div>
            </div>

            <section className="space-y-3">
              <h2 className="font-display text-lg font-semibold text-ink">
                Recent Tool-Calling Traces ({snapshot.recentTraces.length})
              </h2>
              <div className="bg-sheet border border-hairline rounded-xl overflow-hidden divide-y divide-hairline">
                {snapshot.recentTraces.length === 0 ? (
                  <p className="p-4 text-xs text-ink-muted">No agent tool calls recorded yet.</p>
                ) : (
                  snapshot.recentTraces.slice(0, 15).map((t) => (
                    <div key={t.id} className="px-4 py-3 text-xs flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <span className="font-mono font-medium text-ink">{t.toolName}</span>
                        <span className="mx-2 text-ink-muted">·</span>
                        <span className="text-ink-muted">{t.resultSummary}</span>
                      </div>
                      <span className="font-mono text-ink-muted tabular-nums whitespace-nowrap shrink-0">
                        {t.status} · {t.durationMs}ms
                      </span>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="space-y-3">
              <h2 className="font-display text-lg font-semibold text-ink">
                Recent Redacted Application Logs
              </h2>
              <div className="bg-sheet border border-hairline rounded-xl overflow-hidden divide-y divide-hairline font-mono text-[11px]">
                {snapshot.recentLogs.length === 0 ? (
                  <p className="p-4 text-ink-muted font-sans text-xs">No log entries in current session.</p>
                ) : (
                  snapshot.recentLogs.slice(0, 20).map((log, idx) => (
                    <div key={idx} className="px-4 py-2.5 flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <span className="text-ink-muted mr-2">{log.timestamp.slice(11, 19)}</span>
                        <span
                          className={`mr-2 uppercase font-medium ${
                            log.level === 'error'
                              ? 'text-red-700'
                              : log.level === 'warn'
                                ? 'text-amber-700'
                                : 'text-cobalt'
                          }`}
                        >
                          {log.level}
                        </span>
                        <span className="text-ink">[{log.module}] {log.message}</span>
                      </div>
                      {log.requestId && (
                        <span className="text-ink-muted shrink-0">{log.requestId}</span>
                      )}
                    </div>
                  ))
                )}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
};
