import { Component, useState, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  /** What to show instead of the crashed part; `retry` renders the children again. */
  fallback: (error: Error, retry: () => void) => ReactNode
  children: ReactNode
  /**
   * A crash is cleared when this changes (Home's page): moving on recovers, without
   * remounting a healthy tree (which would drop the keyboard focus).
   */
  resetKey?: unknown
}

/**
 * Keeps one crashed part (a repository tab, Home, the whole app) from blanking the window:
 * React unmounts everything above an uncaught render error up to the nearest boundary.
 */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Still reported: the end-to-end tests fail on console errors.
    console.error('GitDesk view crashed:', error, info.componentStack)
  }

  retry = (): void => this.setState({ error: null })

  componentDidUpdate(previous: Props): void {
    if (this.state.error && !Object.is(previous.resetKey, this.props.resetKey)) this.retry()
  }

  render(): ReactNode {
    return this.state.error
      ? this.props.fallback(this.state.error, this.retry)
      : this.props.children
  }
}

/** The fallback's body: what broke, the error, and the ways out. */
export function CrashNotice({
  title,
  error,
  children
}: {
  title: string
  error: Error
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="empty-state" role="alert">
      <p>
        <strong>{title}</strong>
      </p>
      <p className="error-text" style={{ whiteSpace: 'pre-wrap', userSelect: 'text' }}>
        {error.message || String(error)}
      </p>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>{children}</div>
    </div>
  )
}

/** Last resort around the whole app (the tab bar itself crashed). Open tabs stay unless closed here. */
export function RootBoundary({ children }: { children: ReactNode }): React.JSX.Element {
  const [generation, setGeneration] = useState(0)
  const restart = (): void => setGeneration((g) => g + 1)
  return (
    <ErrorBoundary
      key={generation}
      fallback={(error) => (
        <div className="app">
          <CrashNotice title="GitDesk ran into a problem." error={error}>
            <button
              className="btn primary"
              onClick={() => {
                // A tab that crashes on every start would otherwise come back each time.
                void Promise.resolve(window.api.setTabs([], null))
                  .catch(() => {})
                  .then(restart)
              }}
            >
              Close all tabs and go Home
            </button>
            <button className="btn" onClick={restart}>
              Try again
            </button>
          </CrashNotice>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  )
}
