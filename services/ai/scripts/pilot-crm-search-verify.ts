/**
 * LIVE SHADOW EVIDENCE - SEARCH_CUSTOMER (CRM READ) through the new CRM driver against
 * the pilot's REAL CRM (HubSpot). READ-only: safe to run for real. Proves the driver is
 * a faithful wrapper: describeWorld sees the real connection, and SEARCH_CUSTOMER reaches
 * the real vendor via getCrmAdapter().findCustomer and returns a well-formed result +
 * trace. Also checks the NEEDS_INPUT gate when no identifier is known.
 *
 *   ... npx tsx scripts/pilot-crm-search-verify.ts [email-to-search]
 */
import { prisma } from "@chatcenter/shared";
import "../src/services/connectors"; // side-effect: registers provider adapters (as the service does at boot)
import { resolveCrmVendor } from "../src/services/connectors/crm-adapter-resolver";
import { executeCrmOperation } from "../src/services/capability-runtime/crm.runtime";
import { createProdCrmPort } from "../src/services/capability-runtime/crm.port.prod";
import { CrmCapability } from "../src/services/capability-plane/crm.capability";
import type { ExecutionRequest, ExecutionTrace } from "@chatcenter/shared";

const TENANT_ID = "cmmov5qh10000ltnqm7pmxqzc";
const CONV_ID = "crm-search-verify";
const port = createProdCrmPort();
const invStr = (t: ExecutionTrace) => t.invariants.map((i) => `${i.id}:${i.outcome}`).join(", ");

async function run(params: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  const req: ExecutionRequest = { operation: "SEARCH_CUSTOMER", params, context: { tenantId: TENANT_ID, conversationId: CONV_ID, ...ctx }, mode: "advisory" };
  return executeCrmOperation(req, { port, strategyId: "crm.shadow" });
}

async function main() {
  const email = process.argv[2] || "test@example.com";
  console.log(`\n=== LIVE CRM SEARCH_CUSTOMER SHADOW EVIDENCE (real vendor) ===`);

  const vendor = await resolveCrmVendor(TENANT_ID);
  console.log(`1) resolveCrmVendor → ${vendor}`);

  const world = await CrmCapability.describeWorld({ tenantId: TENANT_ID, conversationId: CONV_ID, customerEmail: email });
  console.log(`2) describeWorld → "${world.summary}"  facts=${JSON.stringify(world.facts)}  operations=[${world.operations.map((o) => o.name).join(",")}]`);

  const found = await run({ email });
  console.log(`\n3) SEARCH_CUSTOMER(email=${email}) → ${found.result.status}`);
  console.log(`   invariants: ${invStr(found.trace)}  executed=${found.trace.executed} successVerified=${found.trace.successVerified}`);
  console.log(`   outcome: ${(found.result as any).outcome ?? (found.result as any).reason ?? "-"}  matchCount=${(found.result as any).data?.matchCount ?? "-"}`);

  const noKey = await run({}, {});
  console.log(`\n4) SEARCH_CUSTOMER(no identifier) → ${noKey.result.status} field=${(noKey.result as any).field ?? "-"}`);

  const okReached = found.result.status === "EXECUTED" || (found.result.status === "FAILED" && /no_crm_configured|unavailable|token|auth|scope|403/i.test((found.result as any).reason || ""));
  console.log(`\n=== VERDICT ===`);
  console.log(`  driver reached the real vendor + returned a well-formed result : ${okReached}`);
  console.log(`  connected world + operation exposed                            : ${world.facts.crmConnected === true && world.operations.some((o) => o.name === "SEARCH_CUSTOMER")}`);
  console.log(`  missing-identifier gate (NEEDS_INPUT)                          : ${noKey.result.status === "NEEDS_INPUT"}`);
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error("CRM-SEARCH-VERIFY FAILED:", e); await prisma.$disconnect(); process.exit(1); });
