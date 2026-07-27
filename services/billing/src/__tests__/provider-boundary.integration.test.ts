/**
 * Provider customer mapping, event storage and checkout status safety.
 *
 * DB-backed: the isolation guarantees are unique indexes, and only the real
 * database can prove they hold under a race.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@chatcenter/shared";
import {
  recordProviderCustomer,
  findProviderCustomer,
  assertOwnedBy,
  newExternalCustomerReference,
  providerEnvironment,
  ProviderCustomerConflict,
} from "../services/provider-customer.service";
import {
  recordProviderEvent,
  redactEventPayload,
  hashPayload,
  providerEventsEnabled,
  processProviderEvent,
  MAX_EVENT_BODY_BYTES,
} from "../services/provider-event.service";

const RUN = `pb-${Date.now()}`;
const entityIds: string[] = [];
const tenantIds: string[] = [];
const ORIGINAL = { ...process.env };

async function newEntity() {
  const n = `${RUN}-${Math.random().toString(36).slice(2, 8)}`;
  const t = await prisma.tenant.create({ data: { name: n, slug: n, status: "PENDING_PAYMENT" } });
  const e = await prisma.billableEntity.create({ data: { displayName: n } });
  await prisma.billableEntityTenant.create({ data: { billableEntityId: e.id, tenantId: t.id } });
  tenantIds.push(t.id);
  entityIds.push(e.id);
  return { tenantId: t.id, entityId: e.id };
}

beforeEach(() => {
  process.env.ICOUNT_MODE = "mock";
  delete process.env.ICOUNT_PROVIDER_EVENTS_ENABLED;
});
afterEach(() => {
  process.env = { ...ORIGINAL };
});

afterAll(async () => {
  await prisma.providerCustomer.deleteMany({ where: { billableEntityId: { in: entityIds } } });
  await prisma.providerBillingEvent.deleteMany({ where: { payloadHash: { startsWith: "" }, environment: "mock", externalEventId: { startsWith: RUN } } }).catch(() => {});
  await prisma.billableEntityTenant.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  process.env = { ...ORIGINAL };
});

describe("provider customer mapping is tenant-isolated", () => {
  it("creates a mapping with an opaque reference of our own", async () => {
    const { tenantId, entityId } = await newEntity();
    const c = await recordProviderCustomer({ tenantId, billableEntityId: entityId, providerCustomerId: `${RUN}-1` });
    expect(c.externalReference).toMatch(/^gcust_[A-Za-z0-9_-]{20,}$/);
    expect(c.environment).toBe("mock");
    expect(c.status).toBe("ACTIVE");
  });

  it("is idempotent - repeat calls converge on one row", async () => {
    const { tenantId, entityId } = await newEntity();
    const a = await recordProviderCustomer({ tenantId, billableEntityId: entityId, providerCustomerId: `${RUN}-2` });
    const b = await recordProviderCustomer({ tenantId, billableEntityId: entityId, providerCustomerId: `${RUN}-2` });
    expect(b.id).toBe(a.id);
    expect(await prisma.providerCustomer.count({ where: { billableEntityId: entityId } })).toBe(1);
  });

  it("survives a concurrent race with exactly one row", async () => {
    const { tenantId, entityId } = await newEntity();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        recordProviderCustomer({ tenantId, billableEntityId: entityId, providerCustomerId: `${RUN}-3` }).catch((e) => e),
      ),
    );
    const ok = results.filter((r: any) => r?.id);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(await prisma.providerCustomer.count({ where: { billableEntityId: entityId } })).toBe(1);
  });

  it("refuses to re-point an entity at a different provider customer", async () => {
    const { tenantId, entityId } = await newEntity();
    await recordProviderCustomer({ tenantId, billableEntityId: entityId, providerCustomerId: `${RUN}-4a` });
    // Silently overwriting would orphan every card stored against the old one.
    await expect(
      recordProviderCustomer({ tenantId, billableEntityId: entityId, providerCustomerId: `${RUN}-4b` }),
    ).rejects.toThrow(/different_provider_customer/);
  });

  it("refuses to let a second tenant claim the same provider customer", async () => {
    const one = await newEntity();
    const two = await newEntity();
    const shared = `${RUN}-shared`;
    await recordProviderCustomer({ tenantId: one.tenantId, billableEntityId: one.entityId, providerCustomerId: shared });
    // THE cross-tenant case: charging the wrong organization.
    await expect(
      recordProviderCustomer({ tenantId: two.tenantId, billableEntityId: two.entityId, providerCustomerId: shared }),
    ).rejects.toBeInstanceOf(ProviderCustomerConflict);
  });

  it("never matches customers by email", async () => {
    const svc = readFileSync(join(__dirname, "../services/provider-customer.service.ts"), "utf8");
    expect(svc.toLowerCase()).not.toMatch(/where:\s*\{[^}]*email/);
  });

  it("guards ownership before any charge or card storage", async () => {
    const { tenantId, entityId } = await newEntity();
    const c = await recordProviderCustomer({ tenantId, billableEntityId: entityId, providerCustomerId: `${RUN}-own` });
    expect(() => assertOwnedBy(c, tenantId)).not.toThrow();
    expect(() => assertOwnedBy(c, "some-other-tenant")).toThrow(/another_tenant/);
  });

  it("keeps simulator and production identities apart", () => {
    process.env.ICOUNT_MODE = "mock";
    expect(providerEnvironment()).toBe("mock");
    process.env.ICOUNT_MODE = "live";
    // A simulator customer id is meaningless against a production account.
    expect(providerEnvironment()).not.toBe("mock");
  });

  it("generates unguessable, unique references", () => {
    const a = newExternalCustomerReference();
    expect(a).not.toBe(newExternalCustomerReference());
    expect(a.length).toBeGreaterThan(24);
  });
});

describe("provider events are disabled and store nothing sensitive", () => {
  it("is disabled by default and persists nothing", async () => {
    expect(providerEventsEnabled()).toBe(false);
    const before = await prisma.providerBillingEvent.count();
    const res = await recordProviderEvent({ rawBody: '{"a":1}', parsed: { a: 1 } });
    expect(res.stored).toBe(false);
    if (!res.stored) expect(res.reason).toBe("disabled");
    // Accepting arbitrary internet payloads "so we have them" is a data problem.
    expect(await prisma.providerBillingEvent.count()).toBe(before);
  });

  it("refuses an oversized body", async () => {
    process.env.ICOUNT_PROVIDER_EVENTS_ENABLED = "true";
    const huge = JSON.stringify({ blob: "x".repeat(MAX_EVENT_BODY_BYTES + 100) });
    const res = await recordProviderEvent({ rawBody: huge, parsed: { blob: "x" } });
    expect(res.stored).toBe(false);
    if (!res.stored) expect(res.reason).toBe("too_large");
  });

  it("removes card and credential fields entirely, not just masks them", () => {
    const out: any = redactEventPayload({
      Authorization: "Bearer secret",
      cc_token: "tok_live_abc",
      pan: "4242424242424242",
      cvv: "123",
      nested: { card_number: "4111111111111111", ok: "keep" },
      amount: 499,
    });
    const json = JSON.stringify(out);
    for (const secret of ["Bearer secret", "tok_live_abc", "4242424242424242", "123456", "4111111111111111"]) {
      expect(json).not.toContain(secret);
    }
    // Deleted before redaction, so nothing survives as a partial mask.
    expect(out.cc_token).toBe("[REMOVED]");
    expect(out.pan).toBe("[REMOVED]");
    expect(out.nested.card_number).toBe("[REMOVED]");
    expect(out.nested.ok).toBe("keep");
    expect(out.amount).toBe(499);
  });

  it("hashes the raw body deterministically", () => {
    expect(hashPayload('{"a":1}')).toBe(hashPayload('{"a":1}'));
    expect(hashPayload('{"a":1}')).not.toBe(hashPayload('{"a":2}'));
    expect(hashPayload('{"a":1}')).toMatch(/^[0-9a-f]{64}$/);
  });

  it("an event cannot activate anything - it parks for a human", async () => {
    process.env.ICOUNT_PROVIDER_EVENTS_ENABLED = "true";
    const res = await recordProviderEvent({
      rawBody: '{"x":1}', parsed: { x: 1 }, externalEventId: `${RUN}-evt-1`,
    });
    expect(res.stored).toBe(true);
    if (!res.stored) return;
    const processed = await processProviderEvent(res.event.id);
    // No verified contract means no mapping from payload to checkout.
    expect(processed.processing).toBe("MANUAL_REVIEW");
    await prisma.providerBillingEvent.delete({ where: { id: res.event.id } });
  });

  it("marks a repeated provider event id as a duplicate rather than reprocessing", async () => {
    process.env.ICOUNT_PROVIDER_EVENTS_ENABLED = "true";
    const id = `${RUN}-evt-dup`;
    const first = await recordProviderEvent({ rawBody: '{"y":1}', parsed: { y: 1 }, externalEventId: id });
    const second = await recordProviderEvent({ rawBody: '{"y":1}', parsed: { y: 1 }, externalEventId: id });
    expect(first.stored && !first.duplicate).toBe(true);
    expect(second.stored && second.duplicate).toBe(true);
    if (first.stored) await prisma.providerBillingEvent.deleteMany({ where: { OR: [{ id: first.event.id }, { duplicateOfId: first.event.id }] } });
  });

  it("invents no iCount event field names", async () => {
    const svc = readFileSync(join(__dirname, "../services/provider-event.service.ts"), "utf8");
    // The callback contract is unverified; guessing its shape is the mistake
    // that produced the fabricated endpoints.
    for (const invented of ["confirmation_code", "deal_id", "docnum", "secret-verify", "payment.succeeded"]) {
      expect(svc, `must not assume ${invented}`).not.toContain(invented);
    }
  });
});

describe("checkout status is customer-safe", () => {
  const route = readFileSync(join(__dirname, "../routes/checkout.ts"), "utf8");
  // Authorization is shared with the mutating routes so the two cannot drift
  // apart about who may act on a checkout.
  const auth = readFileSync(join(__dirname, "../lib/checkout-auth.ts"), "utf8");
  const session = readFileSync(join(__dirname, "../routes/checkout-session.ts"), "utf8");

  it("knowing the reference is not authorization", () => {
    expect(auth).toContain("knowing the opaque reference is NOT authorization");
    expect(route).toContain("if (!auth.ok) return notFound(res)");
    // Unauthorized and missing produce the SAME response, so a caller cannot
    // probe which references exist.
    expect(auth).toContain("export function checkoutNotFound");
  });

  it("the mutating routes authorize through the same function", () => {
    expect(session).toContain("authorizeCheckout");
    expect(session).toContain("if (!auth.ok)");
    // Its own copy would be a second set of rules to keep in step.
    expect(session).not.toMatch(/function authorize\w*\(/);
  });

  it("no mutating route accepts an outcome from the client", () => {
    const code = session.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    // A browser may ask us to look again. It may not tell us what it found.
    for (const claim of [
      "req.body.status", "req.body.paid", "req.body.success",
      "req.body.transactionId", "req.body.confirmation", "req.body.amount",
      "req.body.token,",
    ]) {
      expect(code, `must not read ${claim} from the client`).not.toContain(claim);
    }
    expect(code).toContain("advanceCheckout");
  });

  it("returns a decline category, never the raw provider string", () => {
    // A provider decline can carry account detail and reads like an error log.
    // The categoriser moved to a shared lib so the status read and this route
    // describe the same decline identically; the rule is unchanged.
    expect(session).toContain("declineCategory");
    expect(session).toContain('from "../lib/decline-category"');
    const shown = session.slice(session.indexOf("function safeAdvance"), session.indexOf("function returnUrl"));
    expect(shown).not.toMatch(/^\s*failureCode\s*:/m);
  });

  it("generates the payment destination server-side", () => {
    const code = session.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    // A client-supplied destination would be an open redirect into a page that
    // asks for card details.
    expect(code).not.toMatch(/req\.(body|query)\.(redirect|returnUrl|successUrl|failureUrl)/);
    expect(code).toContain("startPaymentSetup");
  });

  it("exposes no provider or internal identifier", () => {
    const body = route.slice(route.indexOf("res.json({"), route.length);
    for (const leak of [
      "providerCustomerId", "providerChargeRef", "attemptKey", "tenantId:",
      "pageId", "ICOUNT_PAYMENT_PAGE_ID", "redactedPayload", "stack",
    ]) {
      expect(body, `must not return ${leak}`).not.toContain(leak);
    }
  });

  it("has no route that completes a checkout", () => {
    expect(route).not.toMatch(/router\.(post|put|patch|delete)/);
    expect(route).not.toContain("activatePaidCheckout");
    expect(route).not.toContain('status: "PAID"');
  });

  it("does not offer retry where retrying could double-charge", () => {
    // UNKNOWN and RECONCILIATION_REQUIRED surface as PROCESSING, never as a
    // retryable failure.
    expect(route).toMatch(/UNKNOWN[\s\S]{0,120}return "PROCESSING"/);
    expect(route).toContain('retryEligible: status === "PAYMENT_REQUIRED" || status === "FAILED"');
  });

  it("is rate limited", () => {
    expect(route).toContain("rateLimited(reference)");
    expect(route).toContain("429");
  });
});
