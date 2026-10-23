import { describe, expect, it } from 'vitest';

import {
  discoverJobSchema,
  employeeTestSchema,
  goLiveSchema,
  integrationSuggestionsSchema,
  learnedSchema,
} from './onboarding-v2';

/* By code point: a literal here is the character the dash guard forbids. */
const EM = String.fromCharCode(0x2014);

/** A job as Backend's viewOf sends it (job-store.ts:121), extra fields included. */
const job = {
  jobId: 'j1',
  domain: 'https://avivco.il',
  locale: 'he',
  status: 'RUNNING',
  stage: 'read_pages',
  startedAt: '2026-10-23T10:00:00.000Z',
  heartbeatAt: '2026-10-23T10:00:05.000Z',
  finishedAt: null,
  seq: 3,
  doneStages: ['detect_platform'],
  events: [
    {
      seq: 1,
      at: 'x',
      stage: 'detect_platform',
      kind: 'found',
      key: 'platform.detected',
      params: { platform: 'shopify' },
    },
    {
      seq: 2,
      at: 'x',
      stage: 'read_pages',
      kind: 'progress',
      key: 'page.reading',
      params: { path: '/returns', kind: 'returns' },
    },
    {
      seq: 3,
      at: 'x',
      stage: 'read_pages',
      kind: 'warn',
      key: 'pages.blocked',
      params: { blocked: 3, of: 40 },
    },
  ],
  counts: {
    pagesPlanned: 40,
    pagesRead: 12,
    pagesBlocked: 3,
    products: 34,
    policies: 2,
    faqs: 0,
    documents: 1,
  },
  found: {
    platform: 'shopify',
    productCount: 34,
    policies: ['returns'],
    faqCount: 0,
    contact: true,
    hours: false,
    brand: false,
    tools: ['returngo'],
    blocked: false,
  },
  error: null,
};

describe('★★ the site job, read for a poll that never dies', () => {
  it('reads Backend’s view', () => {
    const read = discoverJobSchema.parse(job);
    expect(read.status).toBe('RUNNING');
    expect(read.events.map((e) => e.key)).toEqual([
      'platform.detected',
      'page.reading',
      'pages.blocked',
    ]);
    expect(read.found).toMatchObject({
      platform: 'shopify',
      productCount: 34,
      productsSampled: 0,
    });
    expect(read.counts.pagesBlocked).toBe(3);
    // A count since 79ac48c6: "N sampled" straight from found after a reload.
    expect(
      discoverJobSchema.parse({ ...job, found: { ...job.found, productsSampled: 6 } }).found
        .productsSampled,
    ).toBe(6);
  });

  it('★★ a status, stage or kind it has never seen: still a job, still polled', () => {
    const read = discoverJobSchema.parse({
      ...job,
      status: 'WARMING_UP',
      stage: 'teleport',
      events: [{ ...job.events[0], kind: 'sparkle', stage: 'teleport' }],
    });
    expect(read.status).toBe('RUNNING');
    expect(read.stage).toBeNull();
    expect(read.events[0]).toMatchObject({
      kind: 'progress',
      stage: null,
      key: 'platform.detected',
    });
  });

  it('★★ one unreadable event is dropped, never the poll', () => {
    const read = discoverJobSchema.parse({
      ...job,
      events: [job.events[0], { seq: 'x' }, job.events[1]],
    });
    expect(read.events.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('★ found and counts that are missing or broken read as nothing found', () => {
    const read = discoverJobSchema.parse({ ...job, found: 'nope', counts: undefined });
    expect(read.found.platform).toBeNull();
    expect(read.found.policies).toEqual([]);
    expect(read.counts.pagesRead).toBe(0);
  });
});

describe('★★ what was learned', () => {
  const learned = {
    domain: 'https://avivco.il',
    status: 'COMPLETE',
    platform: 'shopify',
    profile: {
      name: 'Aviv',
      industry: 'Fashion',
      summary: `Urban wear ${EM} made here`,
      valueProp: null,
    },
    products: {
      count: 34,
      more: false,
      categories: ['Shirts'],
      priceRange: { min: 49, max: 390, currency: 'ILS' },
      highlights: [{ title: 'Tee', url: 'https://x/p/tee', price: '89.00' }],
      source: 'feed',
    },
    policies: [
      {
        id: 'returns',
        kind: 'returns',
        summary: '14 days',
        terms: { windowDays: 14, exchange: { allowed: true, how: 'In store' } },
        sourceUrl: 'https://x/returns',
      },
      { id: 'mystery', kind: 'galactic', summary: 'x', terms: null, sourceUrl: null },
      { broken: true },
    ],
    faq: [{ id: 'f1', q: 'Do you ship?', a: 'Yes', sourceUrl: null }],
    contact: {
      emails: ['hi@avivco.il'],
      phones: [],
      whatsapp: [],
      address: null,
      hours: 'Sun-Thu 9-18',
    },
    brand: { voice: 'warm', vocabulary: ['cozy'] },
    tools: [{ slug: 'returngo', name: 'ReturnGO' }],
  };

  it('reads Backend’s shape; model text shown with plain hyphens', () => {
    const read = learnedSchema.parse(learned);
    expect(read.profile?.summary).toBe('Urban wear - made here');
    expect(read.products?.priceRange).toEqual({ min: 49, max: 390, currency: 'ILS' });
    expect(read.policies[0]?.terms?.windowDays).toBe(14);
  });

  it('★★ a policy of an unknown kind is kept as "other"; a broken one is dropped, not the list', () => {
    const read = learnedSchema.parse(learned);
    expect(read.policies.map((p) => [p.id, p.kind])).toEqual([
      ['returns', 'returns'],
      ['mystery', 'other'],
    ]);
  });

  it('★★ products null is "not learned", never "no products"', () => {
    expect(learnedSchema.parse({ ...learned, products: null }).products).toBeNull();
    expect(learnedSchema.parse({ ...learned, products: 'garbage' }).products).toBeNull();
  });
});

describe('★ systems to connect', () => {
  it('reads each suggestion; an unknown reason is no reason, never a guessed one', () => {
    const read = integrationSuggestionsSchema.parse([
      {
        slug: 'shopify',
        name: 'Shopify',
        reason: 'platform',
        connect: { kind: 'oauth' },
        connected: false,
      },
      {
        slug: 'returngo',
        name: 'ReturnGO',
        reason: 'vibes',
        connect: { kind: 'key' },
        connected: true,
      },
      { name: 'no slug' },
    ]);
    expect(read).toEqual([
      { slug: 'shopify', name: 'Shopify', reason: 'platform', evidenceUrl: null, connected: false },
      { slug: 'returngo', name: 'ReturnGO', reason: null, evidenceUrl: null, connected: true },
    ]);
  });
});

describe('★★ go live, and its test', () => {
  it('reads the result; the test questions default to none', () => {
    const read = goLiveSchema.parse({
      employee: { id: 'a1', name: 'Noa', status: 'ACTIVE' },
      channels: [{ id: 'c1', type: 'WEBCHAT', displayName: 'Site', routed: true }],
      knowledgeBases: 1,
      policiesApplied: 3,
      tools: { platform: 'shopify', granted: ['shopify.order.read'] },
      warnings: ['no_platform_connected'],
    });
    expect(read.test).toEqual({ suggestedQuestion: null, suggestedOrderQuestion: null });
    expect(read.channels[0]?.routed).toBe(true);
  });

  it('★ the sandboxed employee test: usedRealOrder is false unless the route says true', () => {
    const read = employeeTestSchema.parse({
      answer: `On its way ${EM} tomorrow`,
      toolsUsed: [{ name: 'shopify.order.read', ok: true }],
    });
    expect(read.usedRealOrder).toBe(false);
    expect(read.answer).toBe('On its way - tomorrow');
  });
});
