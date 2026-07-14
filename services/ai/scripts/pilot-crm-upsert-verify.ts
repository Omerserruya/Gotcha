/**
 * LIVE SAFE EVIDENCE - UPSERT_CUSTOMER (CRM WRITE) through the CRM connector against the
 * pilot's REAL HubSpot, WITHOUT mutating it. Proves the safe surface + shadow behavior:
 *   - describeWorld sees the real connection
 *   - advisory (shadow) mode → RECOMMENDED, the identity flow NEVER runs (no write)
 *   - missing identifier → NEEDS_INPUT gate
 * The autonomous happy-path (real create/enrich) is intentionally NOT run here: the CRM
 * connector has no delete, so a real `created` would leave an uncleanable contact. The
 * flip to autonomous is gated on a controlled real-write verification with a cleanup path.
 *
 *   ... npx tsx scripts/pilot-crm-upsert-verify.ts
 */
import { prisma } from "@chatcenter/shared";
import "../src/services/connectors"; // register provider adapters (as the service does at boot)
import { executeCrmOperation } from "../src/services/capability-runtime/crm.runtime";
import { createProdCrmPort } from "../src/services/capability-runtime/crm.port.prod";
import { CrmCapability } from "../src/services/capability-plane/crm.capability";
import type { ExecutionRequest, ExecutionMode, ExecutionTrace } from "@chatcenter/shared";

const TENANT_ID = "cmmov5qh10000ltnqm7pmxqzc";
const CONV_ID = "crm-upsert-verify";
const port = createProdCrmPort();
const invStr = (t: ExecutionTrace) => t.invariants.map((i) => `${i.id}:${i.outcome}`).join(", ");

async function run(params: Record<string, unknown>, mode: ExecutionMode) {
  const req: ExecutionRequest = { operation: "UPSERT_CUSTOMER", params, context: { tenantId: TENANT_ID, conversationId: CONV_ID }, mode };
  return executeCrmOperation(req, { port, strategyId: "crm.shadow" });
}

async function main() {
  console.log(`\n=== LIVE SAFE EVIDENCE - UPSERT_CUSTOMER (no mutation) ===`);

  const world = await CrmCapability.describeWorld({ tenantId: TENANT_ID, conversationId: CONV_ID });
  console.log(`1) describeWorld → "${world.summary}"  ops=[${world.operations.map((o) => o.name).join(",")}]`);
  const exposesUpsert = world.operations.some((o) => o.name === "UPSERT_CUSTOMER");

  // Shadow (advisory): a WRITE must short-circuit to RECOMMENDED and NEVER run the identity flow.
  const adv = await run({ email: "pilot-upsert-verify@gotcha-test.invalid", name: "Do Not Create" }, "advisory");
  console.log(`\n2) UPSERT_CUSTOMER (advisory/shadow) → ${adv.result.status}  (RECOMMENDED ⇒ no real write)`);
  console.log(`   invariants: ${invStr(adv.trace)}  executed=${adv.trace.executed}`);

  // Missing identifier → NEEDS_INPUT gate (never touches the vendor).
  const noId = await run({ name: "Only A Name" }, "autonomous");
  console.log(`\n3) UPSERT_CUSTOMER (no identifier) → ${noId.result.status} field=${(noId.result as any).field ?? "-"}`);

  console.log(`\n=== VERDICT ===`);
  console.log(`  connected world + UPSERT_CUSTOMER exposed         : ${world.facts.crmConnected === true && exposesUpsert}`);
  console.log(`  shadow WRITE short-circuits (RECOMMENDED, no run) : ${adv.result.status === "RECOMMENDED" && adv.trace.executed === false}`);
  console.log(`  missing-identifier gate (NEEDS_INPUT)             : ${noId.result.status === "NEEDS_INPUT"}`);
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error("CRM-UPSERT-VERIFY FAILED:", e); await prisma.$disconnect(); process.exit(1); });
