/**
 * LIVE AUTONOMOUS BOOK_MEETING VERIFICATION — the write-op evidence gating BOOK's
 * shadow→autonomous flip (the analogue of CHECK's pre-flip live verify).
 *
 * Drives the EXACT production pipeline the loop uses (executeCalendarOperation → prod
 * CalendarPort → real Google Calendar) in mode:"autonomous" (REAL writes), on the pilot
 * tenant, with a throwaway customer so no_duplicate_meeting holds. Sequence:
 *   0. seed a fresh conversation + ensure zero active bookings for the throwaway customer
 *   1. autonomous CHECK_AVAILABILITY → a genuinely-open slot
 *   2. autonomous BOOK_MEETING(slot) → REAL event; assert EXECUTED + all invariants held
 *   3. assert exactly one active booking in the store (single_meeting_after)
 *   4. autonomous CANCEL_MEETING → REAL delete (cleanup); assert zero active bookings
 * Everything is cleaned up in `finally`. Prints a verdict.
 */
import { prisma } from "@chatcenter/shared";
import { executeCalendarOperation } from "../src/services/capability-runtime/calendar.runtime";
import { createProdCalendarPort } from "../src/services/capability-runtime/calendar.port.prod";
import type { ExecutionRequest, ExecutionResult, ExecutionTrace } from "@chatcenter/shared";

const TENANT_ID = "cmmov5qh10000ltnqm7pmxqzc";
const AGENT_ID = "cm5aabb73f8d574c5b909ca1e9fcd6a142"; // דניאל — CONNECTED Google Calendar
const CONV_ID = "pilot-book-verify-conv";
const CUSTOMER = "pilot-book-verify-cust";
const EMAIL = "pilot-book-verify@example.com";

const port = createProdCalendarPort();
const ctx = { tenantId: TENANT_ID, aiAgentId: AGENT_ID, conversationId: CONV_ID, customerExternalId: CUSTOMER, customerEmail: EMAIL };

const heldAll = (t: ExecutionTrace) =>
  t.invariants.every((i) => ["held", "trusted_attested", "satisfied_by_read", "skipped_should"].includes(i.outcome));
const invStr = (t: ExecutionTrace) => t.invariants.map((i) => `${i.id}:${i.outcome}`).join(", ");

async function run(operation: string, params: Record<string, unknown>): Promise<{ result: ExecutionResult; trace: ExecutionTrace }> {
  const req: ExecutionRequest = { operation, params, context: ctx as any, mode: "autonomous" };
  return executeCalendarOperation(req, { port, strategyId: "pilot-book-verify" });
}

async function seed() {
  await prisma.message.deleteMany({ where: { conversationId: CONV_ID, tenantId: TENANT_ID } });
  await prisma.conversation.deleteMany({ where: { id: CONV_ID, tenantId: TENANT_ID } });
  await prisma.conversation.create({
    data: { id: CONV_ID, tenantId: TENANT_ID, customerExternalId: CUSTOMER, customerName: "Book Verify", assignedAiAgentId: AGENT_ID, status: "OPEN", detectedLocale: "he", channel: "WHATSAPP" } as any,
  });
}

async function cancelAnyActive(tag: string) {
  const active = await port.listActiveBookings(ctx);
  if (active.length === 0) { console.log(`  [${tag}] active bookings: 0`); return; }
  console.log(`  [${tag}] cleaning ${active.length} active booking(s)...`);
  for (let i = 0; i < active.length; i++) {
    const { result } = await run("CANCEL_MEETING", {});
    console.log(`     cancel #${i} → ${result.status}`);
    if (result.status !== "EXECUTED") break;
  }
}

async function main() {
  let booked = false;
  try {
    await seed();

    // meeting kind hint from a real active meeting type
    const mt: any = await (prisma as any).meetingType.findFirst({ where: { tenantId: TENANT_ID, isActive: true }, select: { slug: true, name: true }, orderBy: { createdAt: "asc" } });
    if (!mt) throw new Error("no active meeting type for pilot tenant");
    console.log(`\n=== LIVE AUTONOMOUS BOOK VERIFY (real Google Calendar writes) ===`);
    console.log(`tenant=${TENANT_ID} agent=${AGENT_ID} kind=${mt.slug}\n`);

    // 0. clean pre-state
    await cancelAnyActive("pre");

    // 1. CHECK → real open slot
    const chk = await run("CHECK_AVAILABILITY", { meeting_type: mt.slug });
    const slots: string[] = ((chk.result as any).data?.proposedSlotsIso as string[]) ?? [];
    console.log(`\n1) CHECK_AVAILABILITY → ${chk.result.status}; open slots: ${slots.slice(0, 5).join(", ") || "(none)"}`);
    console.log(`   invariants: ${invStr(chk.trace)}`);
    if (chk.result.status !== "EXECUTED" || slots.length === 0) throw new Error("no open slot to book — cannot verify BOOK");
    const slot = slots[0];

    // 2. BOOK the slot (REAL event)
    const bk = await run("BOOK_MEETING", { desired_time: slot, meeting_type: mt.slug, email: EMAIL });
    console.log(`\n2) BOOK_MEETING(${slot}) → ${bk.result.status}`);
    console.log(`   invariants: ${invStr(bk.trace)}`);
    console.log(`   outcome: ${(bk.result as any).outcome ?? (bk.result as any).reason ?? "-"}  eventId=${(bk.result as any).data?.eventId ?? "-"}`);
    const bookOk = bk.result.status === "EXECUTED" && bk.trace.executed === true && heldAll(bk.trace);
    if (bk.result.status === "EXECUTED") booked = true;

    // 3. single_meeting_after in the store
    const after = await port.listActiveBookings(ctx);
    console.log(`\n3) active bookings after BOOK: ${after.length} (expect 1)`);
    const singleOk = after.length === 1;

    // 4. cleanup + verify zero
    console.log(`\n4) cleanup (real cancel)...`);
    await cancelAnyActive("post");
    const residual = await port.listActiveBookings(ctx);
    booked = residual.length > 0; // if cleanup failed, flag for manual attention
    const cleanOk = residual.length === 0;

    console.log(`\n=== VERDICT ===`);
    console.log(`  BOOK executed + all invariants held : ${bookOk}`);
    console.log(`  exactly one active booking after    : ${singleOk}`);
    console.log(`  cleanup left zero residual bookings  : ${cleanOk}`);
    console.log(`  → BOOK_MEETING autonomous write-path ${bookOk && singleOk && cleanOk ? "VERIFIED LIVE ✓ (safe to flip)" : "NOT verified — inspect above"}`);
  } finally {
    if (booked) console.log("\n⚠ residual booking may remain — re-run to clean.");
    await prisma.conversation.deleteMany({ where: { id: CONV_ID, tenantId: TENANT_ID } }).catch(() => {});
    await prisma.$disconnect();
  }
}

main().catch(async (e) => { console.error("BOOK-VERIFY FAILED:", e); await prisma.$disconnect(); process.exit(1); });
