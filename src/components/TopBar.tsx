/** Top navigation bar switching between Workspace, Memory, Diagnostics, and New Reading. */
import React from 'react';
import { Plus } from 'lucide-react';

export type ActiveRoute = 'workspace' | 'memory' | 'diagnostics';

interface TopBarProps {
  activeRoute: ActiveRoute;
  onNavigate: (route: ActiveRoute) => void;
  onNewReading: () => void;
}

/** Top navigation bar switching between Workspace, Memory, Diagnostics, and New Reading. */
export const TopBar: React.FC<TopBarProps> = ({ activeRoute, onNavigate, onNewReading }) => {
  const navItems: Array<{ id: ActiveRoute; label: string }> = [
    { id: 'workspace', label: 'Workspace' },
    { id: 'memory', label: 'Memory' },
    { id: 'diagnostics', label: 'Diagnostics' },
  ];

  return (
    <header className="h-14 flex items-center justify-between gap-8 px-6 bg-paper border-b border-hairline shrink-0">
      <button
        type="button"
        onClick={() => onNavigate('workspace')}
        className="font-display text-xl font-semibold tracking-tight text-ink whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt rounded"
      >
        FolioBrief
      </button>

      <nav className="flex items-center gap-7" aria-label="Primary navigation">
        {navItems.map((item) => {
          const isActive = activeRoute === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onNavigate(item.id)}
              className={`relative py-1 text-sm font-medium transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt rounded ${
                isActive ? 'text-ink' : 'text-ink-muted hover:text-ink'
              }`}
            >
              {item.label}
              {isActive && (
                <span className="absolute inset-x-0 -bottom-[15px] h-[2px] bg-cobalt" aria-hidden="true" />
              )}
            </button>
          );
        })}
      </nav>

      <div className="flex items-center shrink-0">
        <button
          type="button"
          onClick={onNewReading}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-cobalt rounded-lg hover:bg-cobalt-hover transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-cobalt"
        >
          <Plus className="w-3.5 h-3.5" />
          New Reading
        </button>
      </div>
    </header>
  );
};
