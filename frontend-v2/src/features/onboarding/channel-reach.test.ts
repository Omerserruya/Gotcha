import { describe, expect, it } from 'vitest';

import type { Channel } from '@/api/contracts/channels';
import type { WidgetInstall } from '@/api/contracts/website-widget';

import { joinNames, reachableChannels } from './channel-reach';

const channel = (type: string, connectionStatus: string) =>
  ({ channel: type, connectionStatus }) as unknown as Channel;
const install = (over: Partial<WidgetInstall> = {}) =>
  ({ code: null, shopify: [], ...over }) as unknown as WidgetInstall;

describe('★★ where a customer can write now', () => {
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

describe('★ names as one phrase', () => {
  it('English', () => {
    expect(joinNames(['Web chat'], 'en')).toBe('Web chat');
    expect(joinNames(['Web chat', 'WhatsApp', 'Email'], 'en')).toBe('Web chat, WhatsApp and Email');
  });

  it('★★ Hebrew: ו joined; a maqaf before ו; U+2011 before Latin, never a hyphen-minus', () => {
    expect(joinNames(['צ׳אט באתר', 'אימייל'], 'he')).toBe('צ׳אט באתר ואימייל');
    expect(joinNames(['צ׳אט באתר', 'וואטסאפ'], 'he')).toBe('צ׳אט באתר ו־וואטסאפ');
    expect(joinNames(['צ׳אט באתר', 'Instagram'], 'he')).toBe('צ׳אט באתר ו‑Instagram');
    expect(joinNames([], 'he')).toBe('');
  });
});
