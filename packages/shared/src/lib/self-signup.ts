/**
 * Self sign-up: the platform's settings, and the mark a signed-up organization
 * carries (2026-11-22).
 *
 * Two rows, both durable settings, so there is no migration:
 *
 *  - the PLATFORM settings, one row on the System organization (a setting row
 *    needs an organization to hang on, and that one cannot be deleted);
 *  - the ORIGIN mark, one row on each organization that signed itself up. It
 *    holds the numbers that were in force on the day, as a snapshot.
 *
 * The snapshot is the safety rule of the whole feature. The daily sweep that
 * asks for a card reads ONLY the mark: an organization with no mark is never
 * swept, so nothing created before this existed (or by an operator) can be
 * blocked by it, and changing the platform numbers later never reaches back
 * to organizations that signed up under the old ones.
 *
 * The two rows have different keys on purpose: a scan for marks must never
 * read the platform row as one.
 */
import { prisma, withCrossTenantAccess } from "./prisma";
import { readDurableSetting, writeDurableSetting } from "./durable-settings";

/** The platform settings row, on the System organization. */
export const SELF_SIGNUP_SETTINGS_KEY = "selfSignup";
/** The origin mark, on an organization that signed itself up. */
export const SELF_SIGNUP_ORIGIN_KEY = "selfSignupOrigin";
/** The slug of the organization the platform's own rows hang on. */
export const SYSTEM_TENANT_SLUG = "system";

export interface SelfSignupSettings {
  enabled: boolean;
  /** How long the evaluation runs. */
  trialDays: number;
  /** Days after sign-up at which the organization must have a card on file. */
  cardRequiredAfterDays: number;
  /** The credit budget each sign-up is given. The platform pays for these. */
  trialCredits: number;
}

export const SELF_SIGNUP_DEFAULTS: SelfSignupSettings = Object.freeze({
  enabled: false,
  trialDays: 14,
  cardRequiredAfterDays: 14,
  trialCredits: 5000,
});

export const SELF_SIGNUP_BOUNDS = Object.freeze({
  trialDays: Object.freeze({ min: 1, max: 60 }),
  cardRequiredAfterDays: Object.freeze({ min: 1, max: 60 }),
  trialCredits: Object.freeze({ min: 500, max: 20000 }),
});

type NumberField = keyof typeof SELF_SIGNUP_BOUNDS;
const NUMBER_FIELDS: NumberField[] = ["trialDays", "cardRequiredAfterDays", "trialCredits"];

const inBounds = (field: NumberField, v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= SELF_SIGNUP_BOUNDS[field].min && v <= SELF_SIGNUP_BOUNDS[field].max;

function parseObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The stored settings, read leniently: a missing row, a row that is not an
 * object, or a field that is out of bounds gives that field's default. `enabled`
 * is on only for the boolean true, so nothing unreadable ever opens sign-up.
 */
export function parseSelfSignupSettings(raw: string | null | undefined): SelfSignupSettings {
  const o = parseObject(raw) ?? {};
  const out: SelfSignupSettings = { ...SELF_SIGNUP_DEFAULTS, enabled: o.enabled === true };
  for (const f of NUMBER_FIELDS) if (inBounds(f, o[f])) out[f] = o[f] as number;
  return out;
}

export type SelfSignupFieldProblem = "required" | "invalid" | "out_of_range";

/**
 * What an operator sent, read strictly: all four fields, whole numbers, inside
 * the bounds. Nothing is clamped or defaulted, so what is saved is what was
 * typed or nothing is saved.
 */
export function validateSelfSignupSettings(
  body: unknown,
): { ok: true; value: SelfSignupSettings } | { ok: false; fields: Record<string, SelfSignupFieldProblem> } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const fields: Record<string, SelfSignupFieldProblem> = {};
  if (b.enabled === undefined) fields.enabled = "required";
  else if (typeof b.enabled !== "boolean") fields.enabled = "invalid";
  for (const f of NUMBER_FIELDS) {
    const v = b[f];
    if (v === undefined || v === null) fields[f] = "required";
    else if (typeof v !== "number" || !Number.isInteger(v)) fields[f] = "invalid";
    else if (!inBounds(f, v)) fields[f] = "out_of_range";
  }
  if (Object.keys(fields).length) return { ok: false, fields };
  return {
    ok: true,
    value: {
      enabled: b.enabled as boolean,
      trialDays: b.trialDays as number,
      cardRequiredAfterDays: b.cardRequiredAfterDays as number,
      trialCredits: b.trialCredits as number,
    },
  };
}

/**
 * The deployment's own switch. Sign-up is open only when this AND the setting
 * are on, so an environment that never set it stays closed whatever the
 * console says.
 */
export function selfSignupEnvEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return String(env.SELF_SIGNUP ?? "").trim().toLowerCase() === "on";
}

/** The System organization's id, or null when it does not exist yet. */
export async function systemTenantId(): Promise<string | null> {
  const row = await withCrossTenantAccess(() =>
    (prisma as any).tenant.findUnique({ where: { slug: SYSTEM_TENANT_SLUG }, select: { id: true } }),
  );
  return (row as { id: string } | null)?.id ?? null;
}

/** The platform settings; the defaults (closed) when there is no row or no System organization. */
export async function readSelfSignupSettings(): Promise<SelfSignupSettings> {
  const id = await systemTenantId();
  if (!id) return { ...SELF_SIGNUP_DEFAULTS };
  return parseSelfSignupSettings(await readDurableSetting(id, SELF_SIGNUP_SETTINGS_KEY));
}

/** Save the platform settings. False when there is no System organization to hold them. */
export async function writeSelfSignupSettings(value: SelfSignupSettings, updatedBy?: string): Promise<boolean> {
  const id = await systemTenantId();
  if (!id) return false;
  await writeDurableSetting(id, SELF_SIGNUP_SETTINGS_KEY, JSON.stringify(value), updatedBy);
  return true;
}

/** Whether a sign-up would be taken right now, and the numbers it would get. */
export async function selfSignupState(
  env: Record<string, string | undefined> = process.env,
): Promise<SelfSignupSettings & { envEnabled: boolean; open: boolean }> {
  const settings = await readSelfSignupSettings();
  const envEnabled = selfSignupEnvEnabled(env);
  return { ...settings, envEnabled, open: envEnabled && settings.enabled };
}

// ── The origin mark ─────────────────────────────────────────────────────────

/** The statuses the sweep may replace, and so the only ones a restore may put back. */
export const CARD_BLOCKABLE_STATUSES = ["ACTIVE", "PENDING_ONBOARDING", "PENDING_ADMIN_SETUP"] as const;
export type CardBlockableStatus = (typeof CARD_BLOCKABLE_STATUSES)[number];

export interface SelfSignupOrigin {
  /** When the organization signed up (ISO). */
  at: string;
  trialDays: number;
  cardRequiredAfterDays: number;
  trialCredits: number;
  /** Set by the sweep when it asked for a card; removed when a card restored the organization. */
  cardBlock?: { at: string; priorStatus: CardBlockableStatus };
  /** When a stored card last put the organization back (ISO). */
  cardRestoredAt?: string;
}

/** A new mark: the day and the numbers in force on it. */
export function newSelfSignupOrigin(settings: SelfSignupSettings, now: Date): SelfSignupOrigin {
  return {
    at: now.toISOString(),
    trialDays: settings.trialDays,
    cardRequiredAfterDays: settings.cardRequiredAfterDays,
    trialCredits: settings.trialCredits,
  };
}

/**
 * A stored mark, read strictly: null unless it has a real date and a whole,
 * positive number of days. A mark that cannot be read is NOT a mark, so a
 * damaged row leaves its organization alone instead of blocking it.
 */
export function parseSelfSignupOrigin(raw: unknown): SelfSignupOrigin | null {
  const o = typeof raw === "string" ? parseObject(raw) : raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!o) return null;
  if (typeof o.at !== "string" || Number.isNaN(Date.parse(o.at))) return null;
  const days = o.cardRequiredAfterDays;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1) return null;
  const out: SelfSignupOrigin = {
    at: o.at,
    trialDays: typeof o.trialDays === "number" ? o.trialDays : SELF_SIGNUP_DEFAULTS.trialDays,
    cardRequiredAfterDays: days,
    trialCredits: typeof o.trialCredits === "number" ? o.trialCredits : SELF_SIGNUP_DEFAULTS.trialCredits,
  };
  const block = o.cardBlock as Record<string, unknown> | undefined;
  if (
    block && typeof block === "object" && typeof block.at === "string" &&
    (CARD_BLOCKABLE_STATUSES as readonly string[]).includes(block.priorStatus as string)
  ) {
    out.cardBlock = { at: block.at, priorStatus: block.priorStatus as CardBlockableStatus };
  }
  if (typeof o.cardRestoredAt === "string") out.cardRestoredAt = o.cardRestoredAt;
  return out;
}

const DAY_MS = 86_400_000;

/** The moment from which this organization must have a card on file. */
export function cardDueAt(origin: SelfSignupOrigin): Date {
  return new Date(Date.parse(origin.at) + origin.cardRequiredAfterDays * DAY_MS);
}

/** True from the due moment on (the moment itself included). */
export function cardIsDue(origin: SelfSignupOrigin, now: Date): boolean {
  return now.getTime() >= cardDueAt(origin).getTime();
}

// ── Email domains ───────────────────────────────────────────────────────────

/**
 * The domain of an email address, lowercased: the part after the LAST "@".
 * Null when there is none, or it has no dot, or it could not be a host name,
 * so "a@b" and "a@" and "a@-x.com" never read as a domain to join by.
 */
export function emailDomain(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const at = email.lastIndexOf("@");
  if (at < 1) return null;
  const domain = email.slice(at + 1).trim().toLowerCase().replace(/\.+$/, "");
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) return null;
  return domain;
}

/**
 * Mail providers anyone can open an address at, whatever the country ending:
 * "yahoo.com", "yahoo.co.uk", "hotmail.fr", "live.co.il".
 */
const PUBLIC_MAIL_BRANDS = new Set([
  "gmail", "googlemail", "outlook", "hotmail", "live", "msn", "yahoo", "ymail", "rocketmail",
  "icloud", "aol", "proton", "protonmail", "gmx", "yandex", "walla", "zoho", "tutanota",
]);

/** Public mail domains that are not a brand plus a country ending. */
const PUBLIC_MAIL_DOMAINS = new Set([
  "me.com", "mac.com", "pm.me", "mail.com", "email.com", "mail.ru", "inbox.ru", "list.ru", "bk.ru",
  "tuta.io", "tuta.com", "fastmail.com", "fastmail.fm", "hey.com", "duck.com", "hushmail.com",
  "qq.com", "163.com", "126.com", "sina.com", "naver.com", "daum.net", "web.de", "t-online.de",
  "orange.fr", "free.fr", "laposte.net", "libero.it", "comcast.net", "verizon.net", "att.net",
  "sbcglobal.net", "btinternet.com", "rediffmail.com",
  // Israeli providers and ISPs that hand out mailboxes.
  "012.net.il", "013.net", "013net.net", "bezeqint.net", "netvision.net.il", "zahav.net.il",
  "smile.net.il", "barak.net.il", "inter.net.il", "internet-zahav.net", "nana.co.il", "nana10.co.il",
]);

/** A country-style ending: "com", "fr", "co.il", "com.au". Never a longer name. */
const COUNTRY_ENDING = /^[a-z]{2,3}(\.[a-z]{2})?$/;

/**
 * True for a domain where anyone can open a mailbox. An organization may never
 * turn "join by domain" on for one of these: it would let every stranger with
 * such an address into the organization.
 *
 * A subdomain of a public domain is public too ("mail.yahoo.com"). A company
 * domain that merely starts with a brand word is not ("live.example.com",
 * "outlook-partners.com").
 */
export function isPublicEmailDomain(domain: unknown): boolean {
  if (typeof domain !== "string") return false;
  const d = domain.trim().toLowerCase().replace(/\.+$/, "");
  if (!d) return false;
  const labels = d.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const tail = labels.slice(i).join(".");
    if (PUBLIC_MAIL_DOMAINS.has(tail)) return true;
    const brand = labels[i] as string;
    const ending = labels.slice(i + 1).join(".");
    if (PUBLIC_MAIL_BRANDS.has(brand) && COUNTRY_ENDING.test(ending)) return true;
  }
  return false;
}

// ── Join by domain ───────────────────────────────────────────────────────────

/**
 * Durable setting on an organization: a new address at this domain that signs
 * up joins the organization instead of opening one of its own.
 */
export const JOIN_BY_DOMAIN_KEY = "joinByDomain";

export interface JoinByDomain {
  /** The one domain, lowercased. Never a public mail domain. */
  domain: string;
  /** The admin who switched it on (their user id), when known. */
  enabledBy: string | null;
  /** When it was switched on (ISO), "" when the stored value does not say. */
  enabledAt: string;
}

/**
 * The stored setting, read strictly. Null means off: nothing stored, a value
 * that is not an object, no usable domain, or a domain that is public mail. A
 * domain that becomes public (the list grows) therefore stops joining anyone
 * the day the list ships, with no data change.
 */
export function parseJoinByDomain(raw: unknown): JoinByDomain | null {
  const o = typeof raw === "string" ? parseObject(raw) : raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  // A domain only: an address ("dana@acme.com") is not read as its domain.
  if (!o || typeof o.domain !== "string" || o.domain.includes("@")) return null;
  const domain = emailDomain(`x@${o.domain}`);
  if (!domain || isPublicEmailDomain(domain)) return null;
  return {
    domain,
    enabledBy: typeof o.enabledBy === "string" && o.enabledBy ? o.enabledBy : null,
    enabledAt: typeof o.enabledAt === "string" ? o.enabledAt : "",
  };
}
