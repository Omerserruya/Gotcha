import { describe, expect, it } from 'vitest';

import { bodyOfWidget, widgetSettingsSchema } from './website-widget';

/** The settings as the route keeps them, the least of them. */
const read = (ux: Record<string, unknown> = {}) =>
  widgetSettingsSchema.parse({
    appearance: { primaryColor: '#121212', logoUrl: null, language: 'auto', showPoweredBy: true },
    ux: {
      welcome: { assistantName: 'Noa', suggestedQuestions: [] },
      launcher: { position: 'right' },
      hero: { mediaType: 'none', mediaUrl: null },
      proactive: { enabled: false, trigger: 'time_on_page', delaySeconds: 5, message: '' },
      ...ux,
    },
  });

describe('★★ W1 - the widget’s kind, and the WhatsApp greeting (Backend 2a2ab2af)', () => {
  it('kind read as sent; absent or unknown is chat', () => {
    expect(read({ kind: 'whatsapp' }).ux.kind).toBe('whatsapp');
    expect(read().ux.kind).toBe('chat');
    expect(read({ kind: 'sms' }).ux.kind).toBe('chat');
  });

  it('the welcome title (the WhatsApp greeting) is read, and absent is empty', () => {
    expect(
      read({ welcome: { title: 'Hi!', assistantName: 'Noa', suggestedQuestions: [] } }).ux.welcome
        .title,
    ).toBe('Hi!');
    expect(read().ux.welcome.title).toBe('');
  });

  it('★ the kind is sent only to a service that keeps it (stage B); the title always', () => {
    const settings = read({ kind: 'whatsapp' });
    expect(bodyOfWidget(settings, { stageB: true }).ux).toMatchObject({ kind: 'whatsapp' });
    expect(bodyOfWidget(settings).ux).not.toHaveProperty('kind');
    expect(bodyOfWidget(settings).ux.welcome).toHaveProperty('title', '');
  });
});
