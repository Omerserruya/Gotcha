import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import inbox from '@/i18n/messages/en/inbox.json';
import mobile from '@/i18n/messages/en/mobile.json';

import { MobileCopilotCard } from './MobileCopilotCard';

/*
 * Copilot's card on the phone, closed by hand (Omer, 2026-11-03). Nothing here
 * reaches a route: the read, the model and the realtime hooks are doubles.
 */
const cards = [
  { id: 's1', text: 'First option' },
  { id: 's2', text: 'Second option' },
  { id: 's3', text: 'Third option' },
];
vi.mock('@/features/inbox/wall/wall-actions', () => ({ readSuggestions: async () => ({}) }));
vi.mock('@/features/inbox/wall/wall-model', () => ({
  suggestionView: () => ({ kind: 'cards', suggestions: cards }),
  canUse: () => true,
}));
vi.mock('@/features/inbox/reply-event', () => ({ fillComposer: () => undefined }));
vi.mock('@/realtime/realtime-provider', () => ({
  useConversationRoom: () => undefined,
  useRealtimeEvent: () => undefined,
}));

describe('MobileCopilotCard', () => {
  it('★ X closes the whole card, not only the option on screen', async () => {
    const user = userEvent.setup();
    render(
      <NextIntlClientProvider locale="en" messages={{ inbox, mobile }}>
        <MobileCopilotCard conversationId="c1" />
      </NextIntlClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('mobile-copilot')).toHaveTextContent('First option'),
    );
    await user.click(screen.getByRole('button', { name: 'Close the suggestion' }));
    expect(screen.queryByTestId('mobile-copilot')).toBeNull();
  });
});
