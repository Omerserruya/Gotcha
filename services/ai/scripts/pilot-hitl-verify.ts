/**
 * LIVE HITL VERIFICATION — proves the kernel approval gate end-to-end against the
 * REAL policy stack + REAL DB (approval_requests), with a simulated calendar port so
 * no external write can occur. Three checks:
 *   1. 90-min meeting (schedule_meeting policy: on_condition duration>60) →
 *      autonomous BOOK stops at AWAITING_APPROVAL, a REAL ApprovalRequest row exists,
 *      and NO event was created.
 *   2. Re-proposing the same BOOK while PENDING → reuses the SAME request (no dup).
 *   3. 30-min meeting → ALLOW → BOOK executes (parity with legacy auto-run).
 * Cleans up the created approval rows.
 */
import { prisma } from "@chatcenter/shared";
import { executeCalendarOperation } from "../src/services/capability-runtime/calendar.runtime";
import type { CalendarPort } from "../src/services/capability-runtime/calendar.port";
import type { ExecutionRequest } from "@chatcenter/shared";

const TENANT_ID = "cmmov5qh10000ltnqm7pmxqzc";
const CONV_ID = "hitl-verify-conv";
const SLOT = "2026-07-08T09:00:00.000Z";

function simPort(durationMinutes: number): { port: CalendarPort; store: { bookings: any[] } } {
  const store = { bookings: [] as any[] };
  const port: CalendarPort = {
    async listActiveBookings() { return store.bookings; },
    async resolveMeetingKind() { return { slug: "long_call", durationMinutes }; },
    async agentTimezone() { return "Asia/Jerusalem"; },
    async isTimeOpen() { return true; },
    async computeAvailability() { return { slotsIso: [SLOT] }; },
    async createEvent(_c, { iso }) { const b = { eventId: `ev_hitl`, startMs: Date.parse(iso), endMs: Date.parse(iso) + durationMinutes * 60000, meetingKind: "long_call" }; store.bookings.push(b); return b; },
    async moveEvent() { throw new Error("unused"); },
    async cancelEvent() { store.bookings.shift(); },
  };
  return { port, store };
}

const req = (): ExecutionRequest => ({
  operation: "BOOK_MEETING",
  params: { desired_time: SLOT, meeting_type: "long_call", email: "hitl-verify@example.com" },
  context: { tenantId: TENANT_ID, conversationId: CONV_ID, aiAgentId: "hitl-verify-agent", customerEmail: "hitl-verify@example.com" },
  mode: "autonomous",
});

async function cleanup() {
  await (prisma as any).approvalRequest.deleteMany({ where: { tenantId: TENANT_ID, conversationId: CONV_ID } }).catch(() => {});
}

async function main() {
  await cleanup();
  console.log(`\n=== LIVE HITL VERIFY (real policy stack + real approval_requests; simulated calendar) ===\n`);

  // 1. 90-minute meeting → on_condition duration>60 → approval required, no event.
  const long = simPort(90);
  const r1 = await executeCalendarOperation(req(), { port: long.port, strategyId: "hitl-verify", logger: () => {} });
  const rows1: any[] = await (prisma as any).approvalRequest.findMany({ where: { tenantId: TENANT_ID, conversationId: CONV_ID, status: "PENDING" } });
  console.log(`1) BOOK 90min → ${r1.result.status} ref=${(r1.result as any).ref ?? "-"}`);
  console.log(`   approval rows: ${rows1.length} (tool=${rows1[0]?.tool}, requestedBy=${rows1[0]?.requestedBy})`);
  console.log(`   events created: ${long.store.bookings.length} (expect 0)`);
  const ok1 = r1.result.status === "AWAITING_APPROVAL" && rows1.length === 1 && (r1.result as any).ref === rows1[0].id && long.store.bookings.length === 0;

  // 2. Re-propose while PENDING → same ref, still one row.
  const r2 = await executeCalendarOperation(req(), { port: long.port, strategyId: "hitl-verify", logger: () => {} });
  const rows2: any[] = await (prisma as any).approvalRequest.findMany({ where: { tenantId: TENANT_ID, conversationId: CONV_ID, status: "PENDING" } });
  console.log(`\n2) re-BOOK while PENDING → ${r2.result.status} ref=${(r2.result as any).ref ?? "-"}  rows=${rows2.length} (expect 1, same id)`);
  const ok2 = r2.result.status === "AWAITING_APPROVAL" && rows2.length === 1 && (r2.result as any).ref === rows1[0].id;

  // 3. 30-minute meeting → ALLOW → executes (fresh conversation to skip the pending reuse).
  await cleanup();
  const short = simPort(30);
  const r3 = await executeCalendarOperation(req(), { port: short.port, strategyId: "hitl-verify", logger: () => {} });
  console.log(`\n3) BOOK 30min → ${r3.result.status} (expect EXECUTED); events=${short.store.bookings.length} (expect 1)`);
  const ok3 = r3.result.status === "EXECUTED" && short.store.bookings.length === 1;

  console.log(`\n=== VERDICT ===`);
  console.log(`  approval required + real row + no event : ${ok1}`);
  console.log(`  idempotent across turns (no dup rows)   : ${ok2}`);
  console.log(`  under-threshold auto-runs (legacy parity): ${ok3}`);
  console.log(`  → HITL wiring ${ok1 && ok2 && ok3 ? "VERIFIED LIVE ✓" : "NOT verified — inspect above"}`);

  await cleanup();
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error("HITL-VERIFY FAILED:", e); await cleanup(); await prisma.$disconnect(); process.exit(1); });
