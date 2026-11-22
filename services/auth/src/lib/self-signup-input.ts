/**
 * What the public sign-up form sent, read strictly.
 *
 * The endpoint behind this is open to anyone, and two of its fields (the
 * person's name and the business name) are printed in the email that goes to
 * whatever address was typed. So the reading is narrow on purpose: a value
 * that carries markup or a web address is refused, because the form would
 * otherwise mail a stranger's text to a stranger's inbox under our name.
 */
import { emailDomain } from "@chatcenter/shared";
import { acceptanceOf } from "./terms-consent";

export type SignupFieldProblem = "required" | "invalid" | "too_long";

export interface SignupInput {
  name: string;
  /** Trimmed and lowercased. */
  email: string;
  businessName: string;
  locale: "he" | "en";
  /** The words shown next to the two boxes, as the screen sent them. */
  capturedText: string | null;
}

export type SignupParse =
  /** The hidden field was filled: a bot. Nothing else was read. */
  | { ok: true; honeypot: true }
  | { ok: true; honeypot: false; value: SignupInput }
  | { ok: false; fields: Record<string, SignupFieldProblem> };

export const SIGNUP_LIMITS = { name: 80, businessName: 80, email: 254 } as const;

/** A person's name: letters in any script, spaces, and the marks names carry. */
const PERSON_NAME = /^[\p{L}\p{M}][\p{L}\p{M}\p{Zs}'’׳״.\-]*$/u;

/**
 * A web address written inside a name ("evil.example"): mail programs turn it
 * into a link. An initial keeps its dot ("J.R. Cohen", "Dr. Levi").
 */
const ADDRESS_IN_A_NAME = /\p{L}{2,}\.\p{L}{2,}/u;

/** Anything that would read as markup, an address or a link in the email. */
const NOT_A_BUSINESS_NAME = /[<>@\p{Cc}]|:\/\/|www\./iu;

/** One "@", no spaces, none of the characters a header could be bent with. */
const EMAIL_SHAPE = /^[^\s@<>()"',;:\\]+@[^\s@<>()"',;:\\]+$/;

const text = (v: unknown): string => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "");

export function parseSignupBody(body: unknown): SignupParse {
  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;

  // First, before any field is judged: a bot that filled the hidden field
  // must not learn from a validation answer which of its values were wrong.
  if (typeof b.website === "string" && b.website.trim() !== "") return { ok: true, honeypot: true };

  const fields: Record<string, SignupFieldProblem> = {};

  const name = text(b.name);
  if (!name) fields.name = "required";
  else if (name.length > SIGNUP_LIMITS.name) fields.name = "too_long";
  else if (!PERSON_NAME.test(name) || ADDRESS_IN_A_NAME.test(name)) fields.name = "invalid";

  const businessName = text(b.businessName);
  if (!businessName) fields.businessName = "required";
  else if (businessName.length > SIGNUP_LIMITS.businessName) fields.businessName = "too_long";
  else if (NOT_A_BUSINESS_NAME.test(businessName) || !/[\p{L}\p{N}]/u.test(businessName)) fields.businessName = "invalid";

  const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
  if (!email) fields.email = "required";
  else if (email.length > SIGNUP_LIMITS.email) fields.email = "too_long";
  else if (!EMAIL_SHAPE.test(email) || emailDomain(email) === null) fields.email = "invalid";

  if (b.locale === undefined || b.locale === null || b.locale === "") fields.locale = "required";
  else if (b.locale !== "he" && b.locale !== "en") fields.locale = "invalid";

  // Each box is exactly `true` or it was not ticked ("true" and 1 are not a tick).
  if (b.terms !== true) fields.terms = "required";
  if (b.privacy !== true) fields.privacy = "required";

  if (Object.keys(fields).length > 0) return { ok: false, fields };

  const acceptance = acceptanceOf(b);
  return {
    ok: true,
    honeypot: false,
    value: {
      name,
      email,
      businessName,
      locale: b.locale as "he" | "en",
      capturedText: acceptance?.capturedText ?? null,
    },
  };
}

/**
 * The organization's address name, made from the business name.
 *
 * A name with no Latin letters or digits (a Hebrew one) leaves nothing, and
 * reads "org". The suffix is what makes it unique; the caller supplies it so
 * that a taken name can be tried again with another.
 */
export function signupSlug(businessName: string, suffix: string): string {
  const base = businessName
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return `${base.length >= 2 ? base : "org"}-${suffix}`;
}
