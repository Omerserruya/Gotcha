import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

/** AppProviders hands `soleHuman` to the context the rail, ⌘K and the verbs read. */
const pass = vi.hoisted(
  () =>
    ({ children }: { children?: ReactNode }) =>
      children,
);
vi.mock('@/realtime/realtime-provider', () => ({ RealtimeProvider: pass }));
vi.mock('@/server-state/query-provider', () => ({ QueryProvider: pass }));
vi.mock('@/shell/InboundAlerts', () => ({ InboundAlerts: () => null }));
vi.mock('@/shell/SessionExpiryWatcher', () => ({ SessionExpiryWatcher: () => null }));
vi.mock('@/shell/ScrollFades', () => ({ ScrollFades: () => null }));

import { AppProviders } from '@/shell/AppProviders';

import { useSoleHuman } from './sole-human-context';

function Probe() {
  return <span data-testid="probe">{String(useSoleHuman())}</span>;
}

const show = (soleHuman?: boolean) =>
  render(
    <AppProviders locale="en" tenantId="t1" permissions={[]} soleHuman={soleHuman}>
      <Probe />
    </AppProviders>,
  );

describe('★★ the flag reaches the context', () => {
  it.each([
    [true, 'true'],
    [false, 'false'],
    [undefined, 'false'],
  ])('soleHuman=%s reads %s', (soleHuman, read) => {
    show(soleHuman);
    expect(screen.getByTestId('probe')).toHaveTextContent(read);
  });

  it('★ outside any provider it is the team inbox', () => {
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('false');
  });
});
