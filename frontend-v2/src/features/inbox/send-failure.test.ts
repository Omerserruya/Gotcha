import { describe, expect, it } from 'vitest';

import en from '@/i18n/messages/en/inbox.json';
import he from '@/i18n/messages/he/inbox.json';

import { sendFailure } from './send-failure';

/** Why a send failed, in words - Omer's PNG, Meta 131053 (2026-11-15). */
const failed = (sendError: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  ...extra,
  metadata: { sendError, ...((extra.metadata as object) ?? {}) },
});

describe('★★ sendFailure', () => {
  it('★★ WhatsApp 131053 on an image: the format, said', () => {
    expect(
      sendFailure(failed({ channel: 'WHATSAPP', code: 131053 }, { messageType: 'image' })),
    ).toBe('failedImageFormat');
    expect(
      sendFailure({
        metadata: {
          sendError: { channel: 'WHATSAPP', code: 131053 },
          media: { mimeType: 'image/png' },
        },
      }),
    ).toBe('failedImageFormat');
  });

  it("★ …on another file: the file's format", () => {
    expect(
      sendFailure(failed({ channel: 'WHATSAPP', code: 131053 }, { messageType: 'document' })),
    ).toBe('failedMediaFormat');
  });

  it('★★ the same code on Instagram or Messenger is not guessed at', () => {
    for (const channel of ['INSTAGRAM', 'MESSENGER', undefined]) {
      expect(sendFailure(failed({ channel, code: 131053 }, { messageType: 'image' }))).toBe(
        'failed',
      );
    }
  });

  it('★ the 24 hours, as before; anything else, "did not send"', () => {
    expect(sendFailure(failed({ type: 'TEMPLATE_REQUIRED' }))).toBe('failedTemplateRequired');
    expect(sendFailure(failed({ type: 'REPLY_WINDOW_CLOSED' }))).toBe('failedWindowClosed');
    expect(sendFailure(failed({ channel: 'WHATSAPP', code: 131047 }))).toBe('failed');
    expect(sendFailure({})).toBe('failed');
  });

  it.each([
    ['en', en],
    ['he', he],
  ] as const)('★ every answer has words in %s', (_l, messages) => {
    for (const key of [
      'failed',
      'failedTemplateRequired',
      'failedWindowClosed',
      'failedImageFormat',
      'failedMediaFormat',
    ] as const) {
      expect(typeof messages.stream[key]).toBe('string');
    }
    expect(he.stream.failedImageFormat).toContain('וואטסאפ לא קיבל את התמונה');
  });
});
