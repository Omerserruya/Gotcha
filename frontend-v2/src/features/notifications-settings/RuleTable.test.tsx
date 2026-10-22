import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/notifications-settings.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'notifications-settings') =>
    createTranslator({ locale: 'en', messages: { 'notifications-settings': messages }, namespace }),
}));

import { RuleTable } from './RuleTable';

describe('★ day one says GOTCHA’s own route (notifications 9164a058) - never "nobody is told"', () => {
  it('no rules: who is told instead, in the app, and that email waits for a rule', async () => {
    render(await RuleTable({ rules: [], departments: [], members: [] }));
    const lead = screen.getByTestId('rules-empty');
    expect(lead).toHaveTextContent(
      'an assignment reaches the person assigned; approvals, failures, campaigns and billing reach admins. In the app only - email goes only where a rule sends it.',
    );
    expect(lead).not.toHaveTextContent(/telling nobody/);
  });
});
