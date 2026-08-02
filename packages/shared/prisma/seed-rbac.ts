/**
 * Seed + backfill the RBAC built-in roles and assignments for every tenant.
 * Idempotent. Run: `tsx prisma/seed-rbac.ts` (with DATABASE_URL set).
 */
import { seedAllTenantsRbac } from "../src/lib/rbac-seed";
import { prisma } from "../src/lib/prisma";

async function main() {
  const result = await seedAllTenantsRbac();
  console.log(
    `[rbac-seed] seeded ${result.tenants} tenant(s), created ${result.assignments} role assignment(s)`,
  );
}

main()
  .catch((e) => {
    console.error("[rbac-seed] failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
