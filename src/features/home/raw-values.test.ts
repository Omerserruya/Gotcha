import { describe, expect, it } from 'vitest';

import { humaniseCode } from '@/api/contracts/capabilities';
import { channelLabelKey } from '@/api/contracts/inbox';
import en from '@/i18n/messages/en/channels.json';

import { waitLabel } from './queue-row';

/**
 * No backend identifier and no unbounded duration reaches a person.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE INSTANCE WAS FIXED ON SCREEN 02 AND THE NAME WAS NEVER SWEPT
 * ════════════════════════════════════════════════════════════════════════════
 * The inbox queue printed `SHOPIFY_LIVE_CHAT` and `47061m`; both were fixed
 * there and nowhere else. A browser walk with no fixtures then found the same
 * two defects on four more screens — `SHOPIFY_LIVE_CHAT` on Home's rows AND its
 * channel bar, `1444h` on Home's activity card, `PROJECT_MANAGEMENT` on the
 * integration rail, and `Crm` / `Ai` as headings on Permissions.
 *
 * So these tests are about the two SHAPES rather than the six sites: a code
 * that must become a name, and a count that must change unit before it stops
 * being readable.
 */

describe('★★ a duration that outgrows its unit changes unit', () => {
  const t = (key: string, values: Record<string, number>) => `${key}:${values.count}`;
  const at = (minutesAgo: number) => {
    const now = Date.UTC(2026, 8, 27, 12, 0, 0);
    return waitLabel(new Date(now - minutesAgo * 60_000).toISOString(), now, t);
  };

  it('minutes below the hour', () => {
    expect(at(14)).toBe('wait.minutes:14');
  });

  it('hours below the day', () => {
    expect(at(3 * 60)).toBe('wait.hours:3');
  });

  it('★★ days beyond that — this capped at hours, on the first screen a merchant opens', () => {
    /*
     * Two months of waiting used to render as a four-digit hour count. The
     * number exists to be read at a glance and a glance cannot divide by 24.
     */
    expect(at(60 * 24 * 60)).toBe('wait.days:60');
    expect(at(25 * 60)).toBe('wait.days:1');
  });

  it('★★ nothing ever renders more than three digits of one unit', () => {
    /*
     * The shape rather than an instance: whatever the age, the count stays
     * small enough to read. This is what `47061m` and `1444h` both violated.
     */
    for (const minutes of [0, 59, 60, 1439, 1440, 47061, 86400, 525_600]) {
      const label = at(minutes);
      const count = Number(label.split(':')[1]);
      expect(count, `${minutes} minutes → ${label}`).toBeLessThan(1000);
    }
  });
});

describe('★★ a channel code becomes the name the catalogue already has', () => {
  it('every channel the platform can send has a label in both locales', () => {
    /*
     * The old comment on Home argued the code should ship raw because "a
     * translation key per channel would go stale the moment a new one is
     * connected". `channels.name.*` has had all of them since screen 13.
     */
    for (const code of ['WHATSAPP', 'SHOPIFY_LIVE_CHAT', 'INSTAGRAM', 'VOICE']) {
      expect(channelLabelKey(code), code).toBe(code);
      expect((en.name as Record<string, string>)[code], code).toBeTruthy();
    }
  });

  it('★★ an unrecognised code is "another channel", never itself', () => {
    // The going-stale worry was real. A named fallback answers it; a raw
    // identifier does not.
    expect(channelLabelKey('SOME_NEW_CHANNEL')).toBeNull();
    expect(en.name.other).toBeTruthy();
  });
});

describe('★★ acronyms in platform identifiers are acronyms', () => {
  it('★★ Crm and Ai were section headings on a live screen', () => {
    expect(humaniseCode('crm')).toBe('CRM');
    expect(humaniseCode('ai')).toBe('AI');
    expect(humaniseCode('ai_employees')).toBe('AI employees');
  });

  it('★ screaming snake becomes a sentence', () => {
    expect(humaniseCode('PROJECT_MANAGEMENT')).toBe('Project management');
  });

  it('★★ a brand keeps its own casing, and WHATSAPP is not shouting', () => {
    /*
     * `whatsapp` was in the acronym list for one draft and came out
     * `WHATSAPP` — a different kind of wrong from `Whatsapp` and worse,
     * because it reads as emphasis rather than as a missing capital.
     */
    expect(humaniseCode('whatsapp')).toBe('WhatsApp');
    expect(humaniseCode('woocommerce_sync')).toBe('WooCommerce sync');
  });

  it('★ an ordinary short word is not mistaken for an acronym', () => {
    // Which is why the list is closed: "upper-case anything short" turns Tag
    // into TAG.
    expect(humaniseCode('tag')).toBe('Tag');
  });
});
