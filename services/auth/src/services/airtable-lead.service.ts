/**
 * An inbound lead, written into the team's own Airtable.
 *
 * WHY AIRTABLE WHEN THE LEAD IS ALREADY IN OUR DATABASE
 * -----------------------------------------------------
 * `waitlist_entries` is where a lead is STORED; Airtable is where the team
 * actually works. The prospecting base is open in front of whoever is calling
 * people that day, with their views, their statuses and their follow-up dates.
 * A lead that lands in Postgres and pings a chat is a lead somebody has to
 * copy across by hand, and the ones that get copied are the ones somebody
 * remembered.
 *
 * WHICH BASE, AND WHY IT IS NOT THE PROSPECTING ONE
 * --------------------------------------------------
 * Two bases, split on a real distinction:
 *
 *   מאגר לפנייה   businesses WE approach. Bulk-imported, thousands of rows,
 *                 most of which nobody has spoken to.
 *   לידים פעילים  people who approached US. Few, precious, and every one of
 *                 them is worth a phone call today.
 *
 * Burying the second list inside the first would have hidden a handful of warm
 * leads among six thousand cold ones. The split is also what made this possible
 * at all: Airtable's record cap is per BASE, the prospecting base is far past
 * it and rejects every write, and a separate base has its own allowance.
 *
 * The schema is not a copy of the form. The form supplies four values; the rest
 * of the columns - status, owner, task, due date, disqualification reason - are
 * there so the team can WORK a lead in this table rather than copy it somewhere
 * else to work it. That mirrors how the prospecting base is used.
 *
 * ENTIRELY OPTIONAL, LIKE EVERY OTHER CHANNEL HERE
 * -------------------------------------------------
 * With no token configured it logs once and returns. It never throws and never
 * delays the signup: a lead that reached the database is a success whether or
 * not a spreadsheet heard about it.
 *
 * The prospecting base's record limit is the reason this one exists; a write to
 * the new base was confirmed to succeed while the old one still refuses every
 * create with HTTP 422.
 */

const TOKEN = process.env.AIRTABLE_LEADS_TOKEN || "";
const BASE_ID = process.env.AIRTABLE_LEADS_BASE_ID || "";
const TABLE_ID = process.env.AIRTABLE_LEADS_TABLE_ID || "";

/** 6s. A spreadsheet write must never hold a signup request open. */
const TIMEOUT_MS = 6000;

/**
 * Field IDs, not names.
 *
 * Airtable's API accepts either, and names are the trap: this table's columns
 * are Hebrew, one of them ends in a trailing space (`שם איש קשר `), and any of
 * them can be renamed in the UI by someone tidying up. A field ID is stable for
 * the life of the column. The comment beside each is the name as it reads
 * today, which is for humans only.
 */
const F = {
  company: "fldAnGljXRu1xA4aQ", // חברה  (the primary column)
  website: "fldKcYLzZZi32LT1U", // אתר
  contactName: "fldySEpYt19xUZs7M", // שם איש קשר
  phone: "fldwz2dpeb10qlCoO", // טלפון
  email: "fldzaWt13VONYYpJ6", // אימייל
  status: "fld0KzX63oeGFsJBw", // סטטוס
  source: "fldhrUOcKtpq0dz7C", // מקור
  arrival: "fldeqBqwuYta8Aq1A", // פרטי הגעה
} as const;

/**
 * Columns this service deliberately leaves alone: אחראי, משימה, תאריך לביצוע
 * המשימה, הביע עניין, סיבת פסילה, תיאור העסק, הערות. They are the team's
 * working columns and a machine has nothing true to say in them at the moment a
 * lead arrives. `התקבל` is a createdTime that Airtable fills itself.
 */

/** The status an inbound lead arrives with. The team sorts on it. */
const STATUS_NEW_LEAD = "ליד חדש";

export interface AirtableLead {
  firstName: string;
  /** The real address, or "" for a phone-first lead. Never the synthetic key. */
  email: string;
  phone?: string | null;
  /** The business website, as the form collected it. */
  website?: string | null;
  source: string;
  createdAt: Date;
}

function isConfigured(): boolean {
  return Boolean(TOKEN && BASE_ID && TABLE_ID);
}

/**
 * A readable name for the business, for the primary column.
 *
 * The form asks for a website, not a company name, so the host is the best
 * identifier we have - and it is the one the team recognises anyway, because
 * the rest of the table is keyed on domains. `www.` is dropped because nobody
 * writes it when searching.
 */
function businessName(website: string | null | undefined, fallback: string): string {
  const url = absoluteUrl(website);
  if (!url) return fallback;
  try {
    return new URL(url).hostname.replace(/^www\./i, "") || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Absolute, or nothing.
 *
 * The column is a URL type, and this value does not always hold a URL: the
 * SAME database column carries the campaign form's website and the
 * /early-access form's industry picker, because the endpoint stores both in
 * `company`. `new URL("https://אופנה")` parses perfectly happily, so a
 * scheme-and-parse check alone would write an industry name into a URL column.
 * A hostname with no dot in it is not a website anybody typed.
 */
function absoluteUrl(website: string | null | undefined): string | undefined {
  const raw = (website || "").trim();
  if (!raw) return undefined;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withScheme);
    if (!u.hostname.includes(".")) return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

export async function createAirtableLead(lead: AirtableLead): Promise<void> {
  if (!isConfigured()) {
    console.log(
      "[AIRTABLE-LEAD] Not configured (AIRTABLE_LEADS_TOKEN, AIRTABLE_LEADS_BASE_ID, AIRTABLE_LEADS_TABLE_ID required). Skipping.",
    );
    return;
  }

  const phone = (lead.phone || "").trim();
  const email = (lead.email || "").trim();

  // How to reach them, in the order a person would try.
  const reach = [phone && `טלפון: ${phone}`, email && `מייל: ${email}`]
    .filter(Boolean)
    .join(" · ");

  const fields: Record<string, unknown> = {
    [F.company]: businessName(lead.website, lead.firstName),
    [F.status]: STATUS_NEW_LEAD,
    [F.contactName]: lead.firstName,
    [F.source]: lead.source,
    [F.arrival]: [
      `מקור: ${lead.source}`,
      `התקבל: ${lead.createdAt.toISOString().replace("T", " ").slice(0, 19)} UTC`,
      reach ? `פרטי קשר שהושארו: ${reach}` : "לא הושארו פרטי קשר",
    ].join("\n"),
  };
  if (phone) fields[F.phone] = phone;
  if (email) fields[F.email] = email;
  const url = absoluteUrl(lead.website);
  if (url) fields[F.website] = url;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      // `typecast` lets Airtable create a select option it has not seen before,
      // which is what puts `ליד חדש` and a new campaign name on the board
      // without anyone editing the schema first.
      body: JSON.stringify({ records: [{ fields }], typecast: true }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        `[AIRTABLE-LEAD] create failed ${res.status}: ${body.slice(0, 300)}`,
      );
      return;
    }
    console.log(`[AIRTABLE-LEAD] created for source=${lead.source}`);
  } catch (err: any) {
    console.error(
      `[AIRTABLE-LEAD] create failed: ${err?.name === "AbortError" ? "timeout" : err?.message}`,
    );
  } finally {
    clearTimeout(timer);
  }
}
