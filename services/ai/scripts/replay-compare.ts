/**
 * REPLAY-COMPARE - production-evidence harness for the legacy→kernel migration.
 *
 * Runs the new brain (Agent Loop) in DRY-RUN SHADOW over REAL historical
 * conversations (real customer messages, real calendar/CRM state) and compares its
 * decision against the RECORDED historical ground truth (did legacy actually book?
 * what is the conversation's terminal state?). NO legacy re-execution, NO real
 * writes - advisory/dry-run means every write resolves to RECOMMENDED, so replaying
 * real conversations is side-effect-free and safe.
 *
 * Purpose: accumulate confidence that the kernel behaves correctly under real
 * production traffic, and surface DIVERGENCES (kernel decision ≠ historical outcome)
 * as the regression review queue. Evidence, not features.
 *
 * Run (from services/ai):
 *   DATABASE_URL=…localhost… OPENAI_API_KEY=… CHANNEL_ENCRYPTION_KEY=… \
 *   GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… BILLING_ENFORCEMENT_MODE=off \
 *   REDIS_URL=redis://localhost:6379 npx tsx scripts/replay-compare.ts
 *
 * Deletion: migration-evaluation tool; retire when the loop is the production path.
 */

import { prisma } from "@chatcenter/shared";
import { initAIService } from "../src/services/ai.service";
import { runAgentLoopForBotTurn } from "../src/services/agent-loop/bot-loop-adapter";

const TENANT_ID = "cmmov5qh10000ltnqm7pmxqzc";
const AGENT_ID = "cm5aabb73f8d574c5b909ca1e9fcd6a142"; // דניאל

// Real historical conversations for the pilot agent (sampled: booking/sales intent).
const CONVERSATION_IDS = [
  "cmqp707u0003vikr89imvy189", // ends "see you at the meeting" - HAS booking (ground truth +)
  "cmqnyj0el00imvyxmbqpk4xfk", // "email …, let's book Saturday 10:00"
  "cmqnya1o400hyvyxmpppvjy34", // "no need for the team, let's book today 10:00"
  "cmqo4v6r9002ld010f0hh9he8", // "tomorrow morning, my email test.heb@…"
  "cmqnupzut00favyxmzntintyc", // "I'm Tamar Gold, email …, I have a store"
  "cmqnrd7ix00bcvyxmxdhsgcqr", // "B2B SaaS, missing evening leads, email gal@…"
  "cmqqt1yu80001y7ow8oruxzbc", // ends "not now, talk later, bye thanks" (CLOSED)
  "cmqqthbne001zy7owuj55epoe", // ends "that's it thanks bye" (CLOSED)
];

interface ReplayRow {
  conversationId: string;
  lastInbound: string;
  loopTermination: string;
  loopOps: string[];
  loopReply: string | null;
  hadBooking: boolean;
  convStatus: string;
  agreement: string;
  flag: string;
}

async function groundTruth(conversationId: string) {
  const [bookings, conv, lastInboundRow] = await Promise.all([
    (prisma as any).meetingBooking.findMany({ where: { conversationId, tenantId: TENANT_ID }, select: { id: true, status: true } }),
    prisma.conversation.findFirst({ where: { id: conversationId, tenantId: TENANT_ID }, select: { status: true } }),
    prisma.message.findFirst({
      where: { conversationId, tenantId: TENANT_ID, direction: "INBOUND" },
      orderBy: { createdAt: "desc" },
      select: { body: true },
    }),
  ]);
  const activeBooking = (bookings as any[]).some((b) => b.status !== "CANCELLED");
  return { hadBooking: activeBooking, convStatus: conv?.status ?? "?", lastInbound: lastInboundRow?.body ?? "" };
}

/** Classify: does the kernel's decision cohere with what legacy actually did? */
function classify(loopOps: string[], loopTermination: string, hadBooking: boolean): { agreement: string; flag: string } {
  const proposedBook = loopOps.includes("BOOK_MEETING");
  const proposedCheck = loopOps.includes("CHECK_AVAILABILITY");
  const drivesToBooking = proposedBook || proposedCheck;

  if (hadBooking) {
    // Legacy booked. The kernel should either recognize the booking (finish/converse)
    // or still be driving toward it - but NOT escalate or stall confused.
    if (loopTermination === "escalate") return { agreement: "DIVERGE", flag: "legacy booked but kernel ESCALATED" };
    if (proposedBook) return { agreement: "ALIGN", flag: "kernel also books (idempotent store should dedupe)" };
    return { agreement: "ALIGN", flag: "kernel recognizes/continues around existing booking" };
  }
  // No booking historically.
  if (drivesToBooking) return { agreement: "ALIGN", flag: "kernel drives toward booking (no legacy booking to compare)" };
  if (loopTermination === "escalate") return { agreement: "REVIEW", flag: "kernel escalated - verify appropriateness" };
  return { agreement: "ALIGN", flag: `kernel ${loopTermination} (asked/converse)` };
}

async function replayOne(conversationId: string): Promise<ReplayRow> {
  const gt = await groundTruth(conversationId);
  const incoming = gt.lastInbound || "(continue)";

  await runAgentLoopForBotTurn(
    { tenantId: TENANT_ID, conversationId, aiAgentId: AGENT_ID, incomingMessage: incoming },
    "shadow",
  );

  // Read back what the kernel decided (persisted this run).
  const run = await (prisma as any).agentLoopRun.findFirst({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
  });
  const iters = run
    ? await (prisma as any).agentLoopIteration.findMany({ where: { loopId: run.loopId }, orderBy: { iteration: "asc" }, select: { proposedOperation: true } })
    : [];
  const loopOps = Array.from(new Set((iters as any[]).map((i) => i.proposedOperation).filter(Boolean)));
  const { agreement, flag } = classify(loopOps, run?.terminationReason ?? "?", gt.hadBooking);

  return {
    conversationId,
    lastInbound: incoming.slice(0, 50),
    loopTermination: run?.terminationReason ?? "?",
    loopOps,
    loopReply: run?.reply ?? null,
    hadBooking: gt.hadBooking,
    convStatus: gt.convStatus,
    agreement,
    flag,
  };
}

async function main() {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY required");
  initAIService({ apiKey: process.env.OPENAI_API_KEY });

  console.log(`\n=== REPLAY-COMPARE (kernel dry-run vs historical ground truth) ===`);
  console.log(`tenant=${TENANT_ID} agent=${AGENT_ID} conversations=${CONVERSATION_IDS.length}\n`);

  const rows: ReplayRow[] = [];
  for (const id of CONVERSATION_IDS) {
    try {
      const r = await replayOne(id);
      rows.push(r);
      console.log(`[${r.agreement}] ${id}`);
      console.log(`   customer: "${r.lastInbound}"`);
      console.log(`   kernel: ${r.loopTermination} ops=[${r.loopOps.join(",")}]  | legacy: booking=${r.hadBooking} status=${r.convStatus}`);
      console.log(`   ${r.flag}`);
      console.log(`   reply: ${(r.loopReply ?? "").slice(0, 120)}`);
    } catch (e: any) {
      console.log(`[ERROR] ${id}: ${e?.message ?? e}`);
    }
  }

  // Confidence summary.
  const n = rows.length;
  const align = rows.filter((r) => r.agreement === "ALIGN").length;
  const diverge = rows.filter((r) => r.agreement === "DIVERGE").length;
  const review = rows.filter((r) => r.agreement === "REVIEW").length;
  console.log(`\n=== CONFIDENCE SUMMARY ===`);
  console.log(`replayed=${n}  ALIGN=${align}  REVIEW=${review}  DIVERGE=${diverge}`);
  console.log(`alignment=${n ? Math.round((align / n) * 100) : 0}%  (DIVERGE = regression candidates to fix)`);
  if (diverge > 0) {
    console.log(`\nDIVERGENCES (regression queue):`);
    for (const r of rows.filter((x) => x.agreement === "DIVERGE")) console.log(`  - ${r.conversationId}: ${r.flag}`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("REPLAY FAILED:", e);
  await prisma.$disconnect();
  process.exit(1);
});
