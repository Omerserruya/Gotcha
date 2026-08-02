/**
 * Who stops being served if enforcement is switched on.
 *
 * Run this BEFORE setting BILLING_ENFORCEMENT_MODE=enforce, in the environment
 * you are about to change. Enforcement is one environment variable that changes
 * what happens to live customer conversations, and the organizations most
 * likely to be caught by it are the ones mid-onboarding, who have the least
 * patience for it.
 *
 *   npx tsx src/scripts/enforcement-impact.ts
 *
 * Read-only. It calls the same gate the runtime calls, under an assumed
 * `enforce`, so it reports what would actually happen rather than a second
 * opinion about it. Nothing here writes, charges or notifies.
 *
 * The number that matters is "actively serving". A tenant with no conversations
 * in the activity window can be refused today and nobody notices; a tenant with
 * conversations goes quiet in front of their customers.
 */
import { previewEnforcement } from "../services/enforcement-preview.service";

async function main(): Promise<void> {
  const preview = await previewEnforcement();

  console.log("");
  console.log("  ENFORCEMENT IMPACT");
  console.log("  ─────────────────────────────────────────────");
  console.log(`  configured mode      ${preview.mode}${preview.enforcing ? "  (already enforcing - this is a report, not a forecast)" : ""}`);
  console.log(`  would be refused     ${preview.totals.tenants} organizations`);
  console.log(`  ACTIVELY SERVING     ${preview.totals.live}  <- the ones whose customers would notice`);
  console.log("");
  console.log("  by reason");
  for (const [reason, count] of Object.entries(preview.totals.byReason).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(count).padStart(5)}  ${reason}`);
  }

  const live = preview.affected.filter((t) => t.live);
  if (live.length > 0) {
    console.log("");
    console.log("  ORGANIZATIONS THAT WOULD GO QUIET");
    for (const t of live) {
      console.log(`    ${t.name} - ${t.reason} (${t.recentConversations} recent conversations, subscription ${t.subscriptionStatus ?? "none"})`);
    }
    console.log("");
    console.log("  Each of these is a decision, not a statistic. Resolve or accept");
    console.log("  them individually before switching the mode.");
  } else {
    console.log("");
    console.log("  No organization currently serving customers would be refused.");
  }
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[enforcement-impact] failed:", err?.message ?? err);
    // Non-zero: a report that could not be produced must not read as "all clear".
    process.exit(1);
  });
