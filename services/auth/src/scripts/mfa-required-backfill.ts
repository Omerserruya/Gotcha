/**
 * Backfill Authentik's gotcha_mfa_required marker for every identity (Option B,
 * 2026-11-09). Prints counts only, never a secret. DRY by default:
 *   tsx src/scripts/mfa-required-backfill.ts          -> what would be set
 *   tsx src/scripts/mfa-required-backfill.ts --apply  -> set it
 * Rollback: `node scripts/authentik/required-mfa.mjs rollback` returns the
 * login flow to stock (skip for everyone). The marker stays on users and is
 * inert once no policy reads it; the auth service keeps writing it until auth
 * itself is rolled back. Note that scripts/authentik/bootstrap.mjs also runs
 * the apply, so running the bootstrap re-applies Option B.
 */
import { prisma, findIdentityBySubject, setMfaRequiredAttribute, withCrossTenantAccess } from "@chatcenter/shared";
import { mfaRequiredForIdentity } from "../services/mfa-required-flag.service";

async function main() {
  const apply = process.argv.includes("--apply");
  const identities = await withCrossTenantAccess(() => prisma.identity.findMany({ where: { authentikSubject: { not: null } } as any, select: { id: true, authentikSubject: true } }));
  let required = 0, notRequired = 0, changed = 0, missing = 0, failed = 0;
  for (const i of identities) {
    const need = await mfaRequiredForIdentity(i.id);
    need ? required++ : notRequired++;
    if (!apply) continue;
    try {
      const who = await findIdentityBySubject(String(i.authentikSubject));
      if (!who) { missing++; continue; }
      if (await setMfaRequiredAttribute(who.pk, need)) changed++;
    } catch { failed++; }
  }
  console.log(`[mfa-backfill] ${apply ? "APPLIED" : "DRY"} identities=${identities.length} required=${required} notRequired=${notRequired}${apply ? ` changed=${changed} missingInAuthentik=${missing} failed=${failed}` : ""}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e?.message ?? e); process.exit(1); });
