/** UI panel for viewing, creating, and deleting learned `MemoryProfile` reading preferences. */
import React, { useEffect, useState } from 'react';
import { Trash2, Plus } from 'lucide-react';
import type { MemoryProfileRecord } from '../shared/types.ts';
import { apiClient } from '../api/client.ts';

/** Manages standing `MemoryProfile` reading preferences applied to future analyses. */
export const MemoryView: React.FC = () => {
  const [preferences, setPreferences] = useState<MemoryProfileRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [prefKey, setPrefKey] = useState('');
  const [rule, setRule] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const list = await apiClient.listMemory();
      setPreferences(list);
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prefKey.trim() || !rule.trim()) return;
    setErrorMsg(null);
    try {
      await apiClient.saveMemory(prefKey.trim(), rule.trim());
      setPrefKey('');
      setRule('');
      await load();
    } catch (err) {
      setErrorMsg((err as Error).message);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await apiClient.deleteMemory(id);
      setPreferences((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      setErrorMsg((err as Error).message);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto px-8 py-8 bg-paper">
      <div className="max-w-3xl mx-auto space-y-8">
        <header className="space-y-2 pb-6 border-b border-hairline">
          <h1 className="font-display text-3xl font-semibold text-ink">
            Reading Memory & Learned Preferences
          </h1>
          <p className="text-sm text-ink-muted leading-relaxed">
            FolioBrief distills standing preferences from your revision requests and chat feedback into MemoryProfile rules, improving future paper briefs without cluttering prompts with old chat logs.
          </p>
        </header>

        {errorMsg && (
          <div role="alert" className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-900">
            {errorMsg}
          </div>
        )}

        <form onSubmit={handleAdd} className="p-5 bg-sheet border border-hairline rounded-2xl space-y-3">
          <h2 className="font-display text-base font-semibold text-ink">Add Standing Reading Rule</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <input
              type="text"
              value={prefKey}
              onChange={(e) => setPrefKey(e.target.value)}
              placeholder="Rule key (e.g. latency_focus)"
              className="px-3 py-2 text-sm bg-paper border border-hairline rounded-lg text-ink focus:outline-none focus:border-cobalt"
            />
            <input
              type="text"
              value={rule}
              onChange={(e) => setRule(e.target.value)}
              placeholder="Rule (e.g. Highlight benchmark limitations and memory trade-offs)"
              className="md:col-span-2 px-3 py-2 text-sm bg-paper border border-hairline rounded-lg text-ink focus:outline-none focus:border-cobalt"
            />
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-cobalt rounded-lg hover:bg-cobalt-hover transition-colors whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              Save Rule
            </button>
          </div>
        </form>

        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold text-ink">
            Active Memory Rules ({preferences.length})
          </h2>

          {loading ? (
            <div className="h-24 bg-sheet border border-hairline rounded-xl animate-pulse" />
          ) : preferences.length === 0 ? (
            <div className="p-6 bg-sheet border border-hairline rounded-xl text-sm text-ink-muted">
              No reading rules recorded yet. Add one above or ask the side chat to remember a preference while reading.
            </div>
          ) : (
            <div className="divide-y divide-hairline bg-sheet border border-hairline rounded-2xl overflow-hidden">
              {preferences.map((pref) => (
                <div key={pref.id} className="p-4 flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-xs text-ink-muted tabular-nums">
                      <span className="font-mono font-medium text-ink">{pref.preferenceKey}</span>
                      <span aria-hidden="true">·</span>
                      <span>Confidence {Math.round(pref.confidence * 100)}%</span>
                    </div>
                    <p className="text-sm text-ink leading-relaxed">{pref.learnedRule}</p>
                    {pref.sourceEvidence && (
                      <p className="text-xs text-ink-muted">{pref.sourceEvidence}</p>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => void handleDelete(pref.id)}
                    aria-label={`Delete ${pref.preferenceKey}`}
                    className="p-1.5 text-ink-muted hover:text-red-700 rounded transition-colors shrink-0"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
