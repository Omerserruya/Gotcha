import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Screen 04b/04d/04e's loader — specifically, the envelope.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ WHY THIS FILE MOCKS THE UNWRAP RULE INSTEAD OF MOCKING PAST IT
 * ════════════════════════════════════════════════════════════════════════════
 * The 04e read shipped without `raw: true`. `/api/audit-logs/customer/:id`
 * answers `{ contact, data, nextCursor, coverage, scope }`, the client
 * unwrapped `.data` — an ARRAY — and handed it to a schema expecting an
 * object. Every request 200'd and every parse failed at `(root)`.
 *
 * Nothing caught it, and the reason is worth more than the fix. The only
 * loader test in this directory stubs `serverApi().get` to return whatever
 * the test hands it, which means it never exercises the two things that
 * actually disagreed: **the envelope rule and the contract.** A mock that
 * returns the parsed answer cannot catch a parse that should not have
 * happened.
 *
 * So `get` here models `http-client.ts`'s rule verbatim — unwrap `data`
 * unless `raw` — and then runs the real schema. That is the smallest mock
 * that can still fail.
 */

const capture = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));

vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({
  serverApi: () => ({
    get: async (req: {
      endpoint: { path: string };
      payload: { parse: (input: unknown) => unknown };
      raw?: boolean;
    }) => {
      capture.calls.push(req as unknown as Record<string, unknown>);
      const body = BODIES[req.endpoint.path.split('?')[0]!];
      if (body === undefined) throw new Error(`no stub for ${req.endpoint.path}`);
      /*
       * `http-client.ts`: unwrap `{ data }` unless `raw`. Copied because
       * this is the rule the defect turned on — a paraphrase that behaved
       * differently would make this test agree with itself rather than with
       * the client.
       */
      const unwrapped =
        !req.raw && typeof body === 'object' && body !== null && 'data' in body
          ? (body as { data: unknown }).data
          : body;
      return req.payload.parse(unwrapped);
    },
    post: async () => null,
  }),
}));

/** Real response bodies, keyed by path. */
let BODIES: Record<string, unknown> = {};

const approvalRow = (id: string, conversationId: string | null, contactId: string | null) => ({
  id,
  conversationId,
  contactId,
  tool: 'shopify.process_refund',
  summary: 'Process refund of 50 for order #1011',
  status: 'APPROVED',
  expiresAt: '2026-09-18T10:00:00.000Z',
  createdAt: '2026-09-18T09:00:00.000Z',
});
/** Theirs by conversation, theirs by contact, and somebody else's. */
const APPROVALS = [
  approvalRow('mine-by-conv', 'conv-1', null),
  approvalRow('mine-by-contact', null, 'c1'),
  approvalRow('theirs', 'conv-other', 'c-other'),
];

const TIMELINE = {
  data: {
    // Required since 6e9e84a9: present on every response, including empty
    // ones, so absence means the service is older than the contract.
    identityChannels: [],
    contact: {
      id: 'c1',
      displayName: 'Real Person',
      externalId: '+972500000000',
      channel: 'WHATSAPP',
    },
    // One event, so there IS a conversation to read orders and CRM through.
    events: [
      {
        type: 'message',
        channel: 'WHATSAPP',
        conversationId: 'conv-1',
        direction: 'INBOUND',
        body: 'hello',
        createdAt: '2026-09-18T09:14:00.000Z',
        origin: 'LIVE',
        id: 'e1',
      },
    ],
    page: { types: ['message'], limit: 50 },
    coverage: {},
    totals: { events: 0 },
  },
};

/**
 * The audit envelope as the route sends it — `data` is a SIBLING of four
 * other keys, which is the whole point.
 */
/**
 * The commerce union as the route sends it: `res.json(result)`, unenveloped,
 * with `data` sitting beside `state` on the `ok` branch.
 */
const ORDERS_OK = {
  state: 'ok',
  data: {
    summary: { orderCount: 1 },
    recentOrders: [],
    fetchedAt: '2026-09-18T09:20:00.000Z',
    customer: { verified: true, customerId: 'shopify-1' },
  },
};

const AUDIT = {
  contact: { id: 'c1', displayName: 'Real Person' },
  data: [],
  nextCursor: null,
  coverage: { conversation: { attributable: true } },
  scope: { identities: 1, conversations: 1, conversationScanTruncated: false },
};

beforeEach(() => {
  capture.calls = [];
  BODIES = {
    '/api/identity/c1/timeline': TIMELINE,
    '/api/approvals': { data: APPROVALS },
    '/api/audit-logs/customer/c1': AUDIT,
    // The timeline carries an externalId, so the memory read IS attempted
    // and must be stubbed — otherwise it fails and this file reports a
    // failure of its own making.
    '/api/historical-imports/customer-context': { data: { context: null } },
    '/api/crm/conversation/conv-1/context': { data: {} },
    '/api/commerce-context/conv-1': ORDERS_OK,
    // 04f. Contact-keyed and enveloped as `{ notes, contactId }` — no
    // top-level `data`, so nothing is unwrapped and no `raw` is wanted.
    '/api/identity/c1/notes': { notes: [], contactId: 'c1' },
    // The viewer's User.id, which is what `authorUserId` holds. NOT the
    // session's `sub`.
    '/api/auth/me': { user: { id: 'viewer-1' } },
  };
  vi.resetModules();
});

describe('★★ the audit envelope, where `data` is a sibling and not the payload', () => {
  it('★★ reads the five-key envelope rather than unwrapping it to an array', async () => {
    /*
     * THE DEFECT. Without `raw: true` the client hands `.data` — `[]` — to
     * `customerAuditSchema`, which expects an object, and the parse fails at
     * `(root)` on a clean 200.
     */
    const { loadCustomer } = await import('./load-customer');
    const detail = await loadCustomer('c1');

    expect(detail.actions.state).toBe('ok');
    if (detail.actions.state !== 'ok') return;
    // Proof it parsed the ENVELOPE: these three keys exist only outside
    // `data`, so an unwrapped array could not produce any of them.
    expect(detail.actions.audit.contact?.id).toBe('c1');
    expect(detail.actions.audit.scope.conversations).toBe(1);
    expect(detail.actions.audit.coverage.conversation?.attributable).toBe(true);
  });

  it('★ asks for the raw body, which is the flag the defect was missing', async () => {
    const { loadCustomer } = await import('./load-customer');
    await loadCustomer('c1');
    const audit = capture.calls.find((c) =>
      String((c.endpoint as { path: string }).path).includes('/audit-logs/customer/'),
    );
    expect(audit?.raw, 'the audit read must opt out of envelope unwrapping').toBe(true);
  });

  it('★★ records the failure by name when the read does break', async () => {
    /*
     * `readsFailed` is what stops the capture fixture standing a healthy
     * panel over a read that returned nothing — which is how this defect
     * passed 84 assertions.
     */
    // The body the DEFECT produced: the client unwrapped the envelope and
    // handed the bare array along.
    BODIES['/api/audit-logs/customer/c1'] = AUDIT.data;
    const { loadCustomer } = await import('./load-customer');
    const detail = await loadCustomer('c1');

    expect(detail.actions.state).toBe('failed');
    expect(detail.readsFailed).toContain('actions');
  });

  it('★★ GOTCHA’s actions: the approvals in their conversations or on their contact, once each', async () => {
    const { loadCustomer } = await import('./load-customer');
    const detail = await loadCustomer('c1');
    // One body answers all five status reads here, so this is also the dedupe.
    expect(detail.approvals?.map((a) => a.id).sort()).toEqual(['mine-by-contact', 'mine-by-conv']);
  });

  it('★ a merged-away id: both the id we were opened by and the survivor count as theirs', async () => {
    BODIES['/api/identity/c1/timeline'] = {
      data: { ...TIMELINE.data, contact: { ...TIMELINE.data.contact, id: 'c-survivor' } },
    };
    BODIES['/api/approvals'] = {
      data: [
        approvalRow('by-route-id', null, 'c1'),
        approvalRow('by-survivor', null, 'c-survivor'),
        approvalRow('theirs', null, 'c-other'),
      ],
    };
    const { loadCustomer } = await import('./load-customer');
    const detail = await loadCustomer('c1');
    expect(detail.approvals?.map((a) => a.id).sort()).toEqual(['by-route-id', 'by-survivor']);
  });

  it('⚠ approvals: null and named only when every status read failed', async () => {
    delete BODIES['/api/approvals'];
    const { loadCustomer } = await import('./load-customer');
    const detail = await loadCustomer('c1');
    expect(detail.approvals).toBeNull();
    expect(detail.readsFailed).toContain('approvals');
  });

  it('★ a limit is sent to the timeline as `limit`; none, and the route decides', async () => {
    const { loadCustomer } = await import('./load-customer');
    await loadCustomer('c1', { limit: 150 });
    const timelineCall = (calls: Record<string, unknown>[]) =>
      calls.find((c) =>
        (c.endpoint as { path: string }).path.startsWith('/api/identity/c1/timeline'),
      );
    expect(timelineCall(capture.calls)?.query).toEqual({ limit: 150 });
    capture.calls = [];
    await loadCustomer('c1');
    expect(timelineCall(capture.calls)?.query).toBeUndefined();
  });

  it('★ reports nothing as failed when every read succeeds', async () => {
    // A list that fills up on a healthy page would make the fixture gate
    // preserve failures that never happened.
    const { loadCustomer } = await import('./load-customer');
    expect((await loadCustomer('c1')).readsFailed).toEqual([]);
  });

  it('★★ a body missing `coverage` FAILS rather than claiming a complete log', async () => {
    /*
     * Every key at this level used to be defaulted, so `{}` parsed and
     * rendered "nothing has been recorded against this person yet" with no
     * caveats — a confident claim about somebody's history built out of a
     * response that said nothing. A stale service produces exactly that body.
     */
    const { coverage: _dropped, ...withoutCoverage } = AUDIT;
    BODIES['/api/audit-logs/customer/c1'] = withoutCoverage;
    const { loadCustomer } = await import('./load-customer');
    const detail = await loadCustomer('c1');

    expect(detail.actions.state).toBe('failed');
    expect(detail.readsFailed).toContain('actions');
  });
});

describe('★★ 04d\u2019s success path, which no test or capture has ever reached', () => {
  it('★★ keeps `state` instead of unwrapping the union down to its data', async () => {
    /*
     * THE SURVIVOR THE SWEEP FOUND.
     *
     * `/api/commerce-context/:id` answers the union unenveloped —
     * `{ state: "ok", data: {...} }`. Without `raw: true` the client sees a
     * top-level `data`, unwraps it, and hands the bare context to a schema
     * that REQUIRES `state`. 04d then renders "we couldn't read your
     * orders" for a working store.
     *
     * ★ IT HAS NEVER FIRED. Shopify is in ERROR on the demo tenant, so the
     * only reachable answer is `{ state: "connection_unhealthy" }` — no
     * `data` key, nothing unwrapped, everything green. The success path
     * breaks the moment a store connects.
     */
    const { loadCustomer } = await import('./load-customer');
    const detail = await loadCustomer('c1');

    expect(detail.orders?.state).toBe('ok');
    expect(detail.readsFailed).not.toContain('orders');
  });

  it('★ and the verified customer id survives, which 04e depends on', async () => {
    // `shopifyCustomerIdIn` reads `data.customer`. Lost with the unwrap, 04e
    // would never send `?shopifyCustomerId=` and would print the "pass it"
    // gap permanently.
    const { loadCustomer } = await import('./load-customer');
    const detail = await loadCustomer('c1');

    expect(detail.actions.state).toBe('ok');
    if (detail.actions.state !== 'ok') return;
    expect(detail.actions.supplied).toContain('shopifyCustomerId');
  });
});

describe('★★ 04f reads what 04e could not: the contact, with no conversation in the key', () => {
  it('★ joins the fan-out, because notes are keyed on the person', async () => {
    /*
     * The stub these replace was conversation-keyed, and that WAS the defect
     * — "a note is about a person, and the person outlives the thread". So
     * unlike the audit read, which waits on the commerce read for
     * `shopifyCustomerId`, this needs nothing from the other answers and
     * costs no extra round trip.
     */
    const { loadCustomer } = await import('./load-customer');
    const detail = await loadCustomer('c1');

    expect(detail.notes).toEqual([]);
    expect(detail.readsFailed).not.toContain('notes');
  });

  it('★★ carries the viewer’s User.id, not the session subject', async () => {
    /*
     * `authorUserId` holds `User.id`; the session holds Authentik's `sub`.
     * Comparing the wrong pair would hide the edit control from everybody,
     * including the author — and it would look like a permission problem
     * rather than a mismatched identifier.
     */
    const { loadCustomer } = await import('./load-customer');
    expect((await loadCustomer('c1')).viewerUserId).toBe('viewer-1');
  });

  it('★★ an unreadable notes list is NULL, never an empty one', async () => {
    // "Nobody has written a note about this person yet" is a claim, and it
    // is the wrong one to make from a request that did not come back.
    BODIES['/api/identity/c1/notes'] = { contactId: 'c1' };
    const { loadCustomer } = await import('./load-customer');
    const detail = await loadCustomer('c1');

    expect(detail.notes).toBeNull();
    expect(detail.readsFailed).toContain('notes');
  });

  it('★ a failed viewer read hides the controls rather than offering them', async () => {
    // The safe direction: nobody is handed an edit they may not have, and
    // the control returns on the next load.
    BODIES['/api/auth/me'] = { nothing: true };
    const { loadCustomer } = await import('./load-customer');
    const detail = await loadCustomer('c1');

    expect(detail.viewerUserId).toBeNull();
    expect(detail.readsFailed).toContain('viewer');
  });
});
