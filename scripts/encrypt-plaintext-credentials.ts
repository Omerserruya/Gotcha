/**
 * Re-encrypt credential rows that were written in plaintext.
 *
 * `prisma/seed.ts` used to write `credentials` as a raw JSON object while every
 * runtime writer wrote an `encryptCredentials()` base64 string. Readers carry a
 * `typeof creds === "string" ? decrypt(creds) : creds` shim, so both shapes
 * worked and nothing ever reported the difference. Several seeded rows read a
 * REAL token out of the environment (WHATSAPP_ACCESS_TOKEN,
 * MESSENGER_ACCESS_TOKEN, ...), so any machine seeded with those set has live
 * provider credentials sitting in the database unencrypted.
 *
 * The seed is fixed; this repairs what it already wrote.
 *
 *   npx tsx scripts/encrypt-plaintext-credentials.ts            # report only
 *   npx tsx scripts/encrypt-plaintext-credentials.ts --apply    # rewrite
 *
 * Idempotent: a row already stored as a string is left alone. Never prints a
 * credential value - only the table, the row id, and the key NAMES.
 *
 * This does not rotate anything. A token that was written in plaintext should
 * be treated as exposed and rotated at the provider; encrypting it in place
 * narrows future exposure, it does not undo past exposure.
 */

import { PrismaClient } from "@prisma/client";
import { encryptCredentials } from "../packages/shared/src/lib/encryption";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

interface Finding {
  table: string;
  id: string;
  label: string;
  keys: string[];
}

async function main(): Promise<void> {
  const findings: Finding[] = [];

  const channels = await prisma.channelAccount.findMany({
    select: { id: true, channel: true, externalId: true, credentials: true },
  });
  for (const row of channels) {
    const c = row.credentials as unknown;
    if (typeof c === "string") continue; // already encrypted
    if (!c || typeof c !== "object" || Object.keys(c).length === 0) continue;
    findings.push({
      table: "channel_accounts",
      id: row.id,
      label: `${row.channel}/${row.externalId}`,
      keys: Object.keys(c as Record<string, unknown>),
    });
    if (APPLY) {
      await prisma.channelAccount.update({
        where: { id: row.id },
        data: { credentials: encryptCredentials(c as Record<string, unknown>) as never },
      });
    }
  }

  const integrations = await prisma.tenantIntegration.findMany({
    select: { id: true, tenantId: true, credentials: true, integration: { select: { slug: true } } },
  });
  for (const row of integrations) {
    const c = row.credentials as unknown;
    if (typeof c === "string") continue;
    if (!c || typeof c !== "object" || Object.keys(c).length === 0) continue;
    findings.push({
      table: "tenant_integrations",
      id: row.id,
      label: `${row.integration.slug} (tenant ${row.tenantId})`,
      keys: Object.keys(c as Record<string, unknown>),
    });
    if (APPLY) {
      await prisma.tenantIntegration.update({
        where: { id: row.id },
        data: { credentials: encryptCredentials(c as Record<string, unknown>) as never },
      });
    }
  }

  if (findings.length === 0) {
    console.log("No plaintext credential rows found.");
    return;
  }

  console.log(`${APPLY ? "Encrypted" : "Found"} ${findings.length} plaintext credential row(s):\n`);
  for (const f of findings) {
    console.log(`  ${f.table}  ${f.label}`);
    console.log(`    id: ${f.id}`);
    console.log(`    keys: ${f.keys.join(", ")}`);
  }

  if (!APPLY) {
    console.log("\nRe-run with --apply to encrypt them in place.");
  } else {
    console.log(
      "\nEncrypted in place. These credentials were stored in plaintext and must " +
        "be treated as exposed - rotate them at the provider.",
    );
  }
}

main()
  .catch((err) => {
    console.error("failed:", err?.message ?? err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
