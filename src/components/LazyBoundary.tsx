import {
  Component,
  Suspense,
  lazy,
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode,
} from 'react';

/**
 * `React.lazy` for a named export, so split panels keep their named exports
 * (and their direct imports in tests) instead of growing default exports.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors React.lazy's own bound
export function lazyNamed<K extends string, M extends Record<K, ComponentType<any>>>(
  load: () => Promise<M>,
  name: K,
): LazyExoticComponent<M[K]> {
  return lazy(() => load().then((module) => ({ default: module[name] })));
}

interface ChunkErrorBoundaryProps {
  label: string;
  children: ReactNode;
}

interface ChunkErrorBoundaryState {
  error: Error | null;
}

/**
 * A lazy chunk that fails to load (offline, or a deploy replaced the hashed
 * file this tab still references) rejects inside React. Without a boundary
 * that unmounts the whole editor, so the failure is contained to the panel
 * and offers the one fix that works for a stale chunk: a reload.
 */
class ChunkErrorBoundary extends Component<ChunkErrorBoundaryProps, ChunkErrorBoundaryState> {
  override state: ChunkErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ChunkErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown): void {
    console.error(`[lazy] ${this.props.label} failed to load`, error);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="muted" role="alert">
        {this.props.label} failed to load ({this.state.error.message}).{' '}
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}

/** Suspense + load-failure boundary around a lazily loaded panel. */
export function LazyBoundary({
  label,
  fallback,
  children,
}: {
  /** Shown in the loading and failure states, e.g. "Captions". */
  label: string;
  /** Defaults to a muted "Loading …" line; pass `null` for modals. */
  fallback?: ReactNode;
  children: ReactNode;
}) {
  return (
    <ChunkErrorBoundary label={label}>
      <Suspense
        fallback={
          fallback === undefined ? (
            <div className="muted" aria-busy="true">
              Loading {label.toLowerCase()}…
            </div>
          ) : (
            fallback
          )
        }
      >
        {children}
      </Suspense>
    </ChunkErrorBoundary>
  );
}
