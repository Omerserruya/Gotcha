import { describe, it, expect } from "vitest";
import {
  TurnOutcomeLedger,
  statusFromResult,
} from "../services/turn-outcome-ledger";
import {
  classifySideEffect,
  semanticKey,
  extractExternalRef,
} from "../services/side-effect-classifier";

describe("TurnOutcomeLedger — monotonic success", () => {
  it("a later failure does NOT downgrade a committed action", () => {
    const l = new TurnOutcomeLedger();
    l.record({ semanticKey: "booking|discovery_call|T|a@x.com", tool: "schedule_meeting", kind: "booking", visibility: "customer_facing", status: "committed", externalRef: { type: "gcal_event", id: "evt_abc" }, result: { ok: true } });
    // duplicate self-collision comes back INVALID/failed
    l.record({ semanticKey: "booking|discovery_call|T|a@x.com", tool: "schedule_meeting", kind: "booking", visibility: "customer_facing", status: "failed", result: { ok: false, reason: "agent_busy" } });
    const e = l.get("booking|discovery_call|T|a@x.com")!;
    expect(e.status).toBe("committed");
    expect(e.externalRef?.id).toBe("evt_abc");
  });

  it("succeeded_unverified is NOT downgraded by a later failure either", () => {
    const l = new TurnOutcomeLedger();
    l.record({ semanticKey: "k", tool: "t", kind: "create", visibility: "background", status: "succeeded_unverified", result: { ok: true } });
    l.record({ semanticKey: "k", tool: "t", kind: "create", visibility: "background", status: "failed", result: { ok: false } });
    expect(l.get("k")!.status).toBe("succeeded_unverified");
  });

  it("can upgrade succeeded_unverified → committed (later ref resolved)", () => {
    const l = new TurnOutcomeLedger();
    l.record({ semanticKey: "k", tool: "t", kind: "create", visibility: "background", status: "succeeded_unverified", result: { ok: true } });
    l.record({ semanticKey: "k", tool: "t", kind: "create", visibility: "background", status: "committed", externalRef: { type: "crm_record", id: "ld_1" }, result: { ok: true } });
    expect(l.get("k")!.status).toBe("committed");
    expect(l.get("k")!.externalRef?.id).toBe("ld_1");
  });
});

describe("TurnOutcomeLedger — dedup signal", () => {
  it("hasSucceeded() is true for committed AND succeeded_unverified", () => {
    const l = new TurnOutcomeLedger();
    l.record({ semanticKey: "c", tool: "t", kind: "create", visibility: "background", status: "committed", externalRef: { type: "x", id: "1" }, result: { ok: true } });
    l.record({ semanticKey: "u", tool: "t", kind: "create", visibility: "background", status: "succeeded_unverified", result: { ok: true } });
    l.record({ semanticKey: "f", tool: "t", kind: "create", visibility: "background", status: "failed", result: { ok: false } });
    expect(l.hasSucceeded("c")).toBe(true);
    expect(l.hasSucceeded("u")).toBe(true);  // unverified still blocks re-exec
    expect(l.hasSucceeded("f")).toBe(false); // failed may retry
    expect(l.hasSucceeded("missing")).toBe(false);
  });
});

describe("TurnOutcomeLedger — deterministic ordering + visibility", () => {
  it("customer-facing committed set is ordered booking before send, excludes background", () => {
    const l = new TurnOutcomeLedger();
    l.record({ semanticKey: "create|lead|a", tool: "create_lead", kind: "create", visibility: "background", status: "committed", externalRef: { type: "crm_record", id: "ld_1" }, result: { ok: true } });
    l.record({ semanticKey: "send|a|h", tool: "send_proposal", kind: "send", visibility: "customer_facing", status: "committed", externalRef: { type: "message", id: "m_1" }, result: { ok: true } });
    l.record({ semanticKey: "booking|d|T|a", tool: "schedule_meeting", kind: "booking", visibility: "customer_facing", status: "committed", externalRef: { type: "gcal_event", id: "evt_1" }, result: { ok: true } });
    const cf = l.customerFacingCommitted();
    expect(cf.map((e) => e.kind)).toEqual(["booking", "send"]); // deterministic order, no create
    expect(l.committed().length).toBe(3);
  });
});

describe("statusFromResult", () => {
  it("ok + ref → committed; ok + no ref → succeeded_unverified; !ok → failed", () => {
    expect(statusFromResult({ ok: true }, { type: "x", id: "1" })).toBe("committed");
    expect(statusFromResult({ ok: true }, undefined)).toBe("succeeded_unverified");
    expect(statusFromResult({ ok: false }, undefined)).toBe("failed");
  });
  it("sideEffect.awaitingApproval / denied map to pending/denied", () => {
    expect(statusFromResult({ sideEffect: { awaitingApproval: {} } }, undefined)).toBe("pending_approval");
    expect(statusFromResult({ sideEffect: { denied: {} } }, undefined)).toBe("denied");
  });
});

describe("classifySideEffect — derived from existing taxonomy", () => {
  it("classifies built-ins", () => {
    expect(classifySideEffect("schedule_meeting")).toMatchObject({ sideEffect: true, kind: "booking", visibility: "customer_facing" });
    expect(classifySideEffect("integration_create_lead")).toMatchObject({ kind: "create", noun: "lead", visibility: "background" });
    expect(classifySideEffect("integration_create_contact")).toMatchObject({ kind: "create", noun: "contact" });
    expect(classifySideEffect("add_note")).toMatchObject({ kind: "note" });
    expect(classifySideEffect("schedule_followup")).toMatchObject({ kind: "send", visibility: "customer_facing" });
    expect(classifySideEffect("link_customer_identifier")).toMatchObject({ kind: "link" });
  });
  it("read-only and submit tools are not side effects", () => {
    expect(classifySideEffect("hubspot.contacts_search").sideEffect).toBe(false);
    expect(classifySideEffect("submit_lead").sideEffect).toBe(false);
    expect(classifySideEffect("escalate_to_human").sideEffect).toBe(false);
  });
  it("unknown write-ish name defaults to side-effecting (nothing slips through)", () => {
    expect(classifySideEffect("acme.do_something").sideEffect).toBe(true);
  });
});

describe("semanticKey — stability (ordering / optional / format invariant)", () => {
  it("booking: reordered + format + casing variants collapse to one key", () => {
    const info = classifySideEffect("schedule_meeting");
    const k1 = semanticKey(info, { meeting_type: "discovery_call", requested_at_iso: "2026-06-22T16:30+02:00", customer_email: "noa@x.com", duration_minutes: 15, notes: "a" });
    const k2 = semanticKey(info, { duration_minutes: 30, customer_email: "Noa@X.com ", requested_at_iso: "2026-06-22T14:30:00Z", meeting_type: "Discovery_Call", notes: "different note" });
    expect(k1).toBe(k2);
    expect(k1).toBe("booking|discovery_call|2026-06-22T14:30:00.000Z|noa@x.com");
  });
  it("booking: falls back to ctx.contactId when email omitted", () => {
    const info = classifySideEffect("schedule_meeting");
    const k = semanticKey(info, { meeting_type: "discovery_call", requested_at_iso: "2026-06-22T14:30:00Z" }, { contactId: "ct_9" });
    expect(k.endsWith("|ct_9")).toBe(true);
  });
  it("create: lead vs contact for the same email are DIFFERENT keys", () => {
    const lead = semanticKey(classifySideEffect("integration_create_lead"), { email: "dan@acme.com" });
    const contact = semanticKey(classifySideEffect("integration_create_contact"), { email: "Dan@Acme.com " });
    expect(lead).toBe("create|lead|dan@acme.com");
    expect(contact).toBe("create|contact|dan@acme.com");
    expect(lead).not.toBe(contact);
  });
});

describe("extractExternalRef — mandatory id for committed", () => {
  it("pulls eventId for booking, id for create, messageId for send", () => {
    expect(extractExternalRef("booking", { ok: true, eventId: "evt_1" })).toEqual({ type: "gcal_event", id: "evt_1" });
    expect(extractExternalRef("create", { ok: true, result: { id: "ld_1" } })).toEqual({ type: "crm_record", id: "ld_1" });
    expect(extractExternalRef("send", { ok: true, messageId: "m_1" })).toEqual({ type: "message", id: "m_1" });
  });
  it("returns undefined when no id present (→ succeeded_unverified)", () => {
    expect(extractExternalRef("create", { ok: true })).toBeUndefined();
  });
  it("honors an explicit externalRef", () => {
    expect(extractExternalRef("other", { ok: true, externalRef: { type: "z", id: "9" } })).toEqual({ type: "z", id: "9" });
  });
});
