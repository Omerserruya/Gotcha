import { readFileSync } from 'node:fs';

import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { workspaceVoiceSchema } from '@/api/contracts/workspace';
import workspace from '@/i18n/messages/en/workspace.json';
import common from '@/i18n/messages/en/common.json';

/*
 * ⚠ NOTHING HERE SAVES. The actions are mocked to throw: the voice is what
 * GOTCHA writes to customers in, and no test may change it.
 */
vi.mock('./actions', () => ({
  previewVoiceSample: vi.fn(async () => ({ ok: false, reason: 'unavailable' })),
  saveWorkspaceVoice: vi.fn(async () => {
    throw new Error('a test must never save the voice');
  }),
}));

import { VoiceEditor } from './VoiceEditor';
import styles from './Workspace.module.css';

const show = (guidance: string | null) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ workspace, common }} timeZone="UTC">
      <VoiceEditor voice={workspaceVoiceSchema.parse({ guidance, source: 'learned' })} />
    </NextIntlClientProvider>,
  );

describe('★ 11 - "How GOTCHA should sound" is read first, edited in place', () => {
  it('reads: the words it writes by, the sample, its caption, and "Edit" - no field', () => {
    show('Open with hi and their first name. Two sentences at most.');
    expect(screen.getByTestId('voice-text')).toHaveTextContent('Open with hi');
    expect(screen.queryByTestId('voice-field')).toBeNull();
    expect(screen.getByTestId('voice-card')).toHaveTextContent(
      "A real reply, written the way you've chosen",
    );
    expect(screen.getByTestId('voice-edit')).toBeInTheDocument();
  });

  it('nothing set says so, in the place the words would be', () => {
    show(null);
    expect(screen.getByTestId('voice-text')).toHaveTextContent('Nothing learned yet');
    // Said once - not again as the source line under it.
    expect(screen.getAllByText('Nothing learned yet')).toHaveLength(1);
  });

  it('"Edit" opens the field in place, and "Done" closes it', () => {
    show('Open with hi and their first name. Two sentences at most.');
    fireEvent.click(screen.getByTestId('voice-edit'));
    expect(screen.getByTestId('voice-field')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('voice-done'));
    expect(screen.queryByTestId('voice-field')).toBeNull();
  });
});

describe('★ its Edit sits at the END side, as every Workspace row’s does (Omer, 2026-10-12, W3)', () => {
  it('the end modifier, and the rule behind it', () => {
    show('Warm and brief.');
    expect(screen.getByTestId('voice-edit')).toHaveClass(styles.cardLinkEnd!);
    const css = readFileSync('src/features/workspace/Workspace.module.css', 'utf8');
    expect(css).toMatch(/\.cardLinkEnd\s*\{[^}]*align-self:\s*flex-end/);
  });
});
