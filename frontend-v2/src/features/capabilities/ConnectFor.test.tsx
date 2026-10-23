import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { integrationSchema } from '@/api/contracts/integrations';
import capabilitiesEn from '@/i18n/messages/en/capabilities.json';
import capabilitiesHe from '@/i18n/messages/he/capabilities.json';

/** The launcher's two opt-ins (onboarding's step 2). Mocked: nothing connects. */
vi.mock('./connect-actions', () => ({
  connectIntegration: vi.fn(),
  startOAuth: vi.fn(),
  startWooOAuth: vi.fn(),
}));
vi.mock('./shopify-actions', () => ({}));
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { ConnectFor } from './ConnectFor';

const drawn = {
  connect: 'Connect it',
  oauthNotHere: 'Not from here: why.',
  noForm: 'Set up with GOTCHA.',
};
const keyed = integrationSchema.parse({
  id: 'i-r',
  slug: 'returngo',
  name: 'ReturnGO',
  authType: 'API_KEY',
  authSchema: {
    oauth: false,
    fields: [{ key: 'apiKey', type: 'password', label: 'API key', required: true }],
  },
});
const elsewhere = integrationSchema.parse({
  id: 'i-x',
  slug: 'some_oauth_tool',
  name: 'Elsewhere',
  authType: 'OAUTH2',
  authSchema: { oauth: true, fields: [] },
});
const show = (node: React.ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ capabilities: capabilitiesEn }}>
      {node}
    </NextIntlClientProvider>,
  );

describe('★ ConnectFor’s opt-ins', () => {
  it('★★ formLabel names the system on the key form’s button; without it, the catalogue’s word', () => {
    const { unmount } = show(
      <ConnectFor integration={keyed} drawn={drawn} formLabel="Connect ReturnGO" />,
    );
    expect(screen.getByTestId('connect-submit')).toHaveTextContent('Connect ReturnGO');
    unmount();
    show(<ConnectFor integration={keyed} drawn={drawn} />);
    expect(screen.getByTestId('connect-submit')).toHaveTextContent(
      capabilitiesEn.available.connect,
    );
  });

  it('★★ whyInWords: a control that can’t connect from here says why beside it', () => {
    show(<ConnectFor integration={elsewhere} drawn={drawn} whyInWords />);
    expect(screen.getByTestId('connect-drawn')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('connect-drawn-why')).toHaveTextContent('Not from here: why.');
  });

  it('★ without it (Studio), nothing changes: the reason stays the title only', () => {
    show(<ConnectFor integration={elsewhere} drawn={drawn} />);
    expect(screen.queryByTestId('connect-drawn-why')).toBeNull();
    expect(screen.getByTestId('connect-drawn')).toHaveAttribute('title', 'Not from here: why.');
  });

  it('★ a control that works never carries a why line', () => {
    show(<ConnectFor integration={keyed} drawn={drawn} whyInWords />);
    expect(screen.queryByTestId('connect-drawn-why')).toBeNull();
  });
});

describe('★ the key form’s labels in the screen’s language', () => {
  it('★★ "API key" reads "מפתח API" on a Hebrew screen; a label it doesn’t know stays as the catalogue wrote it', () => {
    const odd = integrationSchema.parse({
      id: 'i-o',
      slug: 'odd',
      name: 'Odd',
      authType: 'API_KEY',
      authSchema: {
        oauth: false,
        fields: [
          { key: 'apiKey', type: 'password', label: 'API key', required: true },
          { key: 'zone', type: 'text', label: 'Data center zone', required: true },
        ],
      },
    });
    render(
      <NextIntlClientProvider locale="he" messages={{ capabilities: capabilitiesHe }}>
        <ConnectFor integration={odd} drawn={drawn} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText('מפתח API')).toBeInTheDocument();
    expect(screen.queryByText('API key')).toBeNull();
    expect(screen.getByText('Data center zone')).toBeInTheDocument();
  });
});
