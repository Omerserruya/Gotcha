'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';

import { reportError } from '@/observability/logger';

interface Props {
  readonly children: ReactNode;
  /**
   * Rendered instead of the failed subtree. Receives a reset callback, so the
   * fallback can offer a retry that remounts rather than reloading the page.
   */
  readonly fallback: (state: { error: unknown; reset: () => void }) => ReactNode;
  /** Names the region in logs, e.g. `inbox.conversation-list`. */
  readonly region: string;
}

interface State {
  readonly error: unknown;
}

/**
 * Contains a render failure to one region of the page.
 *
 * Next.js `error.tsx` catches a whole route. That is right when the page
 * itself cannot render, and wrong for a widget: a customer-context panel that
 * throws should not take down the conversation the operator is in the middle
 * of replying to.
 *
 * Class component because React offers no hook equivalent -
 * `componentDidCatch` is still the only way to catch a descendant's render
 * error.
 *
 * Note this catches render errors only. Errors thrown in event handlers and in
 * promises are not caught by any boundary; those belong to the action and
 * query layers, which is where they are already handled.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Reported through the observability layer rather than to Sentry directly:
    // the design system has no business knowing which backend receives this.
    // The region name is what makes these actionable in aggregate - it turns
    // "something threw" into "the conversation list throws for 2% of loads".
    reportError(error, {
      region: this.props.region,
      componentStack: info.componentStack?.slice(0, 500),
    });
  }

  private readonly reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    if (this.state.error !== null) {
      return this.props.fallback({ error: this.state.error, reset: this.reset });
    }
    return this.props.children;
  }
}
