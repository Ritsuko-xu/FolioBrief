/** React error boundary isolating PDF/canvas render failures with a local retry reset. */
import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface ErrorBoundaryProps {
  fallbackTitle?: string;
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

/** Isolates rendering failures (such as PDF viewer errors) with an inline retry action. */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  /** Captures child render errors to switch into fallback recovery UI. */
  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, message: error.message || 'Unexpected rendering error' };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center p-8 text-center bg-sheet border border-hairline rounded-xl m-4">
          <AlertTriangle className="w-6 h-6 text-amber-700 mb-3" />
          <h3 className="text-base font-semibold text-ink mb-1">
            {this.props.fallbackTitle ?? 'Viewer encountered an issue'}
          </h3>
          <p className="text-sm text-ink-muted max-w-md mb-4">{this.state.message}</p>
          <button
            type="button"
            onClick={() => this.setState({ hasError: false, message: '' })}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-cobalt rounded-lg hover:bg-cobalt-hover transition-colors whitespace-nowrap shrink-0"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Retry View
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
