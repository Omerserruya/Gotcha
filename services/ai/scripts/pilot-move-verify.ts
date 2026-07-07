/**
 * LIVE AUTONOMOUS MOVE_MEETING VERIFICATION — the remaining calendar WRITE evidence.
 * Real Google Calendar: seed → BOOK slotA → MOVE to slotB → assert meeting_moved +
 * exactly one booking now at slotB → CANCEL cleanup → assert zero residual.
 */
import { prisma } from "@chatcenter/shared";
import { executeCalendarOperation } from "../src/services/capability-runtime/calendar.runtime";
import { createProdCalendarPort } from "../src/services/capability-runtime/calendar.port.prod";
import type { ExecutionRequest, ExecutionResult, ExecutionTrace } from "@chatcenter/shared";

const TENANT_ID = "cmmov5qh10000ltnqm7pmxqzc";
const AGENT_ID = "cm5aabb73f8d574c5b909ca1e9fcd6a142";
const CONV_ID = "pilot-move-verify-conv";
const CUSTOMER = "pilot-move-verify-cust";
const EMAIL = "pilot-move-verify@example.com";

const port = createProdCalendarPort();
const ctx = { tenantId: TENANT_ID, aiAgentId: AGENT_ID, conversationId: CONV_ID, customerExternalId: CUSTOMER, customerEmail: EMAIL };
const heldAll = (t: ExecutionTrace) => t.invariants.every((i) => ["held", "trusted_attested", "satisfied_by_read", "skipped_should"].includes(i.outcome));
const invStr = (t: ExecutionTrace) => t.invariants.map((i) => `${i.id}:${i.outcome}`).join(", ");

async function run(operation: string, params: Record<string, unknown>): Promise<{ result: ExecutionResult; trace: ExecutionTrace }> {
  return executeCalendarOperation({ operation, params, context: ctx as any, mode: "autonomous" } as ExecutionRequest, { port, strategyId: "pilot-move-verify" });
}
async function seed() {
  await prisma.message.deleteMany({ where: { conversationId: CONV_ID, tenantId: TENANT_ID } });
  await prisma.conversation.deleteMany({ where: { id: CONV_ID, tenantId: TENANT_ID } });
  await prisma.conversation.create({ data: { id: CONV_ID, tenantId: TENANT_ID, customerExternalId: CUSTOMER, customerName: "Move Verify", assignedAiAgentId: AGENT_ID, status: "OPEN", detectedLocale: "he", channel: "WHATSAPP" } as any });
}
async function cancelAnyActive(tag: string) {
  const active = await port.listActiveBookings(ctx);
  console.log(`  [${tag}] active bookings: ${active.length}`);
  for (let i = 0; i < active.length; i++) { const { result } = await run("CANCEL_MEETING", {}); console.log(`     cancel #${i} → ${result.status}`); if (result.status !== "EXECUTED") break; }
}

async function main() {
  try {
    await seed();
    const mt: any = await (prisma as any).meetingType.findFirst({ where: { tenantId: TENANT_ID, isActive: true }, select: { slug: true }, orderBy: { createdAt: "asc" } });
    if (!mt) throw new Error("no active meeting type");
    console.log(`\n=== LIVE AUTONOMOUS MOVE VERIFY (real Google Calendar) === kind=${mt.slug}\n`);
    await cancelAnyActive("pre");

    const chk = await run("CHECK_AVAILABILITY", { meeting_type: mt.slug });
    const slots: string[] = ((chk.result as any).data?.proposedSlotsIso as string[]) ?? [];
    console.log(`1) CHECK → ${chk.result.status}; slots: ${slots.slice(0, 6).join(", ")}`);
    if (slots.length < 2) throw new Error("need ≥2 open slots to move between");
    const [slotA, slotB] = [slots[0], slots[1]];

    const bk = await run("BOOK_MEETING", { desired_time: slotA, meeting_type: mt.slug, email: EMAIL });
    console.log(`\n2) BOOK(${slotA}) → ${bk.result.status}  inv: ${invStr(bk.trace)}`);
    if (bk.result.status !== "EXECUTED") throw new Error("book failed; cannot verify move");

    const mv = await run("MOVE_MEETING", { desired_time: slotB, meeting_type: mt.slug });
    console.log(`\n3) MOVE(→${slotB}) → ${mv.result.status}`);
    console.log(`   invariants: ${invStr(mv.trace)}`);
    console.log(`   outcome: ${(mv.result as any).outcome ?? (mv.result as any).reason ?? "-"}`);
    const moveOk = mv.result.status === "EXECUTED" && mv.trace.executed === true && heldAll(mv.trace);

    const after = await port.listActiveBookings(ctx);
    const atB = after.length === 1 && Math.abs(after[0].startMs - Date.parse(slotB)) < 60_000;
    console.log(`\n4) after MOVE: ${after.length} booking(s); at slotB? ${atB} (start=${after[0] ? new Date(after[0].startMs).toISOString() : "-"})`);

    console.log(`\n5) cleanup...`);
    await cancelAnyActive("post");
    const residual = await port.listActiveBookings(ctx);

    console.log(`\n=== VERDICT ===`);
    console.log(`  MOVE executed + invariants held      : ${moveOk}`);
    console.log(`  exactly one booking, now at slotB    : ${atB}`);
    console.log(`  cleanup left zero residual bookings  : ${residual.length === 0}`);
    console.log(`  → MOVE_MEETING autonomous write-path ${moveOk && atB && residual.length === 0 ? "VERIFIED LIVE ✓ (safe to flip)" : "NOT verified — inspect above"}`);
  } finally {
    await prisma.conversation.deleteMany({ where: { id: CONV_ID, tenantId: TENANT_ID } }).catch(() => {});
    await prisma.$disconnect();
  }
}
main().catch(async (e) => { console.error("MOVE-VERIFY FAILED:", e); await prisma.$disconnect(); process.exit(1); });
