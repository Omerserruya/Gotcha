import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';

import en from '@/i18n/messages/en/roles.json';
import he from '@/i18n/messages/he/roles.json';

import {
  ceilingSentence,
  isCeilingReason,
  isRoleRuleReason,
  roleRuleSentence,
} from './ceiling-words';

const say = (locale: 'en' | 'he', refusal: Parameters<typeof ceilingSentence>[0]) => {
  const t = createTranslator({
    locale,
    messages: { roles: locale === 'en' ? en : he },
    namespace: 'roles',
  });
  const format = createFormatter({ locale, timeZone: 'Asia/Jerusalem' });
  return ceilingSentence(refusal, t as never, (items) =>
    format.list(items, { type: 'conjunction' }),
  );
};

describe('★★ a refusal from the grant ceiling, in a sentence (auth 679b8812)', () => {
  it('ABOVE_OWN_ROLE names the missing permissions in the role grid’s words', () => {
    const refusal = {
      reason: 'above_own_role' as const,
      missing: ['crm:contacts:update', 'customer:commerce:refund'],
    };
    const english = say('en', refusal);
    expect(english).toMatch(/^You can't give permissions you don't hold yourself: /);
    expect(english).toContain(`${en.form.row['crm:contacts']} · ${en.form.action.update}`);
    expect(english).toContain(`${en.form.row['customer:commerce']} · ${en.form.action.refund}`);
    expect(english).not.toMatch(/crm:contacts|customer:commerce/);
    const hebrew = say('he', refusal);
    expect(hebrew).toContain(`${he.form.row['crm:contacts']} · ${he.form.action.update}`);
    expect(hebrew).not.toMatch(/[a-z]+:[a-z]+/);
  });

  it('one key the grid has no words for: a sentence naming none - never a code', () => {
    const refusal = {
      reason: 'above_own_role' as const,
      missing: ['crm:contacts:update', 'billing:invoices:frobnicate'],
    };
    expect(say('en', refusal)).toBe(en.ceiling.aboveOwnUnnamed);
    expect(say('he', refusal)).toBe(he.ceiling.aboveOwnUnnamed);
    // No keys at all (a legacy feature, or none sent): the same.
    expect(say('en', { reason: 'above_own_role', missing: [] })).toBe(en.ceiling.aboveOwnUnnamed);
    expect(say('en', { reason: 'above_own_role', missing: ['billing.refund'] })).toBe(
      en.ceiling.aboveOwnUnnamed,
    );
  });

  it('OWNER_ONLY', () => {
    expect(say('en', { reason: 'owner_only' })).toBe(en.ceiling.ownerOnly);
    expect(say('he', { reason: 'owner_only' })).toBe(he.ceiling.ownerOnly);
  });

  it('only the two ceiling reasons are taken for one', () => {
    expect(isCeilingReason({ reason: 'owner_only' })).toBe(true);
    expect(isCeilingReason({ reason: 'above_own_role' })).toBe(true);
    expect(isCeilingReason({ reason: 'forbidden' })).toBe(false);
  });
});

const rule = (locale: 'en' | 'he', refusal: Parameters<typeof roleRuleSentence>[0]) => {
  const t = createTranslator({
    locale,
    messages: { roles: locale === 'en' ? en : he },
    namespace: 'roles',
  });
  const format = createFormatter({ locale, timeZone: 'Asia/Jerusalem' });
  return roleRuleSentence(refusal, t as never, (items) =>
    format.list(items, { type: 'conjunction' }),
  );
};

describe('★★ a built-in role’s own rules, refused on save (auth 30d610da)', () => {
  it('ROLE_CEILING names the blocked keys in the grid’s words - never a code', () => {
    const refusal = {
      reason: 'role_ceiling' as const,
      blocked: ['settings:roles:manage', 'settings:workspace:update'],
    };
    const english = rule('en', refusal);
    expect(english).toMatch(/^This role can never have these: /);
    expect(english).toContain(`${en.form.row['settings:roles']} · ${en.form.action.manage}`);
    expect(english).toContain(`${en.form.row['settings:workspace']} · ${en.form.action.update}`);
    expect(english).toMatch(/Nothing was changed\.$/);
    expect(english).not.toMatch(/settings:/);
    const hebrew = rule('he', refusal);
    expect(hebrew).toContain(`${he.form.row['settings:roles']} · ${he.form.action.manage}`);
    expect(hebrew).not.toMatch(/[a-z]+:[a-z]+/);
  });

  it('ROLE_CEILING with a key the grid has no words for: the unnamed sentence', () => {
    expect(rule('en', { reason: 'role_ceiling', blocked: ['x:y:frobnicate'] })).toBe(
      en.rules.refused.ceilingUnnamed,
    );
    expect(rule('he', { reason: 'role_ceiling', blocked: [] })).toBe(
      he.rules.refused.ceilingUnnamed,
    );
  });

  it('OWNER_FLOOR names the keys the Owner always keeps', () => {
    const english = rule('en', { reason: 'owner_floor', missing: ['settings:billing:manage'] });
    expect(english).toBe(
      `The Owner always keeps these: ${en.form.row['settings:billing']} · ${en.form.action.manage}. Nothing was changed.`,
    );
    expect(rule('he', { reason: 'owner_floor', missing: ['settings:billing:manage'] })).toContain(
      `${he.form.row['settings:billing']} · ${he.form.action.manage}`,
    );
    expect(rule('en', { reason: 'owner_floor', missing: [] })).toBe(en.rules.refused.floorUnnamed);
  });

  it('ROLE_MERGED: Admin is now part of Owner', () => {
    expect(rule('en', { reason: 'role_merged' })).toBe(
      'Admin is now part of Owner. Nothing was changed.',
    );
    expect(rule('he', { reason: 'role_merged' })).toBe(he.rules.refused.merged);
  });

  it('only the three rule reasons are taken for one', () => {
    expect(isRoleRuleReason({ reason: 'role_ceiling' })).toBe(true);
    expect(isRoleRuleReason({ reason: 'owner_floor' })).toBe(true);
    expect(isRoleRuleReason({ reason: 'role_merged' })).toBe(true);
    expect(isRoleRuleReason({ reason: 'above_own_role' })).toBe(false);
    expect(isRoleRuleReason({ reason: 'system' })).toBe(false);
  });
});
