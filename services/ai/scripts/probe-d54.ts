/**
 * D54 probe - per-employee conversation counts on GET /api/ai-agents.
 *
 * The real tenant has ZERO isTest rows and ZERO imported rows, so two of the
 * three exclusions are unexercised by live data and a bug in either would be
 * invisible. This builds a second employee whose conversations hit every
 * exclusion, with THREE DIFFERENT expected numbers (1 / 3 / 1) so a query that
 * confused open with handled, or dropped a filter, cannot land on the right
 * answer by luck.
 *
 * Six conversations for the probe employee:
 *     sandbox, open              excluded by prefix
 *     isTest, open               excluded by flag
 *     HISTORICAL_IMPORT, open    excluded by the shared prisma guard, NOT by
 *                                this route - see applyLiveByDefault
 *     live, open                 open=1  handled=1
 *     live, closed, alone        handled=1  resolvedAlone=1
 *     live, closed, handed over  handled=1
 *   → open 1 · handled 3 · resolvedAlone 1
 *
 * Dropping this route's two exclusions reads open 3 · handled 5; the imported
 * row stays out either way because the platform holds that one. Both of this
 * route's filters are mutation-tested against these numbers.
 *
 * Run inside the ai container (it bind-mounts src, so no rebuild):
 *     docker compose exec -u root ai mkdir -p /app/services/ai/scripts
 *     docker compose cp services/ai/scripts/probe-d54.ts ai:/app/services/ai/scripts/probe-d54.ts
 *     docker compose exec ai sh -lc "cd /app && npx tsx services/ai/scripts/probe-d54.ts"
 */
import { prisma, withHistoricalRecords } from "@chatcenter/shared";

const TENANT = process.env.PROBE_TENANT ?? "cms4ug98n0004chmrp4lv6ujl";
const REAL_AGENT = "cms729b4e0001jgcyw85lpxg5";
const AGENT = "d54probe-agent";
const PREFIX = "d54probe-conv-";

type Row = { id: string; customerExternalId: string; status: string; isTest?: boolean; origin?: string; isHandedOver?: boolean };

const ROWS: Row[] = [
  { id: `${PREFIX}sandbox`, customerExternalId: `sandbox:${AGENT}:someone`, status: "OPEN" },
  { id: `${PREFIX}istest`, customerExternalId: "d54-istest", status: "OPEN", isTest: true },
  { id: `${PREFIX}imported`, customerExternalId: "d54-imported", status: "OPEN", origin: "HISTORICAL_IMPORT" },
  { id: `${PREFIX}live-open`, customerExternalId: "d54-live-open", status: "OPEN" },
  { id: `${PREFIX}live-alone`, customerExternalId: "d54-live-alone", status: "CLOSED", isHandedOver: false },
  { id: `${PREFIX}live-handed`, customerExternalId: "d54-live-handed", status: "CLOSED", isHandedOver: true },
];

async function cleanup() {
  // tenantId on every where: the shared TenantGuard rejects a clause without
  // one, and a swallowed rejection means cleanup silently does nothing.
  // withHistoricalRecords, or the HISTORICAL_IMPORT fixture is undeletable:
  // applyLiveByDefault injects `origin: "LIVE"` into deleteMany too, so an
  // ordinary delete cannot see the very row this probe created to test that
  // exclusion. Found by leaving exactly one row behind.
  await withHistoricalRecords(() =>
    prisma.conversation.deleteMany({ where: { tenantId: TENANT, id: { startsWith: PREFIX } } }),
  ).catch((e: any) => console.warn("cleanup conversations:", e?.message ?? e));
  await prisma.aIAgent
    .deleteMany({ where: { tenantId: TENANT, id: AGENT } })
    .catch((e: any) => console.warn("cleanup agent:", e?.message ?? e));
}

async function main() {
  await cleanup();

  await prisma.aIAgent.create({
    data: { id: AGENT, tenantId: TENANT, name: "D54 Probe Employee", status: "ACTIVE" } as any,
  });
  for (const r of ROWS) {
    await prisma.conversation.create({
      data: {
        id: r.id,
        tenantId: TENANT,
        channel: "WHATSAPP",
        customerExternalId: r.customerExternalId,
        status: r.status,
        assignedAiAgentId: AGENT,
        isTest: r.isTest ?? false,
        origin: r.origin ?? "LIVE",
        isHandedOver: r.isHandedOver ?? false,
      } as any,
    });
  }

  const key = process.env.INTERNAL_SERVICE_KEY;
  const res = await fetch("http://localhost:4006/api/ai-agents", {
    headers: { Authorization: `Bearer ${key}`, "x-tenant-id": TENANT },
  });
  if (!res.ok) {
    console.error(`ROUTE ${res.status}: ${(await res.text()).slice(0, 200)}`);
    await cleanup();
    process.exit(1);
  }
  const body: any = await res.json();
  const byId = new Map<string, any>((body.data ?? []).map((a: any) => [a.id, a]));

  const probe = byId.get(AGENT);
  const real = byId.get(REAL_AGENT);
  console.log("probe employee :", JSON.stringify({
    open: probe?.openConversations, handled: probe?.handledConversations, alone: probe?.resolvedAlone,
  }));
  console.log("real employee  :", JSON.stringify({
    open: real?.openConversations, handled: real?.handledConversations, alone: real?.resolvedAlone,
  }));

  const pass =
    probe?.openConversations === 1 &&
    probe?.handledConversations === 3 &&
    probe?.resolvedAlone === 1 &&
    // The real employee is the before/after: 14 open before the fix, 13 after,
    // the difference being the owner's own test chat. Checked here so the two
    // employees must be told apart - a query that ignored the grouping would
    // give both the same totals.
    real?.openConversations === 13 &&
    real?.handledConversations === 81 &&
    real?.resolvedAlone === 68;

  console.log(pass ? "PASS" : "FAIL");
  await cleanup();
  process.exit(pass ? 0 : 1);
}

main().catch(async (e) => {
  console.error("PROBE ERROR", e);
  await cleanup();
  process.exit(1);
});
