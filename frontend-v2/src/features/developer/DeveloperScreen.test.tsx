import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import developer from '@/i18n/messages/en/developer.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'developer') =>
    createTranslator({ locale: 'en', messages: { developer }, namespace }),
}));

import { DeveloperScreen } from './DeveloperScreen';

describe('★ 18 - 02’s three cards, drawn with nothing behind them', () => {
  it('each card is there with its "-", and why on its title', async () => {
    render(await DeveloperScreen());
    for (const id of ['keys', 'webhooks', 'access']) {
      const none = screen.getByTestId(`developer-${id}-none`);
      expect(none).toHaveTextContent(/^-$/);
      expect(none).toHaveAttribute('title', expect.stringMatching(/\S/));
    }
  });

  it('the controls are drawn and not live', async () => {
    render(await DeveloperScreen());
    for (const id of ['new-key', 'add-endpoint']) {
      const control = screen.getByTestId(`developer-${id}`);
      expect(control).toHaveAttribute('aria-disabled', 'true');
      expect(control.closest('a,button')).toBeNull();
    }
  });

  it('02’s promises about retries and the security log are not made', async () => {
    const { container } = render(await DeveloperScreen());
    expect(container).not.toHaveTextContent(/retry|security log/i);
  });
});
