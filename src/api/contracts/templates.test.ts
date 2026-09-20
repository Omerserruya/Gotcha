import { describe, expect, it } from 'vitest';

import {
  groupByName,
  isUnchanged,
  needsApproval,
  templateSchema,
  templateStance,
  type Template,
} from './templates';

/**
 * The rulings on screen 05c, as assertions.
 *
 * This tenant has zero templates, so a capture photographs the empty state and
 * none of this.
 */

const template = (over: Partial<Template> = {}): Template => ({
  id: 't1',
  name: 'Back in stock',
  language: 'en',
  channel: 'WHATSAPP',
  category: 'marketing',
  body: 'Hi {{1}} — the {{2}} is back.',
  footer: null,
  status: 'APPROVED',
  rejectionReason: null,
  version: 1,
  isActive: true,
  updatedAt: null,
  createdAt: null,
  ...over,
});

describe('approval is a WhatsApp concept, not a template concept', () => {
  it('needs approval on WhatsApp', () => {
    expect(needsApproval(template({ channel: 'WHATSAPP' }))).toBe(true);
  });

  it('needs approval when the channel is null, which means every channel', () => {
    // A template usable anywhere inherits the strictest case — it could be
    // sent on WhatsApp, so it is subject to WhatsApp's review.
    expect(needsApproval(template({ channel: null }))).toBe(true);
  });

  it('does not need approval on email', () => {
    expect(needsApproval(template({ channel: 'EMAIL' }))).toBe(false);
  });

  it('reports an email template as exempt, never as approved', () => {
    /*
     * The design lists "Email only" beside "Ready to send", which reads as
     * though somebody approved it. Nobody did — there is no reviewer. This is
     * the `succeeded: null` rendering as `false` mistake in another costume:
     * an absent question presented as an answered one.
     */
    const email = template({ channel: 'EMAIL', status: 'DRAFT' });
    expect(templateStance(email)).toBe('exempt');
    expect(templateStance(email)).not.toBe('ready');
  });
});

describe('templateStance — five, because the design forgot one', () => {
  it('maps the three the design drew', () => {
    expect(templateStance(template({ status: 'APPROVED' }))).toBe('ready');
    expect(templateStance(template({ status: 'PENDING_APPROVAL' }))).toBe('reviewing');
    expect(templateStance(template({ status: 'REJECTED' }))).toBe('rejected');
  });

  it('gives DRAFT a state of its own', () => {
    // Written and never submitted. Real and common, and with no row in the
    // design — so it would have rendered blank or borrowed a wrong label.
    expect(templateStance(template({ status: 'DRAFT' }))).toBe('unsent');
  });

  it('never reports a draft as ready to send', () => {
    expect(templateStance(template({ status: 'DRAFT' }))).not.toBe('ready');
  });
});

describe('localisations are rows, not a field', () => {
  it('gathers languages that share a name', () => {
    // `@@unique([tenantId, name, language, channel])` — there is no
    // `translations` field to be missing; this is a grouping.
    const groups = groupByName([
      template({ id: 'a', language: 'en' }),
      template({ id: 'b', language: 'he' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.languages).toEqual(['en', 'he']);
  });

  it('keeps templates with different names apart', () => {
    const groups = groupByName([
      template({ id: 'a' }),
      template({ id: 'b', name: 'Order shipped' }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('does not repeat a language listed twice', () => {
    const groups = groupByName([
      template({ id: 'a', language: 'en', channel: 'WHATSAPP' }),
      template({ id: 'b', language: 'en', channel: 'EMAIL' }),
    ]);
    expect(groups[0]!.languages).toEqual(['en']);
  });
});

describe('a template carries nothing that could become a false claim', () => {
  it('exposes no ETA, no rewrite, no usage and no reply rate', () => {
    // None has a source. The `broadcasts` relation would give usage and reply
    // rate, and the list route has no `include` — so a field here would be
    // inventing what an endpoint has not yet been asked for.
    const surface = Object.keys(templateSchema.parse(template()));
    expect(
      surface.filter((k) => /eta|estimate|rewrite|suggest|usage|replyRate|permitted/i.test(k)),
    ).toEqual([]);
  });

  it('keeps rejectionReason, which is the screen', () => {
    const parsed = templateSchema.parse(
      template({ status: 'REJECTED', rejectionReason: 'Template is only an offer' }),
    );
    expect(parsed.rejectionReason).toBe('Template is only an offer');
  });

  it('makes "never changed since" real rather than fictional', () => {
    expect(isUnchanged(template({ version: 1 }))).toBe(true);
    expect(isUnchanged(template({ version: 3 }))).toBe(false);
  });
});
