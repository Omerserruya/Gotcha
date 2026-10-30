/**
 * Leads the team's Airtable missed, written there later.
 *
 * The signup writes to Airtable once, on the spot, and a failure used to be a
 * log line and nothing else: the lead stayed in `waitlist_entries` and in the
 * team's chat, and never reached the table the team works from. On 2026-10-30
 * the Airtable workspace ran out of its monthly API quota (429
 * PUBLIC_API_BILLING_LIMIT_EXCEEDED) on the day the new landing forms went
 * live.
 *
 * An hourly pass picks up every lead since then that Airtable has not taken
 * (`airtable_synced_at` null), oldest first, and writes it - looking it up by
 * email (or phone) first, so a lead whose write landed but was never marked
 * is not written twice. The quota error stops the pass and holds the next
 * ones for six hours: every call would fail, lookups included, and each one
 * would spend quota the team may need.
 */
import { prisma, getRedis } from "@chatcenter/shared";
import { syncLeadToAirtable, type AirtableLead } from "./airtable-lead.service";

/** The landing forms went live. Older rows are left as they are. */
export const SYNC_SINCE = new Date("2026-10-30T13:11:00Z");
const BATCH = 10;
const LOCK_KEY = "airtable-lead-sync:lock";
const BACKOFF_KEY = "airtable-lead-sync:quota-backoff";
const BACKOFF_SECONDS = 6 * 60 * 60;
const HOUR_MS = 60 * 60 * 1000;

/** The synthetic key a phone-first lead carries in the unique email column. */
const NO_EMAIL = /@no-email\.gotcha$/i;

type Row = { id: string; firstName: string; email: string; phone: string | null; company: string | null; source: string; createdAt: Date };

/** The same lead the signup wrote, rebuilt from the stored row. */
export function leadFromEntry(e: Row): AirtableLead {
  return {
    firstName: e.firstName,
    email: NO_EMAIL.test(e.email) ? "" : e.email,
    phone: e.phone,
    // `company` holds a campaign lead's website or an /early-access lead's
    // industry; the URL column only ever takes a value with a dot in its host.
    website: e.company,
    source: e.source,
    createdAt: e.createdAt,
  };
}

export type PassResult = { ran: boolean; synced: number; stopped: "quota" | "rate_limit" | null; failed: number };

export async function runAirtableLeadSyncPass(): Promise<PassResult> {
  const idle: PassResult = { ran: false, synced: 0, stopped: null, failed: 0 };
  const redis = getRedis();
  if (await redis.get(BACKOFF_KEY)) return idle;
  // One pass at a time, across restarts and replicas.
  if ((await redis.set(LOCK_KEY, "1", "EX", 15 * 60, "NX")) !== "OK") return idle;
  const out: PassResult = { ran: true, synced: 0, stopped: null, failed: 0 };
  try {
    const rows: Row[] = await prisma.waitlistEntry.findMany({
      where: { airtableSyncedAt: null, createdAt: { gte: SYNC_SINCE } },
      orderBy: { createdAt: "asc" },
      take: BATCH,
      select: { id: true, firstName: true, email: true, phone: true, company: true, source: true, createdAt: true },
    });
    for (const row of rows) {
      const r = await syncLeadToAirtable(leadFromEntry(row));
      if (r.ok) {
        await prisma.waitlistEntry.update({ where: { id: row.id }, data: { airtableSyncedAt: new Date() } });
        out.synced++;
        continue;
      }
      if (r.billingLimit) {
        await redis.set(BACKOFF_KEY, "1", "EX", BACKOFF_SECONDS);
        out.stopped = "quota";
        break;
      }
      if (r.status === 429) {
        out.stopped = "rate_limit";
        break;
      }
      out.failed++;
    }
  } finally {
    await redis.del(LOCK_KEY).catch(() => 0);
  }
  if (out.synced || out.stopped || out.failed) {
    console.log(`[AIRTABLE-LEAD] sync pass: synced=${out.synced} failed=${out.failed}${out.stopped ? ` stopped=${out.stopped}` : ""}`);
  }
  return out;
}

/** Hourly, first run two minutes after start. Off when Airtable is not configured. */
export function startAirtableLeadSync(): void {
  if (!process.env.AIRTABLE_LEADS_TOKEN || !process.env.AIRTABLE_LEADS_BASE_ID || !process.env.AIRTABLE_LEADS_TABLE_ID) return;
  const run = () => runAirtableLeadSyncPass().catch((e) => console.error("[AIRTABLE-LEAD] sync pass failed:", e?.message));
  setTimeout(run, 2 * 60 * 1000).unref();
  setInterval(run, HOUR_MS).unref();
}
