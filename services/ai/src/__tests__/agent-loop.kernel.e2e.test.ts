/**
 * KERNEL END-TO-END - one AI Employee completes real Calendar work through the
 * full cognitive loop, WITHOUT bypassing the Capability Runtime and WITHOUT an
 * LLM key.
 *
 * What this proves (the whole point of the first milestone):
 *   Work Item → Oracle → Reason → Propose → Guardrails(Runtime invariants/approval)
 *   → Capability Runtime (REAL resolveExecution) → Observation → Oracle refresh
 *   → Reason again → … → FINISH → Writer → reply.
 *
 * Method: the Reasoner is scripted (via setReasonerProvider) so the test is
 * deterministic, but it reasons FROM the live Facts + observations (it only books
 * AFTER it observes availability, and only finishes AFTER the Oracle refresh shows
 * the booking exists) - proving observations genuinely re-enter the loop and that
 * there is NO predetermined execution chain. Execution goes through the real
 * calendar contracts + resolver over an in-memory port (no network, no Prisma
 * writes to the outside world).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  EMPTY_AGENT_MEMORY,
  type OperationContract,
  type AvailableOperation,
  type CapabilityWorldView,
  type ReasonerInput,
  type ReasonerProvider,
  type ReasonerProviderResult,
} from "@chatcenter/shared";
import { CALENDAR_CONTRACTS } from "../services/capability-runtime/calendar.contracts";
import { runAgentLoop } from "../services/agent-loop/agent-loop";
import { setReasonerProvider } from "../services/reasoner";
import {
  clearCapabilities,
  registerCapability,
  ensureCapabilitiesRegistered,
  type CapabilityRegistration,
} from "../services/capability-plane";
import { executeCalendarOperation } from "../services/capability-runtime/calendar.runtime";
import type { CalendarPort, CalendarBookingRef, ResolvedMeetingKind } from "../services/capability-runtime/calendar.port";

const DEMO = { slug: "demo", durationMinutes: 30 };
const SLOT = "2026-07-02T15:00:00.000Z";

// ── In-memory calendar (the provider, below the Runtime - invisible to cognition) ──
function fakePort(open: string[]): { port: CalendarPort; bookings: CalendarBookingRef[] } {
  const bookings: CalendarBookingRef[] = [];
  const openSet = new Set(open);
  const kind: ResolvedMeetingKind = DEMO;
  let n = 1;
  const port: CalendarPort = {
    listActiveBookings: async () => bookings.slice(),
    resolveMeetingKind: async () => kind,
    isTimeOpen: async (_c, iso) => openSet.has(iso),
    computeAvailability: async () => ({ slotsIso: [...openSet] }),
    createEvent: async (_c, { iso, kind: k }) => {
      if (!openSet.has(iso)) throw new Error("time_taken");
      const start = Date.parse(iso);
      const ref: CalendarBookingRef = { eventId: `ev_${n++}`, startMs: start, endMs: start + k.durationMinutes * 60_000, meetingKind: k.slug, joinUrl: "https://meet/x" };
      bookings.push(ref);
      openSet.delete(iso);
      return ref;
    },
    moveEvent: async (_c, { booking, iso }) => {
      const i = bookings.findIndex((b) => b.eventId === booking.eventId);
      bookings[i] = { ...bookings[i], startMs: Date.parse(iso) };
      return bookings[i];
    },
    cancelEvent: async (_c, { booking }) => {
      const i = bookings.findIndex((b) => b.eventId === booking.eventId);
      if (i >= 0) bookings.splice(i, 1);
    },
  };
  return { port, bookings };
}

function toAvailableOperation(c: OperationContract): AvailableOperation {
  return { name: c.id, meaning: c.meaning, params: c.params.map((p) => ({ name: p.key, meaning: p.meaning, required: !!p.required })) };
}

// A Calendar capability backed by the in-memory port but routed through the REAL
// runtime - identical shape to the production CalendarCapability, injected port.
function fakeCalendarCapability(port: CalendarPort): CapabilityRegistration {
  const CONTRACTS = Object.values(CALENDAR_CONTRACTS);
  return {
    name: "CALENDAR",
    ownsOperation: (op) => op in CALENDAR_CONTRACTS,
    async execute(req) {
      return executeCalendarOperation(req, { port, logger: () => {} });
    },
    async describeWorld(ctx): Promise<CapabilityWorldView> {
      const bookings = await port.listActiveBookings({
        tenantId: ctx.tenantId, conversationId: ctx.conversationId,
        aiAgentId: ctx.aiAgentId, customerExternalId: ctx.customerExternalId, customerEmail: ctx.customerEmail,
      });
      const first = bookings[0];
      const activeBooking = first ? { when: new Date(first.startMs).toISOString(), ref: first.eventId } : null;
      return {
        capability: "CALENDAR",
        summary: activeBooking ? `Booked for ${activeBooking.when}.` : "Connected; no booking yet.",
        facts: { calendarConnected: true, bookable: true, activeBooking },
        operations: CONTRACTS.map(toAvailableOperation),
      };
    },
    loopPolicy: { maxIterations: 6 },
  };
}

// ── Scripted Reasoner: reasons FROM live facts + observations, not a fixed chain ──
function scriptedReasoner(calls: { n: number }): ReasonerProvider {
  return {
    name: "scripted",
    model: "scripted-1",
    async reason(input: ReasonerInput): Promise<ReasonerProviderResult> {
      calls.n++;
      const f = input.facts;
      const wm = input.context.workingMemory;
      const alreadyChecked = !!wm?.iterations?.some((it) => it.proposedOperation === "CHECK_AVAILABILITY");

      // Read the calendar world GENERICALLY (no hardcoded fact shape in the kernel).
      const cal = f.world.find((w) => w.capability === "CALENDAR");
      const alreadyBooked = !!(cal?.facts as any)?.activeBooking;

      let decision;
      if (alreadyBooked) {
        // Oracle refresh shows the booking exists → the task is done.
        decision = { type: "FINISH" as const, reason: "meeting is booked" };
      } else if (alreadyChecked) {
        // Observed availability last turn → now commit the booking.
        decision = { type: "EXECUTE" as const, operation: "BOOK_MEETING", params: { desired_time: SLOT } };
      } else {
        // First: find out whether there is availability (a read).
        decision = { type: "EXECUTE" as const, operation: "CHECK_AVAILABILITY", params: {} };
      }

      return {
        output: {
          read: { situation: "customer wants a demo", customerState: "ready", goal: "booking", missingInformation: [], rationale: "drive to booking" },
          decision,
          replyIntent: { purpose: "confirm", keyPoints: [`Your demo is booked for ${SLOT}.`] },
          memoryUpdate: EMPTY_AGENT_MEMORY,
        },
        usage: { provider: "scripted", model: "scripted-1", inputTokens: 10, outputTokens: 5, latencyMs: 1 },
      };
    },
  };
}

describe("Cognitive kernel E2E - one employee books a meeting through the full loop", () => {
  beforeEach(() => {
    ensureCapabilitiesRegistered(); // set the registered flag (registers prod caps)
    clearCapabilities(); // …then swap in the in-memory calendar for hermetic test
  });
  afterEach(() => {
    clearCapabilities();
    setReasonerProvider(null);
  });

  it("check availability → book → finish, reasoning after every observation", async () => {
    const { port, bookings } = fakePort([SLOT]);
    registerCapability(fakeCalendarCapability(port));
    const calls = { n: 0 };
    setReasonerProvider(scriptedReasoner(calls));

    const result = await runAgentLoop({
      tenantId: "t1",
      conversationId: "c1",
      turnId: "turn1",
      aiAgentId: "a1",
      customerExternalId: "cust1",
      customerEmail: "a@b.com",
      mode: "autonomous",
      customer: { id: "cust1", knownFields: { email: "a@b.com" }, identityResolved: true },
      permissions: { allowedOperations: [] }, // empty = no RBAC filter → full menu
      transcript: [{ role: "customer", text: "book me a demo tomorrow at 3pm" }],
      mission: { businessDescription: "Sales rep" },
      goal: "booking",
      memory: EMPTY_AGENT_MEMORY,
    });

    // The loop terminated because the REASONER decided it was done (not a guard).
    expect(result.terminationReason).toBe("finish");
    // Three ticks: CHECK → BOOK → FINISH. Reasoning ran after every observation.
    expect(result.iterations).toBe(3);
    expect(calls.n).toBe(3);
    // Real world-state mutation happened through the REAL Capability Runtime.
    expect(bookings.length).toBe(1);
    expect(bookings[0].startMs).toBe(Date.parse(SLOT));
    // The Writer produced the single customer-facing message.
    expect(result.reply && result.reply.length).toBeTruthy();
    // The employee actually did the two operations, in the order the reasoner chose.
    const ops = result.workingMemory.iterations.map((i) => i.proposedOperation).filter(Boolean);
    expect(ops).toEqual(["CHECK_AVAILABILITY", "BOOK_MEETING"]);
  });

  it("guardrails: an unauthorized operation is DENIED before the Runtime (no mutation)", async () => {
    const { port, bookings } = fakePort([SLOT]);
    registerCapability(fakeCalendarCapability(port));
    // Reasoner tries to book; permissions only allow CHECK_AVAILABILITY, so the
    // menu excludes BOOK_MEETING and AUTHORIZE denies it - it never reaches the Runtime.
    const scripted: ReasonerProvider = {
      name: "scripted", model: "s",
      async reason(input) {
        const wm = input.context.workingMemory;
        const deniedBook = !!wm?.iterations?.some((it) => it.proposedOperation === "BOOK_MEETING");
        const decision = deniedBook
          ? { type: "FINISH" as const, reason: "cannot book - not permitted" }
          : { type: "EXECUTE" as const, operation: "BOOK_MEETING", params: { desired_time: SLOT } };
        return {
          output: {
            read: { situation: "x", customerState: "y", goal: "booking", missingInformation: [], rationale: "r" },
            decision, replyIntent: { purpose: "p", keyPoints: ["I can't book that right now."] }, memoryUpdate: EMPTY_AGENT_MEMORY,
          },
        };
      },
    };
    setReasonerProvider(scripted);

    const result = await runAgentLoop({
      tenantId: "t1", conversationId: "c3", turnId: "turn3", aiAgentId: "a1",
      customerExternalId: "cust1", customerEmail: "a@b.com", mode: "autonomous",
      customer: { id: "cust1", knownFields: { email: "a@b.com" }, identityResolved: true },
      permissions: { allowedOperations: ["CHECK_AVAILABILITY"] }, // BOOK not permitted
      transcript: [{ role: "customer", text: "book me a demo" }],
      mission: { businessDescription: "Sales rep" }, goal: "booking", memory: EMPTY_AGENT_MEMORY,
    });

    expect(bookings.length).toBe(0); // denied before the Runtime - no mutation
    const denied = result.workingMemory.iterations.find((i) => i.proposedOperation === "BOOK_MEETING");
    expect(denied?.runtimeResult).toBe("DENIED");
    expect(result.terminationReason).toBe("finish");
  });

  it("copilot mode: the SAME loop recommends instead of executing (no mutation)", async () => {
    const { port, bookings } = fakePort([SLOT]);
    registerCapability(fakeCalendarCapability(port));
    setReasonerProvider(scriptedReasoner({ n: 0 }));

    const result = await runAgentLoop({
      tenantId: "t1", conversationId: "c2", turnId: "turn2", aiAgentId: "a1",
      customerExternalId: "cust1", customerEmail: "a@b.com",
      mode: "advisory", // <-- the ONLY difference
      customer: { id: "cust1", knownFields: { email: "a@b.com" }, identityResolved: true },
      permissions: { allowedOperations: [] },
      transcript: [{ role: "customer", text: "book me a demo tomorrow at 3pm" }],
      mission: { businessDescription: "Sales rep" },
      goal: "booking",
      memory: EMPTY_AGENT_MEMORY,
    });

    // Advisory mode: the write operation is RECOMMENDED, never executed → no booking.
    expect(bookings.length).toBe(0);
    expect(result.reply && result.reply.length).toBeTruthy();
  });

  it("ownership: a human takeover between iterations supersedes the loop - no reply, no further execution", async () => {
    const { port, bookings } = fakePort([SLOT]);
    registerCapability(fakeCalendarCapability(port));
    setReasonerProvider(scriptedReasoner({ n: 0 }));

    // Probe call order: it1 pre-EXECUTE(CHECK) → it2 pre-reason. The human
    // takes over after iteration 1 completes, so the second probe says "gone".
    let probes = 0;
    const ownershipCheck = async () => ++probes < 2;

    const result = await runAgentLoop({
      tenantId: "t1", conversationId: "c3", turnId: "turn3", aiAgentId: "a1",
      customerExternalId: "cust1", customerEmail: "a@b.com",
      mode: "autonomous",
      customer: { id: "cust1", knownFields: { email: "a@b.com" }, identityResolved: true },
      permissions: { allowedOperations: [] },
      transcript: [{ role: "customer", text: "book me a demo tomorrow at 3pm" }],
      mission: { businessDescription: "Sales rep" },
      goal: "booking",
      memory: EMPTY_AGENT_MEMORY,
      ownershipCheck,
    });

    expect(result.terminationReason).toBe("superseded");
    // Stood down BEFORE the booking write - only the availability read ran.
    expect(bookings.length).toBe(0);
    // A superseded loop must stay silent: the human is talking now.
    expect(result.reply).toBeNull();
  });

  it("ownership: takeover caught by the final pre-EXECUTE probe - the write never reaches the Runtime", async () => {
    const { port, bookings } = fakePort([SLOT]);
    registerCapability(fakeCalendarCapability(port));
    setReasonerProvider(scriptedReasoner({ n: 0 }));

    // Probe call order: it1 pre-EXECUTE(CHECK) ok → it2 pre-reason ok →
    // it2 pre-EXECUTE(BOOK) → human owns it now.
    let probes = 0;
    const ownershipCheck = async () => ++probes < 3;

    const result = await runAgentLoop({
      tenantId: "t1", conversationId: "c4", turnId: "turn4", aiAgentId: "a1",
      customerExternalId: "cust1", customerEmail: "a@b.com",
      mode: "autonomous",
      customer: { id: "cust1", knownFields: { email: "a@b.com" }, identityResolved: true },
      permissions: { allowedOperations: [] },
      transcript: [{ role: "customer", text: "book me a demo tomorrow at 3pm" }],
      mission: { businessDescription: "Sales rep" },
      goal: "booking",
      memory: EMPTY_AGENT_MEMORY,
      ownershipCheck,
    });

    expect(result.terminationReason).toBe("superseded");
    expect(bookings.length).toBe(0); // the BOOK write was aborted at the last gate
    expect(result.reply).toBeNull();
  });

  it("OPERATION_STATUS enforcement: an unproven op in an autonomous turn dry-runs (no mutation)", async () => {
    // A capability owning an operation the migration ledger has NOT proven
    // autonomous (UPSERT_CUSTOMER is "shadow"). The scripted reasoner proposes
    // it in a real autonomous turn - the loop must downgrade the execution to
    // dry_run: RECOMMENDED, never executed.
    const writes = { n: 0 };
    registerCapability({
      name: "CRM",
      ownsOperation: (op) => op === "UPSERT_CUSTOMER",
      async describeWorld(): Promise<CapabilityWorldView> {
        return {
          capability: "CRM",
          summary: "CRM connected.",
          facts: { crmConnected: true },
          operations: [{ name: "UPSERT_CUSTOMER", meaning: "create or update the CRM record", params: [] }],
        };
      },
      async execute(req) {
        if (req.mode === "autonomous") writes.n++;
        return {
          result: req.mode === "autonomous"
            ? { status: "EXECUTED", outcome: "wrote CRM" }
            : { status: "RECOMMENDED", proposal: { operation: req.operation, params: req.params } },
          trace: { operation: req.operation, capability: "CRM", mode: req.mode, invariants: [], optimizations: [], executed: req.mode === "autonomous", result: req.mode === "autonomous" ? "EXECUTED" : "RECOMMENDED" },
        } as any;
      },
    });
    setReasonerProvider({
      name: "scripted",
      model: "scripted-1",
      async reason(input: ReasonerInput): Promise<ReasonerProviderResult> {
        const tried = input.context.workingMemory?.iterations?.some((it) => it.proposedOperation === "UPSERT_CUSTOMER");
        return {
          output: {
            read: { situation: "s", customerState: "c", goal: "crm_contact", missingInformation: [], rationale: "r" },
            decision: tried
              ? { type: "FINISH" as const, reason: "recorded recommendation" }
              : { type: "EXECUTE" as const, operation: "UPSERT_CUSTOMER", params: { email: "a@b.com" } },
            replyIntent: { purpose: "confirm", keyPoints: ["done"] },
            memoryUpdate: EMPTY_AGENT_MEMORY,
          },
          usage: { provider: "scripted", model: "scripted-1", inputTokens: 5, outputTokens: 3, latencyMs: 1 },
        };
      },
    });

    const result = await runAgentLoop({
      tenantId: "t1", conversationId: "c6", turnId: "turn6", aiAgentId: "a1",
      customerExternalId: "cust1", customerEmail: "a@b.com",
      mode: "autonomous",
      customer: { id: "cust1", knownFields: { email: "a@b.com" }, identityResolved: true },
      permissions: { allowedOperations: [] },
      transcript: [{ role: "customer", text: "save my details" }],
      mission: { businessDescription: "CRM keeper" },
      goal: "crm_contact",
      memory: EMPTY_AGENT_MEMORY,
      // Production injects the OPERATION_STATUS ledger; here we simulate an
      // op not yet proven autonomous so the loop downgrades it to dry_run.
      operationExecutionMode: (op, mode) => (op === "UPSERT_CUSTOMER" ? "dry_run" : mode),
    });

    expect(writes.n).toBe(0); // never executed autonomously - ledger says shadow
    const attempt = result.workingMemory.iterations.find((i) => i.proposedOperation === "UPSERT_CUSTOMER");
    expect(attempt?.runtimeResult).toBe("RECOMMENDED");
    expect(result.terminationReason).toBe("finish");
  });

  it("ownership: probe errors fail open - the loop completes normally", async () => {
    const { port, bookings } = fakePort([SLOT]);
    registerCapability(fakeCalendarCapability(port));
    setReasonerProvider(scriptedReasoner({ n: 0 }));

    const result = await runAgentLoop({
      tenantId: "t1", conversationId: "c5", turnId: "turn5", aiAgentId: "a1",
      customerExternalId: "cust1", customerEmail: "a@b.com",
      mode: "autonomous",
      customer: { id: "cust1", knownFields: { email: "a@b.com" }, identityResolved: true },
      permissions: { allowedOperations: [] },
      transcript: [{ role: "customer", text: "book me a demo tomorrow at 3pm" }],
      mission: { businessDescription: "Sales rep" },
      goal: "booking",
      memory: EMPTY_AGENT_MEMORY,
      ownershipCheck: async () => { throw new Error("probe transport down"); },
    });

    expect(result.terminationReason).toBe("finish");
    expect(bookings.length).toBe(1); // fail-open: a flaky probe never kills a healthy turn
    expect(result.reply && result.reply.length).toBeTruthy();
  });
});
