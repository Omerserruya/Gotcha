import { describe, expect, it } from 'vitest';

import { automationSchema } from '@/api/contracts/automations';

import { defaultRouteOf, savedName, shownName, type RouteNames } from './shown-name';

const he: RouteNames = {
  setup: 'מי עונה לשיחות חדשות',
  webchat: 'מי עונה לצ׳אט באתר',
  shopifyChat: 'מי עונה לצ׳אט בחנות',
};

const route = (over: Record<string, unknown>) =>
  automationSchema.parse({
    id: 'r',
    name: 'x',
    status: 'live',
    trigger: { type: 'conversation_started', config: {} },
    updatedAt: '2026-11-09T00:00:00Z',
    ...over,
  });

describe('★★ the system’s routes in the screen’s words (F2, 2026-11-09)', () => {
  it.each([
    [{ name: 'Who answers new conversations', origin: 'setup' }, 'setup', 'מי עונה לשיחות חדשות'],
    [
      {
        name: 'Who answers the website chat',
        trigger: { type: 'conversation_started', config: { channels: ['WEBCHAT'] } },
      },
      'webchat',
      'מי עונה לצ׳אט באתר',
    ],
    [
      {
        name: 'Who answers the Shopify store chat',
        trigger: { type: 'conversation_started', config: { channels: ['SHOPIFY_LIVE_CHAT'] } },
      },
      'shopifyChat',
      'מי עונה לצ׳אט בחנות',
    ],
  ])('%o is %s, shown as "%s"', (over, kind, words) => {
    expect(defaultRouteOf(route(over))).toBe(kind);
    expect(shownName(route(over), he)).toBe(words);
  });

  it.each([
    [
      'renamed',
      {
        name: 'Our chat',
        trigger: { type: 'conversation_started', config: { channels: ['WEBCHAT'] } },
      },
    ],
    ['the setup name without the origin', { name: 'Who answers new conversations' }],
    [
      'the website name on another channel',
      {
        name: 'Who answers the website chat',
        trigger: { type: 'conversation_started', config: { channels: ['WHATSAPP'] } },
      },
    ],
    [
      'the website name on two channels',
      {
        name: 'Who answers the website chat',
        trigger: { type: 'conversation_started', config: { channels: ['WEBCHAT', 'WHATSAPP'] } },
      },
    ],
    [
      'the website name on another trigger',
      {
        name: 'Who answers the website chat',
        trigger: { type: 'message_received', config: { channels: ['WEBCHAT'] } },
      },
    ],
  ])('%s: the author’s, as written', (_, over) => {
    const a = route(over);
    expect(defaultRouteOf(a)).toBeNull();
    expect(shownName(a, he)).toBe(a.name);
  });

  it('★★ saving an untouched shown name keeps the stored one; a typed one is saved as typed', () => {
    const web = route({
      name: 'Who answers the website chat',
      trigger: { type: 'conversation_started', config: { channels: ['WEBCHAT'] } },
    });
    expect(savedName('מי עונה לצ׳אט באתר', web, he)).toBe('Who answers the website chat');
    expect(savedName('  מי עונה לצ׳אט באתר ', web, he)).toBe('Who answers the website chat');
    expect(savedName('הצ׳אט שלנו', web, he)).toBe('הצ׳אט שלנו');
    const own = route({ name: 'מי עונה לצ׳אט באתר' });
    expect(savedName('מי עונה לצ׳אט באתר', own, he)).toBe('מי עונה לצ׳אט באתר');
  });
});
