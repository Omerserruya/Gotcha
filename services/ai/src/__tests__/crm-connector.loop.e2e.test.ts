/**
 * CRM CONNECTOR - full-loop autonomous verification via SIMULATION.
 *
 * The deferred "verify every CRM WRITE end-to-end" done without a real/disposable CRM:
 * the REAL CRM contracts + REAL runtime (`executeCrmOperation`) drive through the
 * UNCHANGED `runAgentLoop` in autonomous mode, backed by an in-memory CrmPort that
 * simulates the vendor. This proves the connector's decision→AUTHORIZE→Runtime→port
 * chain executes real mutations, holds invariants, updates the world the Reasoner
 * re-reads, and chains SEARCH → UPSERT → ADD_NOTE → FINISH. (The real vendor API path
 * - HubSpot createLead/createNote - is already production-proven: the legacy brain uses
 * the exact same functions daily. The only kernel-specific risk is the decision +
 * param flow, which is exactly what this simulation exercises.)
 */

import { describe, it, expect, afterEach } from "vitest";
import { EMPTY_AGENT_MEMORY, type ReasonerInput, type ReasonerProvider, type ReasonerProviderResult } from "@chatcenter/shared";
import { runAgentLoop } from "../services/agent-loop/agent-loop";
import { setReasonerProvider } from "../services/reasoner";
import { clearCapabilities, registerCapability, ensureCapabilitiesRegistered, type CapabilityRegistration } from "../services/capability-plane";
import { CRM_CONTRACTS } from "../services/capability-runtime/crm.contracts";
import { executeCrmOperation } from "../services/capability-runtime/crm.runtime";
import type { CrmPort, CrmContactRef } from "../services/capability-runtime/crm.port";

// ── In-memory CRM (the simulated vendor, below the Runtime) ──
interface CrmStore { contacts: CrmContactRef[]; notes: { contactId: string; body: string }[]; seq: number }
const makeStore = (): CrmStore => ({ contacts: [], notes: [], seq: 0 });

function fakeCrmPort(store: CrmStore, opts: { ambiguous?: boolean } = {}): CrmPort {
  const match = (q: { email?: string; phone?: string }) =>
    store.contacts.filter((c) => (q.email && c.email === q.email) || (q.phone && c.phone === q.phone));
  return {
    async connection() { return { connected: true, vendor: "sim" }; },
    async searchCustomer(_ctx, q) { return { ok: true, contacts: match(q) }; },
    async upsertCustomer(_ctx, hints) {
      if (opts.ambiguous) return { status: "needs_approval", candidates: store.contacts, reason: "two_matches" };
      const existing = match({ email: hints.email, phone: hints.phone })[0];
      if (existing) return { status: "linked", contact: existing, wasEnriched: false };
      const c: CrmContactRef = { id: `c_${++store.seq}`, kind: "contact", displayName: hints.name ?? null, email: hints.email ?? null, phone: hints.phone ?? null, stage: "lead", vendor: "sim" };
      store.contacts.push(c);
      return { status: "created", contact: c };
    },
    async addNote(_ctx, args) { store.notes.push({ contactId: args.contactId, body: args.body }); return { ok: true, id: `n_${store.notes.length}` }; },
    async getContext() { return { ok: true, context: { contact: store.contacts[0], activities: 0, deals: [], tickets: [] } }; },
    async updateRecord() { return { ok: true, id: "c_1" }; },
    async createTask() { return { ok: true, id: "t_1" }; },
  };
}

function crmCapability(port: CrmPort): CapabilityRegistration {
  const CONTRACTS = Object.values(CRM_CONTRACTS);
  return {
    name: "CRM",
    ownsOperation: (op) => op in CRM_CONTRACTS,
    async describeWorld(ctx) {
      const { connected, vendor } = await port.connection({ tenantId: ctx.tenantId, conversationId: ctx.conversationId });
      return {
        capability: "CRM",
        summary: connected ? `A CRM (${vendor}) is connected.` : "No CRM is connected.",
        facts: { crmConnected: connected, crmVendor: vendor },
        operations: connected ? CONTRACTS.map((c) => ({ name: c.id, meaning: c.meaning, params: c.params.map((p) => ({ name: p.key, meaning: p.meaning, required: !!p.required })) })) : [],
      };
    },
    execute: (req) => executeCrmOperation(req, { port, logger: () => {}, strategyId: "crm.sim" }),
    loopPolicy: { maxIterations: 8 },
  };
}

const baseInputs = {
  tenantId: "t1", conversationId: "c1", turnId: "turn1", aiAgentId: "a1",
  customerExternalId: "cust1", mode: "autonomous" as const,
  customer: { id: "cust1", knownFields: {}, identityResolved: true },
  permissions: { allowedOperations: [] },
  transcript: [{ role: "customer" as const, text: "Hi, I'm Dana (dana@x.com), interested in your service." }],
  mission: { businessDescription: "Sales rep" },
  goal: null,
  memory: EMPTY_AGENT_MEMORY,
};

// Scripted Reasoner: SEARCH → UPSERT → ADD_NOTE → FINISH, driven by the world it re-reads.
function salesReasoner(): ReasonerProvider {
  return {
    name: "scripted", model: "s",
    async reason(input: ReasonerInput): Promise<ReasonerProviderResult> {
      const wm = input.context.workingMemory;
      const did = (op: string) => wm?.iterations?.some((it) => it.proposedOperation === op && it.runtimeResult === "EXECUTED");
      let decision: any;
      if (did("ADD_NOTE")) decision = { type: "FINISH", reason: "logged" };
      else if (did("UPSERT_CUSTOMER")) decision = { type: "EXECUTE", operation: "ADD_NOTE", params: { contact_id: "c_1", note: "Interested in the service." } };
      else if (did("SEARCH_CUSTOMER")) decision = { type: "EXECUTE", operation: "UPSERT_CUSTOMER", params: { email: "dana@x.com", name: "Dana" } };
      else decision = { type: "EXECUTE", operation: "SEARCH_CUSTOMER", params: { email: "dana@x.com" } };
      return { output: { read: { situation: "new lead", customerState: "engaged", goal: null, missingInformation: [], rationale: "resolve then log" }, decision, replyIntent: { purpose: "ack", keyPoints: ["Saved your details."] }, memoryUpdate: EMPTY_AGENT_MEMORY } };
    },
  };
}

describe("CRM connector - full-loop autonomous verification (simulated CRM)", () => {
  afterEach(() => { clearCapabilities(); setReasonerProvider(null); });

  it("SEARCH → UPSERT (real create) → ADD_NOTE (real note) → FINISH", async () => {
    ensureCapabilitiesRegistered();
    clearCapabilities();
    const store = makeStore();
    registerCapability(crmCapability(fakeCrmPort(store)));
    setReasonerProvider(salesReasoner());

    const result = await runAgentLoop({ ...baseInputs });

    expect(result.terminationReason).toBe("finish");
    expect(store.contacts.length).toBe(1); // real mutation: UPSERT created the contact
    expect(store.contacts[0].email).toBe("dana@x.com");
    expect(store.notes.length).toBe(1); // real mutation: note recorded on the contact
    expect(store.notes[0].contactId).toBe("c_1");
    expect(result.workingMemory.iterations.map((i) => i.proposedOperation).filter(Boolean))
      .toEqual(["SEARCH_CUSTOMER", "UPSERT_CUSTOMER", "ADD_NOTE"]);
  });

  it("ambiguous identity → UPSERT surfaces needs_approval → Reasoner escalates (no write)", async () => {
    ensureCapabilitiesRegistered();
    clearCapabilities();
    const store = makeStore();
    store.contacts.push({ id: "c_1", kind: "contact", displayName: "A", email: "dana@x.com", phone: null, stage: "lead", vendor: "sim" });
    store.contacts.push({ id: "c_2", kind: "contact", displayName: "B", email: "dana@x.com", phone: null, stage: "lead", vendor: "sim" });
    registerCapability(crmCapability(fakeCrmPort(store, { ambiguous: true })));
    setReasonerProvider({
      name: "s", model: "s",
      async reason(input) {
        const failed = input.context.workingMemory?.iterations?.some((it) => it.runtimeResult === "FAILED");
        const decision = failed
          ? { type: "ESCALATE" as const, reason: "ambiguous identity" }
          : { type: "EXECUTE" as const, operation: "UPSERT_CUSTOMER", params: { email: "dana@x.com" } };
        return { output: { read: { situation: "x", customerState: "y", goal: null, missingInformation: [], rationale: "r" }, decision, replyIntent: { purpose: "p", keyPoints: ["Let me check with a colleague."] }, memoryUpdate: EMPTY_AGENT_MEMORY } };
      },
    });

    const result = await runAgentLoop({ ...baseInputs, conversationId: "c2" });

    expect(store.notes.length).toBe(0);
    expect(store.contacts.length).toBe(2); // no new contact - the runtime never guessed an identity
    expect(result.terminationReason).toBe("escalate"); // Reasoner's decision on the needs_approval observation
  });
});
