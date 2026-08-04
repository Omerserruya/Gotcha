/**
 * The conversation summary must reach the merchant's customer record.
 *
 * Regression context: the summary was persisted GOTCHA-side only. The single
 * vendor write was the sparse FIELD patch, whose note fallback fires ONLY
 * when the field update fails — and on Shopify it does not fail, because
 * `updateRecord` maps to a real `shopify.update_customer` call. So a merchant
 * reading their own Shopify customer record found no trace of the
 * conversation and had to come back to GOTCHA to learn what happened.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getCrmAdapter = vi.fn();
vi.mock("../services/connectors/crm-adapter-resolver", () => ({
  getCrmAdapter: (...a: unknown[]) => getCrmAdapter(...a),
}));
vi.mock("@chatcenter/shared", () => ({
  prisma: { conversation: { findUnique: vi.fn() }, contact: { findFirst: vi.fn() } },
}));

import { writeSummaryNoteKindAware } from "../services/post-conversation-crm.service";

const IDENTITY = { crmContactId: "cust-1", crmObjectKind: "contact" as const };
const ARGS = {
  tenantId: "t1",
  conversationId: "conv-1",
  summary: "Customer asked to exchange a jacket for a larger size. Agreed to a store credit.",
  identity: IDENTITY,
};

function stubAdapter(over: Record<string, unknown> = {}) {
  return {
    capabilities: { is_stub: false, activity_kinds_supported: ["note"] },
    createNote: vi.fn().mockResolvedValue({ ok: true, id: "cust-1", was_update: true }),
    ...over,
  };
}

beforeEach(() => getCrmAdapter.mockReset());

describe("writeSummaryNoteKindAware", () => {
  it("writes the summary text onto the customer record", async () => {
    const adapter = stubAdapter();
    getCrmAdapter.mockResolvedValue(adapter);

    const res = await writeSummaryNoteKindAware(ARGS);

    expect(res).toMatchObject({ ok: true, outcome: "note", crmContactId: "cust-1" });
    const call = adapter.createNote.mock.calls[0][0];
    expect(call.contact_id).toBe("cust-1");
    expect(call.kind).toBe("contact");
    // The summary itself must be in the body — not just a field list.
    expect(call.body).toContain("exchange a jacket");
  });

  it("marks the note as GOTCHA's so a merchant knows who wrote it", async () => {
    const adapter = stubAdapter();
    getCrmAdapter.mockResolvedValue(adapter);

    await writeSummaryNoteKindAware(ARGS);

    expect(adapter.createNote.mock.calls[0][0].body).toContain("GOTCHA");
  });

  it("keys idempotency separately from the field patch on the same conversation", async () => {
    // Both writes target one record. Sharing a marker would let a retry of the
    // patch suppress the summary, or the reverse.
    const adapter = stubAdapter();
    getCrmAdapter.mockResolvedValue(adapter);

    await writeSummaryNoteKindAware(ARGS);

    expect(adapter.createNote.mock.calls[0][0].source_interaction_id).toBe("conv-1:summary");
  });

  it("bounds the body — Shopify's customer note is one field every write appends to", async () => {
    const adapter = stubAdapter();
    getCrmAdapter.mockResolvedValue(adapter);

    await writeSummaryNoteKindAware({ ...ARGS, summary: "x".repeat(5000) });

    expect(adapter.createNote.mock.calls[0][0].body.length).toBeLessThan(1700);
  });

  it("skips a vendor that models no notes rather than reporting a phantom write", async () => {
    const adapter = stubAdapter({
      capabilities: { is_stub: false, activity_kinds_supported: [] },
    });
    getCrmAdapter.mockResolvedValue(adapter);

    const res = await writeSummaryNoteKindAware(ARGS);

    expect(res).toMatchObject({ ok: false, reason: "notes-unsupported" });
    expect(adapter.createNote).not.toHaveBeenCalled();
  });

  it("skips when the customer has no CRM link", async () => {
    const res = await writeSummaryNoteKindAware({
      ...ARGS,
      identity: { crmContactId: null, crmObjectKind: null },
    });

    expect(res).toMatchObject({ ok: false, reason: "no-crm-link" });
    expect(getCrmAdapter).not.toHaveBeenCalled();
  });

  it("skips an empty summary instead of writing an empty note", async () => {
    const res = await writeSummaryNoteKindAware({ ...ARGS, summary: "   " });

    expect(res).toMatchObject({ ok: false, reason: "empty-summary" });
    expect(getCrmAdapter).not.toHaveBeenCalled();
  });

  it("reports a vendor failure as a failure, never as a silent success", async () => {
    getCrmAdapter.mockResolvedValue(
      stubAdapter({ createNote: vi.fn().mockResolvedValue({ ok: false, reason: "shopify_429" }) }),
    );

    const res = await writeSummaryNoteKindAware(ARGS);

    expect(res.ok).toBe(false);
    expect(res.reason).toContain("shopify_429");
  });

  it("skips when no store is connected at all", async () => {
    getCrmAdapter.mockResolvedValue({ capabilities: { is_stub: true } });

    expect((await writeSummaryNoteKindAware(ARGS)).reason).toBe("no-crm-adapter");
  });
});
