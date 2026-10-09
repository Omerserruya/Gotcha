import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from './ErrorBoundary';

function Boom({ shouldThrow }: { shouldThrow: boolean }): React.ReactElement {
  if (shouldThrow) throw new Error('boom');
  return <p>content</p>;
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    // React logs caught render errors to the console; silence it so a passing
    // test does not look like a failing one.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders its children when nothing throws', () => {
    render(
      <ErrorBoundary region="test" fallback={() => <p>failed</p>}>
        <Boom shouldThrow={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('content')).toBeInTheDocument();
  });

  it('contains a render failure and shows the fallback instead', () => {
    render(
      <ErrorBoundary region="test" fallback={() => <p>failed</p>}>
        <Boom shouldThrow />
      </ErrorBoundary>,
    );
    expect(screen.getByText('failed')).toBeInTheDocument();
  });

  it('leaves the surrounding page intact', () => {
    render(
      <div>
        <p>sibling</p>
        <ErrorBoundary region="test" fallback={() => <p>failed</p>}>
          <Boom shouldThrow />
        </ErrorBoundary>
      </div>,
    );
    // This is the whole point: one region fails, the rest keeps working.
    expect(screen.getByText('sibling')).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
  });

  it('recovers when the fallback resets it', async () => {
    function Recoverable() {
      return (
        <ErrorBoundary
          region="test"
          fallback={({ reset }) => (
            <button type="button" onClick={reset}>
              retry
            </button>
          )}
        >
          <Boom shouldThrow={false} />
        </ErrorBoundary>
      );
    }

    const { rerender } = render(
      <ErrorBoundary
        region="test"
        fallback={({ reset }) => (
          <button type="button" onClick={reset}>
            retry
          </button>
        )}
      >
        <Boom shouldThrow />
      </ErrorBoundary>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'retry' }));
    rerender(<Recoverable />);
    expect(screen.getByText('content')).toBeInTheDocument();
  });
});
