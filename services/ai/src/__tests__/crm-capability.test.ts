import { describe, it, expect } from "vitest";
import { executeCrmOperation } from "../services/capability-runtime/crm.runtime";
import type { CrmPort, CrmSearchResult, CrmUpsertResult } from "../services/capability-runtime/crm.port";
import { CRM_CONTRACTS } from "../services/capability-runtime/crm.contracts";
import type { ExecutionRequest, ExecutionMode } from "@chatcenter/shared";

const SILENT = { logger: () => {} };

function fakePort(opts: { connected?: boolean; vendor?: string; search?: CrmSearchResult; upsert?: CrmUpsertResult; note?: { ok: boolean; id?: string; reason?: string }; update?: { ok: boolean; id?: string; reason?: string }; task?: { ok: boolean; id?: string; reason?: string } } = {}): {
  port: CrmPort;
  calls: { search: number; upsert: number; note: number; context: number; update: number; task: number; lastUpdateFields?: Record<string, unknown> };
} {
  const calls: { search: number; upsert: number; note: number; context: number; update: number; task: number; lastUpdateFields?: Record<string, unknown> } = { search: 0, upsert: 0, note: 0, context: 0, update: 0, task: 0 };
  const port: CrmPort = {
    async connection() {
      return { connected: opts.connected ?? true, vendor: opts.vendor ?? "hubspot" };
    },
    async searchCustomer() {
      calls.search++;
      return opts.search ?? { ok: true, contacts: [] };
    },
    async upsertCustomer() {
      calls.upsert++;
      return opts.upsert ?? { status: "created", contact: CONTACT };
    },
    async addNote() {
      calls.note++;
      return opts.note ?? { ok: true, id: "note_1" };
    },
    async getContext() {
      calls.context++;
      return { ok: true, context: { contact: CONTACT, activities: 3, deals: [{ name: "Deal A", stage: "proposal" }], tickets: [] } };
    },
    async updateRecord(_c, args) {
      calls.update++;
      calls.lastUpdateFields = args.fields;
      return opts.update ?? { ok: true, id: "123" };
    },
    async createTask() {
      calls.task++;
      return opts.task ?? { ok: true, id: "task_1" };
    },
  };
  return { port, calls };
}

function req(
  operation: string,
  params: Record<string, unknown> = {},
  ctx: Record<string, unknown> = {},
  mode: ExecutionMode = "autonomous",
): ExecutionRequest {
  return { operation, params, context: { tenantId: "t1", conversationId: "c1", ...ctx }, mode };
}

const CONTACT = {
  id: "123", kind: "contact", displayName: "Dana Levi", email: "dana@x.com",
  phone: null, stage: "lead", vendor: "hubspot",
};

describe("CRM capability driver — SEARCH_CUSTOMER", () => {
  it("searches when an identifier is supplied in params → EXECUTED with contacts", async () => {
    const { port, calls } = fakePort({ search: { ok: true, contacts: [CONTACT] } });
    const { result, trace } = await executeCrmOperation(req("SEARCH_CUSTOMER", { email: "dana@x.com" }), { port, ...SILENT });
    expect(result.status).toBe("EXECUTED");
    expect((result as any).data.matchCount).toBe(1);
    expect((result as any).data.contacts[0].email).toBe("dana@x.com");
    expect(calls.search).toBe(1);
    expect(trace.successVerified).toBe(true);
  });

  it("falls back to the conversation's known identity (external id) as a search key", async () => {
    const { port, calls } = fakePort();
    const { result } = await executeCrmOperation(req("SEARCH_CUSTOMER", {}, { customerExternalId: "wa:+972500000000" }), { port, ...SILENT });
    expect(result.status).toBe("EXECUTED");
    expect(calls.search).toBe(1);
  });

  it("no identifier anywhere → NEEDS_INPUT(contact_identifier), strategy never runs", async () => {
    const { port, calls } = fakePort();
    const { result } = await executeCrmOperation(req("SEARCH_CUSTOMER", {}), { port, ...SILENT });
    expect(result).toMatchObject({ status: "NEEDS_INPUT", field: "contact_identifier" });
    expect(calls.search).toBe(0);
  });

  it("a READ still runs in advisory (shadow) mode — reads are never short-circuited", async () => {
    const { port, calls } = fakePort();
    const { result } = await executeCrmOperation(req("SEARCH_CUSTOMER", { email: "a@b.com" }, {}, "advisory"), { port, ...SILENT });
    expect(result.status).toBe("EXECUTED");
    expect(calls.search).toBe(1);
  });

  it("adapter can't serve the request → FAILED with the concrete reason", async () => {
    const { port } = fakePort({ search: { ok: false, contacts: [], reason: "no_crm_configured" } });
    const { result } = await executeCrmOperation(req("SEARCH_CUSTOMER", { email: "a@b.com" }), { port, ...SILENT });
    expect(result).toMatchObject({ status: "FAILED", reason: "no_crm_configured" });
  });

  it("an operation the driver doesn't own → BLOCKED unknown_operation", async () => {
    const { port } = fakePort();
    const { result } = await executeCrmOperation(req("CREATE_LEAD", { email: "a@b.com" }), { port, ...SILENT });
    expect(result).toMatchObject({ status: "BLOCKED" });
    expect((result as any).reason).toContain("unknown_operation");
  });

  it("the contract is business-only (no vendor/tool/endpoint leaks in meaning)", () => {
    const c = CRM_CONTRACTS.SEARCH_CUSTOMER;
    expect(c.effect).toBe("read");
    expect(c.capability).toBe("CRM");
    expect(/hubspot|salesforce|api|endpoint|tool/i.test(c.meaning)).toBe(false);
  });
});

describe("CRM connector — UPSERT_CUSTOMER (identity foundation, WRITE)", () => {
  it("new customer with an identifier → EXECUTED, resolution=created", async () => {
    const { port, calls } = fakePort({ upsert: { status: "created", contact: CONTACT } });
    const { result } = await executeCrmOperation(req("UPSERT_CUSTOMER", { email: "dana@x.com", name: "Dana" }), { port, ...SILENT });
    expect(result.status).toBe("EXECUTED");
    expect((result as any).data.resolution).toBe("created");
    expect(calls.upsert).toBe(1);
  });

  it("known customer → EXECUTED, resolution=linked (enriched flag surfaced)", async () => {
    const { port } = fakePort({ upsert: { status: "linked", contact: CONTACT, wasEnriched: true } });
    const { result } = await executeCrmOperation(req("UPSERT_CUSTOMER", { phone: "+972500000000" }), { port, ...SILENT });
    expect(result.status).toBe("EXECUTED");
    expect((result as any).data).toMatchObject({ resolution: "linked", enriched: true });
  });

  it("ambiguous 2+ matches → FAILED ambiguous_identity_needs_operator (never guesses)", async () => {
    const { port } = fakePort({ upsert: { status: "needs_approval", candidates: [CONTACT, { ...CONTACT, id: "999" }], reason: "two_matches" } });
    const { result } = await executeCrmOperation(req("UPSERT_CUSTOMER", { email: "dana@x.com" }), { port, ...SILENT });
    expect(result.status).toBe("FAILED");
    expect((result as any).reason).toContain("ambiguous_identity_needs_operator");
  });

  it("no identifier → NEEDS_INPUT(contact_identifier), the identity flow never runs", async () => {
    const { port, calls } = fakePort();
    const { result } = await executeCrmOperation(req("UPSERT_CUSTOMER", { name: "Only A Name" }), { port, ...SILENT });
    expect(result).toMatchObject({ status: "NEEDS_INPUT", field: "contact_identifier" });
    expect(calls.upsert).toBe(0);
  });

  it("advisory (shadow) mode → RECOMMENDED, no real mutation (identity flow never runs)", async () => {
    const { port, calls } = fakePort();
    const { result } = await executeCrmOperation(req("UPSERT_CUSTOMER", { email: "dana@x.com" }, {}, "advisory"), { port, ...SILENT });
    expect(result.status).toBe("RECOMMENDED");
    expect(calls.upsert).toBe(0);
  });

  it("UPSERT_CUSTOMER contract is a business-only WRITE", () => {
    const c = CRM_CONTRACTS.UPSERT_CUSTOMER;
    expect(c.effect).toBe("write");
    expect(/hubspot|salesforce|api|endpoint|tool/i.test(c.meaning)).toBe(false);
  });
});

describe("CRM connector — ADD_NOTE (WRITE)", () => {
  it("resolved contact + note text → EXECUTED, note recorded", async () => {
    const { port, calls } = fakePort({ note: { ok: true, id: "note_42" } });
    const { result } = await executeCrmOperation(req("ADD_NOTE", { contact_id: "123", note: "Discussed pricing." }), { port, ...SILENT });
    expect(result.status).toBe("EXECUTED");
    expect((result as any).data.noteId).toBe("note_42");
    expect(calls.note).toBe(1);
  });

  it("no contact_id → NEEDS_INPUT(contact_id), the note is never written", async () => {
    const { port, calls } = fakePort();
    const { result } = await executeCrmOperation(req("ADD_NOTE", { note: "orphan note" }), { port, ...SILENT });
    expect(result).toMatchObject({ status: "NEEDS_INPUT", field: "contact_id" });
    expect(calls.note).toBe(0);
  });

  it("no note text → NEEDS_INPUT(note)", async () => {
    const { port, calls } = fakePort();
    const { result } = await executeCrmOperation(req("ADD_NOTE", { contact_id: "123" }), { port, ...SILENT });
    expect(result).toMatchObject({ status: "NEEDS_INPUT", field: "note" });
    expect(calls.note).toBe(0);
  });

  it("advisory (shadow) → RECOMMENDED, no real write", async () => {
    const { port, calls } = fakePort();
    const { result } = await executeCrmOperation(req("ADD_NOTE", { contact_id: "123", note: "hi" }, {}, "advisory"), { port, ...SILENT });
    expect(result.status).toBe("RECOMMENDED");
    expect(calls.note).toBe(0);
  });

  it("vendor rejects the note → FAILED with the concrete reason", async () => {
    const { port } = fakePort({ note: { ok: false, reason: "contact_not_found" } });
    const { result } = await executeCrmOperation(req("ADD_NOTE", { contact_id: "999", note: "hi" }), { port, ...SILENT });
    expect(result).toMatchObject({ status: "FAILED", reason: "contact_not_found" });
  });
});

describe("CRM operation set — GET_CUSTOMER_CONTEXT / UPDATE_RECORD / CREATE_TASK", () => {
  it("GET_CUSTOMER_CONTEXT: resolved contact → EXECUTED with hydrated context (READ, runs in advisory too)", async () => {
    const { port, calls } = fakePort();
    const { result } = await executeCrmOperation(req("GET_CUSTOMER_CONTEXT", { contact_id: "123" }, {}, "advisory"), { port, ...SILENT });
    expect(result.status).toBe("EXECUTED");
    expect((result as any).data.context.deals[0].name).toBe("Deal A");
    expect(calls.context).toBe(1);
  });

  it("GET_CUSTOMER_CONTEXT: no contact_id → NEEDS_INPUT", async () => {
    const { port } = fakePort();
    const { result } = await executeCrmOperation(req("GET_CUSTOMER_CONTEXT", {}), { port, ...SILENT });
    expect(result).toMatchObject({ status: "NEEDS_INPUT", field: "contact_id" });
  });

  it("UPDATE_RECORD: sparse patch reaches the vendor verbatim (never wipes undiscussed fields)", async () => {
    const { port, calls } = fakePort();
    const { result } = await executeCrmOperation(
      req("UPDATE_RECORD", { contact_id: "123", fields: { phone: "+972501112222" } }), { port, ...SILENT });
    expect(result.status).toBe("EXECUTED");
    expect(calls.lastUpdateFields).toEqual({ phone: "+972501112222" }); // ONLY the provided field
    expect((result as any).outcome).toContain("sparse patch");
  });

  it("UPDATE_RECORD: empty fields → NEEDS_INPUT(fields), vendor never called", async () => {
    const { port, calls } = fakePort();
    const { result } = await executeCrmOperation(req("UPDATE_RECORD", { contact_id: "123", fields: {} }), { port, ...SILENT });
    expect(result).toMatchObject({ status: "NEEDS_INPUT", field: "fields" });
    expect(calls.update).toBe(0);
  });

  it("UPDATE_RECORD: vendor without update support → FAILED honest reason", async () => {
    const { port } = fakePort({ update: { ok: false, reason: "vendor_does_not_support_update" } });
    const { result } = await executeCrmOperation(req("UPDATE_RECORD", { contact_id: "1", fields: { a: 1 } }), { port, ...SILENT });
    expect(result).toMatchObject({ status: "FAILED", reason: "vendor_does_not_support_update" });
  });

  it("CREATE_TASK: autonomous NEVER auto-executes — production floor is approval 'always'", async () => {
    // The static policy floor for create_task is mode:"always" (tool-gate.ts) —
    // an autonomous CREATE_TASK must go through approval, never straight to the
    // vendor. Hermetically (no DB) the approval creation fails closed → FAILED;
    // in production it becomes AWAITING_APPROVAL. Either way: NO vendor call.
    const { port, calls } = fakePort();
    const ok = await executeCrmOperation(req("CREATE_TASK", { contact_id: "123", subject: "Call back Monday" }), { port, ...SILENT });
    expect(ok.result.status).not.toBe("EXECUTED");
    expect(calls.task).toBe(0);
    const missing = await executeCrmOperation(req("CREATE_TASK", { contact_id: "123" }), { port, ...SILENT });
    expect(missing.result).toMatchObject({ status: "NEEDS_INPUT", field: "subject" });
  });

  it("WRITE ops dry-run in advisory (shadow) mode — no vendor call", async () => {
    const { port, calls } = fakePort();
    const u = await executeCrmOperation(req("UPDATE_RECORD", { contact_id: "1", fields: { a: 1 } }, {}, "advisory"), { port, ...SILENT });
    const t = await executeCrmOperation(req("CREATE_TASK", { contact_id: "1", subject: "s" }, {}, "advisory"), { port, ...SILENT });
    expect(u.result.status).toBe("RECOMMENDED");
    expect(t.result.status).toBe("RECOMMENDED");
    expect(calls.update + calls.task).toBe(0);
  });
});
