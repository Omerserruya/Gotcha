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
 * WHAT IT IS WRITING INTO, AND THE MISMATCH WORTH KNOWING
 * -------------------------------------------------------
 * The table is `עסקים`, which was built for OUTBOUND prospecting: it has an
 * opening message, which channel we approached them on, what chat widget their
 * site runs. An inbound lead answers almost none of that, so most columns stay
 * empty and the ones that are filled are the contact details plus a status of
 * `ליד חדש`. That is a deliberate choice rather than an oversight - the team
 * asked for one table so that a person who raised their hand appears in the
 * same list as a person we chased, and they sort it themselves.
 *
 * ENTIRELY OPTIONAL, LIKE EVERY OTHER CHANNEL HERE
 * -------------------------------------------------
 * With no token configured it logs once and returns. It never throws and never
 * delays the signup: a lead that reached the database is a success whether or
 * not a spreadsheet heard about it.
 *
 * KNOWN LIVE PROBLEM (2026-09-22): the base is AT ITS RECORD LIMIT and the API
 * answers every create with HTTP 422 "This base is or will be over its record
 * limits". Until the workspace is upgraded or records are pruned, this leg
 * fails on every lead - loudly in the log, harmlessly everywhere else. The
 * lead still reaches the database and Telegram.
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
  company: "fldHm0AuBoLT3Q1yg", // חברה  (the primary column)
  website: "fldMiRvyj3GjP5d1V", // אתר החברה
  status: "flddUtbE8MeCoRE1J", // סטטוס
  contactName: "fldRp9VS2IeeNHwZp", // שם איש קשר
  howToReach: "fldB2b7KMiVgCM8CY", // איך יוצרים איתו קשר?
  whatsapp: "fldvnWKHrK8XDyEyO", // וואטסאפ גנרי
  email: "fldhziOcTa8zJ9pLu", // אימייל גנרי
  campaign: "fldXmYJIsN9EXKvbD", // קמפיין
  notes: "fldZ9xPhI06W636cQ", // הערות
} as const;

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
    [F.campaign]: lead.source,
    [F.notes]: [
      "ליד נכנס מדף נחיתה - הם פנו אלינו, לא להפך.",
      `מקור: ${lead.source}`,
      `התקבל: ${lead.createdAt.toISOString().replace("T", " ").slice(0, 19)} UTC`,
    ].join("\n"),
  };
  if (reach) fields[F.howToReach] = reach;
  if (phone) fields[F.whatsapp] = phone;
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
