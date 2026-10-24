import { describe, expect, it } from 'vitest';

import type { Channel } from '@/api/contracts/channels';
import type { WidgetInstall } from '@/api/contracts/website-widget';

import { channelsPhrase, inPlace, reachableChannels } from './channel-reach';

const channel = (type: string, connectionStatus: string) =>
  ({ channel: type, connectionStatus }) as unknown as Channel;
const install = (over: Partial<WidgetInstall> = {}) =>
  ({ code: null, shopify: [], ...over }) as unknown as WidgetInstall;

describe('★★ where a customer can write now', () => {
  it('★ an inactive account never reaches, even CONNECTED (Backend counts active accounts only)', () => {
    const off = {
      channel: 'EMAIL',
      connectionStatus: 'CONNECTED',
      isActive: false,
    } as unknown as Channel;
    expect(reachableChannels([off], install())).toEqual([]);
  });

  it('★ Gmail and Outlook are the email row; Messenger is its own', () => {
    expect(
      reachableChannels(
        [channel('GMAIL', 'CONNECTED'), channel('MESSENGER', 'CONNECTED')],
        install(),
      ),
    ).toEqual(['MESSENGER', 'EMAIL']);
    expect(reachableChannels([channel('OUTLOOK', 'CONNECTED')], install())).toEqual(['EMAIL']);
    expect(reachableChannels([channel('SLACK', 'CONNECTED')], install())).toEqual([]);
  });

  it('a CONNECTED channel reaches; any other status does not', () => {
    expect(
      reachableChannels(
        [channel('WHATSAPP', 'CONNECTED'), channel('INSTAGRAM', 'ERROR')],
        install(),
      ),
    ).toEqual(['WHATSAPP']);
  });

  it('★★ the website only once its code was SEEN, or a shop’s chat is on; code that exists answers nobody', () => {
    expect(reachableChannels([], install({ code: { status: 'pending' } as never }))).toEqual([]);
    expect(reachableChannels([], install({ code: { status: 'live' } as never }))).toEqual([
      'WEBCHAT',
    ]);
    const shop = (status: string, embedLive: boolean) => ({ status, embedLive }) as never;
    expect(reachableChannels([], install({ shopify: [shop('active', false)] }))).toEqual([]);
    expect(reachableChannels([], install({ shopify: [shop('active', true)] }))).toEqual([
      'WEBCHAT',
    ]);
  });

  it('in onboarding’s order', () => {
    expect(
      reachableChannels(
        [channel('EMAIL', 'CONNECTED'), channel('WHATSAPP', 'CONNECTED')],
        install({ code: { status: 'live' } as never }),
      ),
    ).toEqual(['WEBCHAT', 'WHATSAPP', 'EMAIL']);
  });

  it('★ either read failed: unknown (null), never "none" and never a partial list', () => {
    expect(reachableChannels(null, null)).toBeNull();
    expect(reachableChannels([channel('WHATSAPP', 'CONNECTED')], null)).toBeNull();
    expect(reachableChannels(null, install({ code: { status: 'live' } as never }))).toBeNull();
  });
});

describe('★★ where, as one phrase', () => {
  it('English: the names, listed', () => {
    expect(channelsPhrase(['Web chat'], 'en')).toBe('Web chat');
    expect(channelsPhrase(['Web chat', 'WhatsApp', 'Email'], 'en')).toBe(
      'Web chat, WhatsApp and Email',
    );
  });

  it('★★ Hebrew: the preposition on every item, joined straight to a Hebrew word', () => {
    expect(channelsPhrase(['צ׳אט באתר'], 'he')).toBe('בצ׳אט באתר');
    expect(channelsPhrase(['צ׳אט באתר', 'וואטסאפ'], 'he')).toBe('בצ׳אט באתר ובוואטסאפ');
    expect(channelsPhrase(['צ׳אט באתר', 'וואטסאפ', 'אימייל'], 'he')).toBe(
      'בצ׳אט באתר, בוואטסאפ ובאימייל',
    );
    expect(channelsPhrase([], 'he')).toBe('');
  });

  it('★ before Latin: a hyphen that never breaks (U+2011), never a maqaf or a hyphen-minus', () => {
    expect(channelsPhrase(['צ׳אט באתר', 'Instagram'], 'he')).toBe('בצ׳אט באתר וב\u2011Instagram');
    expect(inPlace('Shopify', 'he')).toBe('ב\u2011Shopify');
    expect(inPlace('שופיפיי', 'he')).toBe('בשופיפיי');
    expect(inPlace('Shopify', 'en')).toBe('in Shopify');
  });
});
