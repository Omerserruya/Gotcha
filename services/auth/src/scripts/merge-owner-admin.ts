/**
 * Owner and Admin become one role (Omer, 2026-10-11) - the data step.
 *
 *   tsx src/scripts/merge-owner-admin.ts            dry run: who would move, per tenant
 *   tsx src/scripts/merge-owner-admin.ts --apply    move admin assignments to owner, recorded
 *   tsx src/scripts/merge-owner-admin.ts --undo     put back exactly what --apply moved
 *
 * Every Admin gains billing and role management - accepted by Omer, and on
 * the production release checklist. Run in the auth container, as root.
 */
import { prisma, mergeAdminIntoOwner, undoMergeAdminIntoOwner, MERGE_RECORD_KEY } from "@chatcenter/shared";

async function main(): Promise<void> {
  const mode = process.argv.includes("--apply") ? "apply" : process.argv.includes("--undo") ? "undo" : "dry";
  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true } });
  let total = 0;
  for (const t of tenants) {
    if (mode === "apply") {
      const r = await mergeAdminIntoOwner(t.id, "merge-owner-admin");
      if (r.moved) console.log(`[apply] ${t.id} ${t.name}: moved ${r.moved}`);
      total += r.moved;
    } else if (mode === "undo") {
      const r = await undoMergeAdminIntoOwner(t.id, "merge-owner-admin");
      if (r.restored) console.log(`[undo] ${t.id} ${t.name}: restored ${r.restored}`);
      total += r.restored;
    } else {
      const admin = await prisma.tenantRole.findFirst({ where: { tenantId: t.id, builtinKey: "admin" }, select: { id: true } });
      const n = admin ? await prisma.userRoleAssignment.count({ where: { roleId: admin.id } }) : 0;
      const recorded = await prisma.tenantSetting.findFirst({ where: { tenantId: t.id, key: MERGE_RECORD_KEY }, select: { key: true } });
      if (n || recorded) console.log(`[dry] ${t.id} ${t.name}: ${n} admin assignment(s) would move${recorded ? " (a merge record already exists)" : ""}`);
      total += n;
    }
  }
  console.log(`[${mode}] total ${total} across ${tenants.length} tenant(s)`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => { console.error("[merge-owner-admin] failed:", err?.message ?? err); process.exit(1); });
}
