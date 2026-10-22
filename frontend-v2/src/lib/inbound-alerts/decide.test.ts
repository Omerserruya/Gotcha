import { describe, expect, it } from 'vitest';

import {
  CHIME_BURST_MS,
  firstLine,
  inboxHref,
  inQuietHours,
  localHHMM,
  notificationTag,
  openConversationIn,
  planAlert,
  quietTimeZone,
  settleAlert,
  tabRole,
} from './decide';
import { DEVICE_ALERT_DEFAULTS } from './settings';

/**
 * The rules for an incoming message, one at a time. Each `it` is one rule a
 * mutation of `decide.ts` should break.
 */

const base = {
  direction: 'INBOUND',
  messageType: 'text',
  hasContent: true,
  conversationId: 'c1',
  role: 'leader' as const,
  openConversationId: null,
  settings: { sound: true, desktop: true },
  permission: 'granted' as const,
  quiet: false,
};

describe('planAlert - before anything is read', () => {
  it('a customer message in a background tab that leads: sound and popup', () => {
    expect(planAlert(base)).toEqual({ sound: true, popup: true });
  });

  it('★ the agent’s own reply, the AI’s, an automation’s (OUTBOUND): nothing', () => {
    expect(planAlert({ ...base, direction: 'OUTBOUND' })).toEqual({ sound: false, popup: false });
  });

  it('a frame with no direction is not taken for the customer’s', () => {
    expect(planAlert({ ...base, direction: null })).toEqual({ sound: false, popup: false });
    expect(planAlert({ ...base, direction: undefined })).toEqual({ sound: false, popup: false });
  });

  it.each(['system', ' SYSTEM '])(
    '★ the platform’s own row (INBOUND, messageType %j - an escalation, an auto-close): nothing',
    (messageType) => {
      expect(planAlert({ ...base, messageType })).toEqual({ sound: false, popup: false });
    },
  );

  it('a photo, a voice note (not system) still alerts', () => {
    expect(planAlert({ ...base, messageType: 'image' })).toEqual({ sound: true, popup: true });
    expect(planAlert({ ...base, messageType: null })).toEqual({ sound: true, popup: true });
  });

  it('★ nothing to say (an empty body, no kind of media): nothing', () => {
    expect(planAlert({ ...base, hasContent: false })).toEqual({ sound: false, popup: false });
  });

  it('★ a focused tab: the sound alone, never a popup', () => {
    expect(planAlert({ ...base, role: 'focused' })).toEqual({ sound: true, popup: false });
  });

  it('★ a focused tab with THAT conversation open: nothing', () => {
    expect(planAlert({ ...base, role: 'focused', openConversationId: 'c1' })).toEqual({
      sound: false,
      popup: false,
    });
  });

  it('a focused tab with ANOTHER conversation open still chimes', () => {
    expect(planAlert({ ...base, role: 'focused', openConversationId: 'c2' }).sound).toBe(true);
  });

  it('a background leader chimes even for the conversation open in it (nobody is looking)', () => {
    expect(planAlert({ ...base, openConversationId: 'c1' })).toEqual({ sound: true, popup: true });
  });

  it('★ a tab that neither is focused nor leads: nothing', () => {
    expect(planAlert({ ...base, role: 'quiet' })).toEqual({ sound: false, popup: false });
  });

  it('★ inside quiet hours: no sound and no popup', () => {
    expect(planAlert({ ...base, quiet: true })).toEqual({ sound: false, popup: false });
    expect(planAlert({ ...base, role: 'focused', quiet: true })).toEqual({
      sound: false,
      popup: false,
    });
  });

  it('the sound switched off: the popup alone', () => {
    expect(planAlert({ ...base, settings: { sound: false, desktop: true } })).toEqual({
      sound: false,
      popup: true,
    });
  });

  it('the defaults: sound on, desktop off', () => {
    expect(planAlert({ ...base, settings: DEVICE_ALERT_DEFAULTS })).toEqual({
      sound: true,
      popup: false,
    });
  });

  it.each(['default', 'denied', 'unsupported'] as const)(
    '★ desktop on but the browser’s permission is %s: no popup',
    (permission) => {
      expect(planAlert({ ...base, permission }).popup).toBe(false);
    },
  );
});

describe('settleAlert - after the conversation read', () => {
  const plan = { sound: true, popup: true };

  it('visible, no chime yet: as planned', () => {
    expect(settleAlert(plan, { access: 'visible', now: 10_000, lastChimeAt: null })).toEqual(plan);
  });

  it('★ refused (403/404 - not this person’s conversation): silence', () => {
    expect(settleAlert(plan, { access: 'refused', now: 10_000, lastChimeAt: null })).toEqual({
      sound: false,
      popup: false,
    });
  });

  it('a read that failed: silence too - no proof they may see it', () => {
    expect(settleAlert(plan, { access: 'failed', now: 10_000, lastChimeAt: null })).toEqual({
      sound: false,
      popup: false,
    });
  });

  it('★ one chime per burst: inside 3s of the last, no sound - the popup still shows', () => {
    expect(
      settleAlert(plan, { access: 'visible', now: 10_000, lastChimeAt: 10_000 - 2_999 }),
    ).toEqual({ sound: false, popup: true });
  });

  it('★ the burst ends at 3s exactly', () => {
    expect(CHIME_BURST_MS).toBe(3_000);
    expect(
      settleAlert(plan, { access: 'visible', now: 10_000, lastChimeAt: 10_000 - 3_000 }).sound,
    ).toBe(true);
  });

  it('never adds what the plan did not have', () => {
    expect(
      settleAlert({ sound: false, popup: false }, { access: 'visible', now: 1, lastChimeAt: null }),
    ).toEqual({ sound: false, popup: false });
  });
});

describe('tabRole - the cross-tab election, decided', () => {
  it('★ focused here: focused, leader or not', () => {
    expect(tabRole({ selfFocused: true, otherFocused: false, leader: false })).toBe('focused');
    expect(tabRole({ selfFocused: true, otherFocused: false, leader: true })).toBe('focused');
  });

  it('★ another v2 tab is focused: this one keeps out, even as leader', () => {
    expect(tabRole({ selfFocused: false, otherFocused: true, leader: true })).toBe('quiet');
  });

  it('★ none focused: the leader speaks, and only the leader', () => {
    expect(tabRole({ selfFocused: false, otherFocused: false, leader: true })).toBe('leader');
    expect(tabRole({ selfFocused: false, otherFocused: false, leader: false })).toBe('quiet');
  });
});

describe('quiet hours - the notifications service’s rule', () => {
  const day = { from: '09:00', to: '17:00' };
  const night = { from: '22:00', to: '07:00' };

  it('none set: never quiet', () => {
    expect(inQuietHours(null, '03:00')).toBe(false);
  });

  it('a daytime window: from is inside, to is not', () => {
    expect(inQuietHours(day, '08:59')).toBe(false);
    expect(inQuietHours(day, '09:00')).toBe(true);
    expect(inQuietHours(day, '16:59')).toBe(true);
    expect(inQuietHours(day, '17:00')).toBe(false);
  });

  it('★ a window across midnight', () => {
    expect(inQuietHours(night, '21:59')).toBe(false);
    expect(inQuietHours(night, '22:00')).toBe(true);
    expect(inQuietHours(night, '23:59')).toBe(true);
    expect(inQuietHours(night, '00:00')).toBe(true);
    expect(inQuietHours(night, '06:59')).toBe(true);
    expect(inQuietHours(night, '07:00')).toBe(false);
    expect(inQuietHours(night, '12:00')).toBe(false);
  });

  it('from and to the same: no window, as the service reads it', () => {
    expect(inQuietHours({ from: '10:00', to: '10:00' }, '10:00')).toBe(false);
  });

  it('★ the time is read in the zone given, 24-hour', () => {
    // 21:30 UTC on 11 October 2026 is 00:30 in Jerusalem (UTC+3, summer time).
    const at = new Date('2026-10-11T21:30:00Z');
    expect(localHHMM(at, 'UTC')).toBe('21:30');
    expect(localHHMM(at, 'Asia/Jerusalem')).toBe('00:30');
    expect(inQuietHours(night, localHHMM(at, 'Asia/Jerusalem'))).toBe(true);
    // In January Jerusalem is UTC+2: the offset has a date.
    expect(localHHMM(new Date('2026-01-11T21:30:00Z'), 'Asia/Jerusalem')).toBe('23:30');
  });

  it('a zone Intl does not know reads as UTC, as the service does', () => {
    expect(localHHMM(new Date('2026-10-11T21:30:00Z'), 'Not/AZone')).toBe('21:30');
  });

  it('★ the zone is the workspace’s, only with a business-hours schedule, else UTC', () => {
    expect(quietTimeZone({ timezone: 'Asia/Jerusalem', hasSchedule: true }, 'Europe/Paris')).toBe(
      'Asia/Jerusalem',
    );
    // `parseBusinessHours` answers null without a schedule: the service uses UTC.
    expect(quietTimeZone({ timezone: 'Asia/Jerusalem', hasSchedule: false }, 'Europe/Paris')).toBe(
      'UTC',
    );
    expect(quietTimeZone({ timezone: null, hasSchedule: true }, 'Europe/Paris')).toBe('UTC');
  });

  it('a workspace we could not read: the zone the product shows times in', () => {
    expect(quietTimeZone(null, 'Asia/Jerusalem')).toBe('Asia/Jerusalem');
  });
});

describe('where the person is, and where a click goes', () => {
  const at = (pathname: string, search = '') => ({ pathname, search });
  const locales = ['en', 'he'];

  it('★ the conversation open at /v2/he/inbox?c=…', () => {
    expect(openConversationIn(at('/v2/he/inbox', '?c=c1'), '/v2', locales)).toBe('c1');
    expect(openConversationIn(at('/en/inbox', '?c=c1&view=mine'), '', locales)).toBe('c1');
  });

  it('nothing open: no ?c=, or another screen with a ?c=', () => {
    expect(openConversationIn(at('/v2/he/inbox'), '/v2', locales)).toBeNull();
    expect(openConversationIn(at('/v2/he/customers', '?c=c1'), '/v2', locales)).toBeNull();
    expect(openConversationIn(at('/v2/he/inbox/x', '?c=c1'), '/v2', locales)).toBeNull();
  });

  it('★ the click target: that conversation in the inbox, for the locale-aware router', () => {
    expect(inboxHref('c1')).toBe('/inbox?c=c1');
    expect(inboxHref('a b&c')).toBe('/inbox?c=a%20b%26c');
  });

  it('★ one tag per conversation', () => {
    expect(notificationTag('c1')).toBe('conv:c1');
  });

  it('the first line of the message, trimmed and capped', () => {
    expect(firstLine('\n  hello there \nsecond')).toBe('hello there');
    expect(firstLine('x'.repeat(200))).toHaveLength(140);
    expect(firstLine('x'.repeat(200)).endsWith('…')).toBe(true);
  });
});
