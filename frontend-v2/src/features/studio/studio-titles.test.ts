import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import enCapabilities from '@/i18n/messages/en/capabilities.json';
import heCapabilities from '@/i18n/messages/he/capabilities.json';
import enKnowledge from '@/i18n/messages/en/knowledge.json';
import heKnowledge from '@/i18n/messages/he/knowledge.json';

/** The words Omer chose for Studio's two screens (2026-10-11: S1, K1, K2). */
describe('★ Studio’s titles, as agreed', () => {
  it('Integrations is "אינטגרציות" in Hebrew; English is unchanged', () => {
    expect(heCapabilities.title).toBe('אינטגרציות');
    expect(enCapabilities.title).toBe('What GOTCHA is allowed to do');
  });

  it('Knowledge is "מרכז הידע", with "מה GOTCHA יודעת על העסק שלכם" under it', () => {
    expect(heKnowledge.title).toBe('מרכז הידע');
    expect(heKnowledge.subtitle).toBe('מה GOTCHA יודעת על העסק שלכם');
    expect(enKnowledge.title).toBe('Knowledge center');
    expect(enKnowledge.subtitle).toBe('What GOTCHA knows about your business');
  });

  it('★ the page draws the subtitle - not a summary computed in its place', () => {
    const page = readFileSync('src/app/[locale]/(app)/studio/knowledge/page.tsx', 'utf8');
    expect(page).toContain("description={t('subtitle')}");
  });
});
