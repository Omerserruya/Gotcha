/**
 * Bind templates that name no WhatsApp number to their channel's only number
 * (B9, 2026-10-13), after the unique key became per number
 * (migration 20261013090000_message_template_unique_per_account).
 *
 * Only where the workspace has exactly ONE account on the template's channel:
 * with two numbers there is no way to know which one a template belongs to, so
 * those stay unbound and are reported. What moved is recorded per workspace in
 * TenantSetting "templates:backfill:channel-account", and --undo puts back
 * exactly that.
 *
 *   npx tsx scripts/backfill-template-channel-account.ts            # report only
 *   npx tsx scripts/backfill-template-channel-account.ts --apply    # write
 *   npx tsx scripts/backfill-template-channel-account.ts --undo     # reverse
 */
import { PrismaClient } from "@prisma/client";

const RECORD_KEY = "templates:backfill:channel-account";
const prisma = new PrismaClient();

async function apply(write: boolean) {
  const unbound = await prisma.messageTemplate.findMany({
    where: { channelAccountId: null, channel: { not: null } },
    select: { id: true, tenantId: true, channel: true, name: true, language: true },
  });
  const byTenant = new Map<string, Array<{ id: string; channelAccountId: string }>>();
  let ambiguous = 0;
  for (const t of unbound) {
    const accounts = await prisma.channelAccount.findMany({ where: { tenantId: t.tenantId, channel: t.channel! }, select: { id: true } });
    if (accounts.length !== 1) {
      ambiguous++;
      console.log(`  stays unbound (${accounts.length} accounts): ${t.tenantId} ${t.name}/${t.language}`);
      continue;
    }
    const list = byTenant.get(t.tenantId) ?? [];
    list.push({ id: t.id, channelAccountId: accounts[0]!.id });
    byTenant.set(t.tenantId, list);
  }
  const total = [...byTenant.values()].reduce((n, l) => n + l.length, 0);
  console.log(`[template-backfill] unbound=${unbound.length} bindable=${total} ambiguous=${ambiguous} apply=${write}`);
  if (!write) return;
  for (const [tenantId, rows] of byTenant) {
    await prisma.$transaction(async (tx) => {
      for (const r of rows) await tx.messageTemplate.updateMany({ where: { id: r.id, tenantId, channelAccountId: null }, data: { channelAccountId: r.channelAccountId } });
      const prior = await tx.tenantSetting.findFirst({ where: { tenantId, key: RECORD_KEY }, select: { value: true } });
      const value = { at: new Date().toISOString(), ids: [...(((prior?.value as any)?.ids ?? []) as string[]), ...rows.map((r) => r.id)] };
      await tx.tenantSetting.upsert({
        where: { tenantId_key: { tenantId, key: RECORD_KEY } },
        create: { tenantId, key: RECORD_KEY, value, updatedBy: "script" },
        update: { value, updatedBy: "script" },
      });
    });
    console.log(`  ${tenantId}: bound ${rows.length}`);
  }
}

async function undo() {
  const records = await prisma.tenantSetting.findMany({ where: { key: RECORD_KEY }, select: { tenantId: true, value: true } });
  for (const r of records) {
    const ids = (((r.value as any)?.ids ?? []) as string[]);
    await prisma.$transaction(async (tx) => {
      await tx.messageTemplate.updateMany({ where: { tenantId: r.tenantId, id: { in: ids } }, data: { channelAccountId: null } });
      await tx.tenantSetting.deleteMany({ where: { tenantId: r.tenantId, key: RECORD_KEY } });
    });
    console.log(`  ${r.tenantId}: unbound ${ids.length}`);
  }
  console.log(`[template-backfill] undo done for ${records.length} workspace(s)`);
}

(process.argv.includes("--undo") ? undo() : apply(process.argv.includes("--apply")))
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error("[template-backfill] failed:", err?.message ?? err);
    await prisma.$disconnect();
    process.exit(1);
  });
