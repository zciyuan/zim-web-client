import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render errors so a single bad component cannot blank the whole app.
 * The fallback keeps the user signed in and offers a reload.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the detail in the console for local diagnosis; never rethrow.
    console.error('[zim] render error', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        role="alert"
        data-error-boundary
        className="flex h-full flex-col items-center justify-center gap-3 bg-slate-100 p-6 text-center dark:bg-slate-950"
      >
        <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">界面出现异常</p>
        <p className="max-w-[420px] break-words text-xs text-slate-500 dark:text-slate-400">
          {error.message || '未知错误'}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs dark:border-slate-700"
          >
            返回重试
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white"
          >
            重新加载
          </button>
        </div>
      </div>
    );
  }
}
