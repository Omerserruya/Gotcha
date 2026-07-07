/**
 * LOOP-REPLAY-BATCH — populate the loop-eval corpus with REALISTIC loop behavior.
 *
 * Runs the UNCHANGED loop in AUTONOMOUS mode over N real historical transcripts, but
 * with SIMULATED in-memory connectors (calendar + CRM). Autonomous = writes EXECUTE, so
 * the simulated world UPDATES and the loop progresses exactly as it would in production —
 * without the advisory-shadow artifact (dry-run writes → world never updates → the loop
 * re-proposes the same write until max_iterations). Zero real side effects: every write
 * lands in an in-memory store that is discarded. The Reasoner is the REAL LLM.
 *
 * Each run persists agent_loop_runs/_iterations (mode=autonomous); analyze with loop-eval.
 *
 *   ... npx tsx scripts/loop-replay-batch.ts [N=40]
 */
import { prisma } from "@chatcenter/shared";
import { CALENDAR_CONTRACTS } from "../src/services/capability-runtime/calendar.contracts";
import { initAIService } from "../src/services/ai.service";
import { runAgentLoopForBotTurn } from "../src/services/agent-loop/bot-loop-adapter";
import { executeCalendarOperation } from "../src/services/capability-runtime/calendar.runtime";
import type { CalendarPort } from "../src/services/capability-runtime/calendar.port";
import { CRM_CONTRACTS } from "../src/services/capability-runtime/crm.contracts";
import { executeCrmOperation } from "../src/services/capability-runtime/crm.runtime";
import type { CrmPort } from "../src/services/capability-runtime/crm.port";
import {
  ensureCapabilitiesRegistered, clearCapabilities, registerCapability, type CapabilityRegistration,
} from "../src/services/capability-plane";

const TENANT_ID = process.env.PILOT_TENANT_ID || "cmmov5qh10000ltnqm7pmxqzc";
const AGENT_ID = "cm5aabb73f8d574c5b909ca1e9fcd6a142";

// ── Simulated calendar (happy-path, world-updating) ──
function simCalendarPort(store: { bookings: any[]; seq: number }): CalendarPort {
  const KIND = { slug: "discovery_call", durationMinutes: 30 };
  const slots = () => {
    const base = Date.parse("2026-07-06T09:00:00.000Z");
    return [0, 1, 2].map((d) => new Date(base + d * 3600_000).toISOString());
  };
  return {
    async listActiveBookings() { return store.bookings.map((b) => ({ eventId: b.eventId, startMs: b.startMs, endMs: b.startMs + 1800_000, meetingKind: "discovery_call" })); },
    async resolveMeetingKind() { return KIND; },
    async agentTimezone() { return "Asia/Jerusalem"; },
    async isTimeOpen(_c, iso) { return !store.bookings.some((b) => Math.abs(b.startMs - Date.parse(iso)) < 60000); },
    async computeAvailability(_c, _k, window) { const anchor = window?.fromIso ? Date.parse(window.fromIso) : NaN; if (Number.isFinite(anchor)) return { slotsIso: [0, 1, 2].map((d) => new Date(anchor + d * 3600000).toISOString()) }; return { slotsIso: slots() }; },
    async createEvent(_c, { iso }) { const b = { eventId: `ev_${++store.seq}`, startMs: Date.parse(iso) }; store.bookings.push(b); return { eventId: b.eventId, startMs: b.startMs, endMs: b.startMs + 1800_000, meetingKind: "discovery_call" }; },
    async moveEvent(_c, { iso }) { const b = store.bookings[0]; if (b) b.startMs = Date.parse(iso); return { eventId: b?.eventId ?? "ev_x", startMs: Date.parse(iso), endMs: Date.parse(iso) + 1800_000, meetingKind: "discovery_call" }; },
    async cancelEvent() { store.bookings.shift(); },
  };
}
function simCrmPort(store: { contacts: any[]; notes: any[]; seq: number }): CrmPort {
  const find = (q: any) => store.contacts.filter((c) => (q.email && c.email === q.email) || (q.phone && c.phone === q.phone));
  return {
    async connection() { return { connected: true, vendor: "sim" }; },
    async searchCustomer(_c, q) { return { ok: true, contacts: find(q) }; },
    async upsertCustomer(_c, hints) {
      const ex = find(hints)[0];
      if (ex) return { status: "linked", contact: ex, wasEnriched: false };
      const c = { id: `c_${++store.seq}`, kind: "contact", displayName: hints.name ?? null, email: hints.email ?? null, phone: hints.phone ?? null, stage: "lead", vendor: "sim" };
      store.contacts.push(c); return { status: "created", contact: c };
    },
    async addNote(_c, args) { store.notes.push(args); return { ok: true, id: `n_${store.notes.length}` }; },
  };
}
function toOps(contracts: any) { return Object.values(contracts).map((c: any) => ({ name: c.id, meaning: c.meaning, params: c.params.map((p: any) => ({ name: p.key, meaning: p.meaning, required: !!p.required })) })); }

function registerSimWorld() {
  const cal = { bookings: [] as any[], seq: 0 };
  const crm = { contacts: [] as any[], notes: [] as any[], seq: 0 };
  const calPort = simCalendarPort(cal), crmPort = simCrmPort(crm);
  const calCap: CapabilityRegistration = {
    name: "CALENDAR", ownsOperation: (op) => op in CALENDAR_CONTRACTS,
    async describeWorld(ctx) {
      const b = cal.bookings[0];
      return { capability: "CALENDAR", summary: (b ? `A meeting is booked for ${new Date(b.startMs).toISOString()}.` : "Calendar is connected and bookable; no meeting booked yet.") + " The agent's timezone is Asia/Jerusalem.", facts: { calendarConnected: true, bookable: true, activeBooking: b ? { when: new Date(b.startMs).toISOString(), ref: b.eventId } : null, agentTimezone: "Asia/Jerusalem" }, operations: toOps(CALENDAR_CONTRACTS) };
    },
    execute: (req) => executeCalendarOperation(req, { port: calPort, logger: () => {}, strategyId: "sim.cal" }),
    loopPolicy: { maxIterations: 8 },
  };
  const crmCap: CapabilityRegistration = {
    name: "CRM", ownsOperation: (op) => op in CRM_CONTRACTS,
    async describeWorld() { return { capability: "CRM", summary: "A CRM (sim) is connected.", facts: { crmConnected: true, crmVendor: "sim" }, operations: toOps(CRM_CONTRACTS) }; },
    execute: (req) => executeCrmOperation(req, { port: crmPort, logger: () => {}, strategyId: "sim.crm" }),
  };
  clearCapabilities();
  registerCapability(calCap);
  registerCapability(crmCap);
}

async function main() {
  const N = Number(process.argv[2] || "40");
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY required");
  initAIService({ apiKey: process.env.OPENAI_API_KEY });
  ensureCapabilitiesRegistered(); // sets the module `registered` flag so the loop won't re-add prod capabilities

  // Real historical conversations for the pilot agent that have a customer message.
  const convs: any[] = await prisma.conversation.findMany({
    where: { tenantId: TENANT_ID, assignedAiAgentId: AGENT_ID, messages: { some: { direction: "INBOUND" } } },
    orderBy: { createdAt: "desc" }, take: N, select: { id: true },
  });
  console.log(`\n=== LOOP-REPLAY-BATCH (autonomous over simulated connectors) === N=${convs.length}\n`);

  let ok = 0, err = 0;
  for (const [i, c] of convs.entries()) {
    const lastInbound = await prisma.message.findFirst({ where: { conversationId: c.id, tenantId: TENANT_ID, direction: "INBOUND" }, orderBy: { createdAt: "desc" }, select: { body: true } });
    const incoming = lastInbound?.body?.trim();
    if (!incoming) continue;
    try {
      registerSimWorld(); // fresh simulated world per conversation
      const r = await runAgentLoopForBotTurn({ tenantId: TENANT_ID, conversationId: c.id, aiAgentId: AGENT_ID, incomingMessage: incoming }, "autonomous");
      ok++;
      console.log(`[${i + 1}/${convs.length}] ${c.id} term=${(r as any)?.escalation ? "escalate" : "ok"} — "${incoming.slice(0, 45)}"`);
    } catch (e: any) {
      err++;
      console.log(`[${i + 1}/${convs.length}] ${c.id} ERROR: ${String(e?.message || e).slice(0, 100)}`);
    }
  }
  console.log(`\nDONE: ${ok} ok, ${err} errors. Analyze with: npx tsx scripts/loop-eval.ts 1 autonomous`);
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error("BATCH FAILED:", e); await prisma.$disconnect(); process.exit(1); });
