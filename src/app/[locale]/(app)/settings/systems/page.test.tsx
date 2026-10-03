import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/business-core.json';
import systems from '@/i18n/messages/en/systems.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({
      locale: 'en',
      messages: { 'business-core': messages, systems },
      namespace: namespace as 'systems',
    }),
  getLocale: async () => 'en',
}));
vi.mock('@/shell/SettingsSection', () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/shell/Drawer', () => ({
  Drawer: ({
    testId,
    title,
    line,
    children,
  }: {
    testId: string;
    title: string;
    line?: string;
    children: ReactNode;
  }) => (
    <aside data-testid={testId} aria-label={title} data-line={line}>
      {children}
    </aside>
  ),
}));
const { stub, loadCapabilities } = vi.hoisted(() => ({
  stub: (id: string) => () => <div data-testid={id} />,
  loadCapabilities: vi.fn(async () => ({ capabilities: [] })),
}));
vi.mock('@/features/integrations/BusinessCore', () => ({ BusinessCore: stub('core') }));
vi.mock('@/features/integrations/PartDrawer', () => ({
  PartDrawer: ({ storeHost }: { storeHost: string | null }) => (
    <div data-testid="part" data-host={storeHost ?? ''} />
  ),
}));
vi.mock('@/features/integrations/AcrossDrawer', () => ({ AcrossDrawer: stub('across') }));
vi.mock('@/features/capabilities/load-capabilities', () => ({ loadCapabilities }));
const { workspaceDomain } = vi.hoisted(() => ({
  workspaceDomain: { value: null as string | null },
}));
vi.mock('@/features/workspace/load-workspace', () => ({
  loadWorkspace: async () => ({ workspace: { websiteDomain: workspaceDomain.value } }),
}));
vi.mock('@/features/workspace/load-languages', () => ({
  loadLanguages: async () => ({ systemLocale: 'he' }),
}));
vi.mock('@/features/integrations/load-business-core', () => ({
  loadBusinessCore: async () => ({
    useCase: null,
    roles: [
      {
        role: 'ecommerce',
        elected: { slug: 'shopify', name: 'Shopify' },
        candidates: [{ slug: 'shopify', name: 'Shopify', connected: true, status: 'CONNECTED' }],
      },
    ],
    catalogueNotes: [],
  }),
}));

import Page from './page';

const open = async (params: Record<string, string>) =>
  render(await Page({ searchParams: Promise.resolve(params) }));

beforeEach(() => loadCapabilities.mockClear());

describe('★ 14 — 14c/14d and 14e open over it', () => {
  it('14 alone reads no capabilities: they are only for a part’s drawer', async () => {
    await open({});
    expect(loadCapabilities).not.toHaveBeenCalled();
  });

  it('?part= opens that part, titled by its name; capabilities read only then', async () => {
    await open({ part: 'ecommerce' });
    expect(screen.getByTestId('drawer-part')).toHaveAttribute('aria-label', 'Store');
    expect(loadCapabilities).toHaveBeenCalledTimes(1);
  });

  it('?panel=across opens 14e', async () => {
    await open({ panel: 'across' });
    expect(screen.getByTestId('drawer-across')).toBeInTheDocument();
  });

  it('an unknown part opens nothing', async () => {
    await open({ part: 'nonsense' });
    expect(screen.queryByTestId('drawer-part')).toBeNull();
  });
});

describe('★ 14d corrections — the line and the host', () => {
  it('the drawer’s line is a sentence: "The catalogue and orders."', async () => {
    await open({ part: 'ecommerce' });
    expect(screen.getByTestId('drawer-part')).toHaveAttribute(
      'data-line',
      'The catalogue and orders.',
    );
  });

  it('the store host only when the website IS the Shopify store', async () => {
    workspaceDomain.value = 'https://urban-supply-gotcha-demo.myshopify.com';
    const { unmount } = await open({ part: 'ecommerce' });
    expect(screen.getByTestId('part')).toHaveAttribute(
      'data-host',
      'urban-supply-gotcha-demo.myshopify.com',
    );
    unmount();
    workspaceDomain.value = 'https://www.avivco.il';
    await open({ part: 'ecommerce' });
    expect(screen.getByTestId('part')).toHaveAttribute('data-host', '');
  });
});
