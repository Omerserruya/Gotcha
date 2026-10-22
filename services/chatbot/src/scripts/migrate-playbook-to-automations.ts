/**
 * The playbook canvas -> "New conversation" automations (2026-10-22, Omer's
 * option (a)). Runs in the chatbot service image (it needs the automation
 * catalogue's go-live check).
 *
 *   npx tsx src/scripts/migrate-playbook-to-automations.ts                  # dry run, every tenant with a canvas
 *   npx tsx src/scripts/migrate-playbook-to-automations.ts --tenant <id>    # one tenant
 *   ... --apply     create the automations, record everything, empty the canvas
 *   ... --undo      put each recorded canvas back; created automations that
 *                   never ran are deleted, ones that ran are switched off (their
 *                   run history kept)
 *
 * Per tenant, in ONE transaction: the automations are created (active), the
 * canvas JSON and the created ids are saved to TenantSetting
 * `playbook:migrated`, and the canvas is emptied (so the runtime routes by the
 * automations only - nothing is handled twice). Idempotent: a tenant with a
 * record is skipped by --apply. A canvas the planner refuses (other triggers on
 * it) is left exactly as it is.
 *
 * Prints ids, channels and step types only - no message text, no credentials.
 */
import { prisma, getRedis, settingCacheKey } from "@chatcenter/shared";
import { planPlaybookMigration } from "../lib/playbook-migration";

const RECORD_KEY = "playbook:migrated";
const ACTOR = "playbook-migration";
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const UNDO = args.includes("--undo");
const tenantArg = args.includes("--tenant") ? args[args.indexOf("--tenant") + 1] : null;

async function dropCache(tenantId: string) {
  try { await getRedis().del(settingCacheKey(tenantId, RECORD_KEY)); } catch { /* best effort */ }
}

async function migrate() {
  const canvases = await (prisma as any).flowCanvas.findMany({
    where: tenantArg ? { tenantId: tenantArg } : {},
    select: { tenantId: true, nodes: true, edges: true, viewport: true, updatedBy: true },
  });
  let created = 0;
  for (const c of canvases as any[]) {
    const nodes = Array.isArray(c.nodes) ? c.nodes : [];
    if (!nodes.length) { console.log(`tenant ${c.tenantId}: empty canvas, nothing to do`); continue; }
    const record = await (prisma as any).tenantSetting.findUnique({ where: { tenantId_key: { tenantId: c.tenantId, key: RECORD_KEY } }, select: { tenantId: true } });
    if (record) { console.log(`tenant ${c.tenantId}: already migrated (record present), skipped`); continue; }

    const plan = planPlaybookMigration(c);
    console.log(`\ntenant ${c.tenantId}: ${nodes.length} nodes, ${(c.edges ?? []).length} edges`);
    if (!plan.migratable) { console.log(`  REFUSED: ${plan.refused}. Canvas left as it is.`); continue; }
    for (const a of plan.automations) {
      console.log(`  + ${a.channels.length ? a.channels.join(",") : "(every other channel)"}: ${a.nodes.map((n) => n.type).join(" -> ")}${a.warnings.length ? `  [warnings: ${a.warnings.join(" | ")}]` : ""}`);
    }
    for (const r of plan.notMigrated) console.log(`  ! not migrated: ${r}`);
    if (!plan.automations.length) { console.log("  nothing to create; canvas left as it is"); continue; }
    if (!APPLY) continue;

    const now = new Date();
    const ids = await prisma.$transaction(async (tx: any) => {
      const made: string[] = [];
      for (const a of plan.automations) {
        const row = await tx.chatbotFlow.create({
          data: {
            tenantId: c.tenantId, name: a.name, channel: a.channels.length === 1 ? a.channels[0] : null,
            triggerType: "conversation_started", triggerConfig: a.channels.length ? { channels: a.channels } : {},
            nodes: a.nodes, edges: a.edges, isActive: true, activatedAt: now, activatedBy: ACTOR,
          },
          select: { id: true },
        });
        made.push(row.id);
      }
      await tx.tenantSetting.create({
        data: {
          tenantId: c.tenantId, key: RECORD_KEY, updatedBy: ACTOR,
          value: { at: now.toISOString(), automationIds: made, notMigrated: plan.notMigrated, canvas: { nodes: c.nodes, edges: c.edges, viewport: c.viewport ?? null, updatedBy: c.updatedBy ?? null } },
        },
      });
      await tx.flowCanvas.update({ where: { tenantId: c.tenantId }, data: { nodes: [], edges: [], updatedBy: ACTOR } });
      return made;
    });
    await dropCache(c.tenantId);
    created += ids.length;
    console.log(`  APPLIED: ${ids.length} automation(s) ${ids.join(", ")}; canvas saved to ${RECORD_KEY} and emptied`);
  }
  console.log(`\n${APPLY ? "applied" : "dry run"}: ${created} automation(s) created`);
}

async function undo() {
  const records = await (prisma as any).tenantSetting.findMany({
    where: { key: RECORD_KEY, ...(tenantArg ? { tenantId: tenantArg } : {}) },
    select: { tenantId: true, value: true },
  });
  for (const r of records as any[]) {
    const v = r.value ?? {};
    const ids: string[] = Array.isArray(v.automationIds) ? v.automationIds : [];
    const runs = await (prisma as any).automationRun.groupBy({ by: ["flowId"], where: { tenantId: r.tenantId, flowId: { in: ids } }, _count: { _all: true } }).catch(() => []);
    const ran = new Set((runs as any[]).map((x) => x.flowId));
    console.log(`tenant ${r.tenantId}: restore canvas (${(v.canvas?.nodes ?? []).length} nodes); delete ${ids.filter((i) => !ran.has(i)).length}, switch off ${ran.size} automation(s)`);
    if (!APPLY) continue;
    await prisma.$transaction(async (tx: any) => {
      await tx.chatbotFlow.deleteMany({ where: { tenantId: r.tenantId, id: { in: ids.filter((i) => !ran.has(i)) } } });
      await tx.chatbotFlow.updateMany({ where: { tenantId: r.tenantId, id: { in: [...ran] } }, data: { isActive: false, pausedAt: new Date(), pausedBy: `${ACTOR}-undo` } });
      await tx.flowCanvas.update({
        where: { tenantId: r.tenantId },
        data: { nodes: v.canvas?.nodes ?? [], edges: v.canvas?.edges ?? [], viewport: v.canvas?.viewport ?? undefined, updatedBy: `${ACTOR}-undo` },
      });
      await tx.tenantSetting.deleteMany({ where: { tenantId: r.tenantId, key: RECORD_KEY } });
    });
    await dropCache(r.tenantId);
    console.log("  UNDONE");
  }
  if (!APPLY) console.log("\nundo dry run: add --apply to restore");
}

(UNDO ? undo() : migrate())
  .then(() => process.exit(0))
  .catch((e) => { console.error("FAILED:", e?.message ?? e); process.exit(1); });
