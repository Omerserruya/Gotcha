/**
 * Standalone seeder for the system Intelligence Packs ONLY.
 *
 * Use this to (re)seed the industry packs without running the full db seed
 * (which has other ordering dependencies, e.g. catalog tools). Idempotent.
 *
 *   npm run db:seed-packs        (from packages/shared)
 *   docker compose run --rm migrate sh -c "cd /app/packages/shared && npm run db:seed-packs"
 */

import { PrismaClient } from "@prisma/client";
import { seedIntelligencePacks } from "./seed-intelligence-packs";

const prisma = new PrismaClient();

seedIntelligencePacks(prisma)
  .then(() => prisma.$disconnect())
  .then(() => { console.log("✅ Intelligence packs seeded."); process.exit(0); })
  .catch(async (err) => {
    console.error("Pack seed failed:", err);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
