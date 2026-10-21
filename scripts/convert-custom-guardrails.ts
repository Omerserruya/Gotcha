/**
 * Repair AIAgent.customGuardrails rows that are not a list (2026-10-21).
 *
 * The prompt and GET /ai-agents read only a JSON array of strings
 * (readGuardrails); a row stored as text reads as [] and its rule is silently
 * not enforced. Every writer now goes through normalizeGuardrails, so this only
 * repairs what older writers left. The rule per row is legacyGuardrailsFix
 * (packages/shared/src/lib/guardrails.ts): text -> [text] trimmed, empty text or
 * JSON null -> SQL NULL, a list untouched, anything else reported. A rule over
 * the length limit is kept whole and reported, never cut.
 *
 *   npx tsx scripts/convert-custom-guardrails.ts                      # report only
 *   npx tsx scripts/convert-custom-guardrails.ts --apply              # write
 *   npx tsx scripts/convert-custom-guardrails.ts --undo <backup.json> # put back
 *
 * --apply first writes every changed row's previous value to
 * guardrails-backup-<timestamp>.json (its path is printed); --undo restores
 * exactly those rows. Idempotent: a second --apply finds nothing to change.
 * Prints ids, tenant ids and counts only, never a rule's text.
 */
import { PrismaClient, Prisma } from "@prisma/client";
import fs from "fs";
import { legacyGuardrailsFix } from "../packages/shared/src/lib/guardrails";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const undoIdx = process.argv.indexOf("--undo");
const UNDO = undoIdx >= 0 ? process.argv[undoIdx + 1] : null;

type Backup = Array<{ id: string; tenantId: string; previous: unknown }>;

async function undo(file: string): Promise<void> {
  const rows = JSON.parse(fs.readFileSync(file, "utf8")) as Backup;
  for (const r of rows) {
    await prisma.aIAgent.updateMany({
      where: { id: r.id, tenantId: r.tenantId },
      data: { customGuardrails: r.previous === null ? Prisma.JsonNull : (r.previous as Prisma.InputJsonValue) },
    });
  }
  console.log(`restored ${rows.length} row(s) from ${file}`);
}

async function main(): Promise<void> {
  if (UNDO) return undo(UNDO);
  // Prisma cannot filter on a JSON value's type, so read the non-null rows.
  const agents = await prisma.aIAgent.findMany({
    where: { NOT: { customGuardrails: { equals: Prisma.DbNull } } },
    select: { id: true, tenantId: true, customGuardrails: true },
  });
  const counts = { lists: 0, toList: 0, toNull: 0, reported: 0, overLimit: 0 };
  const backup: Backup = [];
  const plan: Array<{ id: string; tenantId: string; data: Prisma.AIAgentUpdateManyMutationInput }> = [];
  for (const a of agents) {
    const fix = legacyGuardrailsFix(a.customGuardrails);
    if (fix.action === "keep") { counts.lists++; continue; }
    if (fix.action === "report") {
      counts.reported++;
      console.log(`REPORT agent=${a.id} tenant=${a.tenantId}: ${fix.reason} (left as is)`);
      continue;
    }
    backup.push({ id: a.id, tenantId: a.tenantId, previous: a.customGuardrails });
    if (fix.action === "null") {
      counts.toNull++;
      plan.push({ id: a.id, tenantId: a.tenantId, data: { customGuardrails: Prisma.DbNull } });
    } else {
      counts.toList++;
      if (fix.overLimit) {
        counts.overLimit++;
        console.log(`OVER LIMIT agent=${a.id} tenant=${a.tenantId}: kept whole; the editor will ask to shorten it`);
      }
      plan.push({ id: a.id, tenantId: a.tenantId, data: { customGuardrails: fix.value } });
    }
  }
  console.log(`agents with rules: ${agents.length}; already lists: ${counts.lists}; text -> list: ${counts.toList} (over limit: ${counts.overLimit}); empty -> null: ${counts.toNull}; reported: ${counts.reported}`);
  if (!APPLY) { console.log("report only; run with --apply to write"); return; }
  if (!plan.length) { console.log("nothing to change"); return; }
  const file = `guardrails-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(file, JSON.stringify(backup));
  console.log(`backup of ${backup.length} previous value(s): ${file}`);
  for (const p of plan) await prisma.aIAgent.updateMany({ where: { id: p.id, tenantId: p.tenantId }, data: p.data });
  console.log(`changed ${plan.length} row(s)`);
}

main()
  .catch((err) => { console.error(err?.message ?? err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
