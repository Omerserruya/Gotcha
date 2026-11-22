/**
 * Sign in with Google: the few rules more than one route asks.
 *
 * Authentik owns the connection between a person and their Google account. It
 * makes one the first time the person signs in with Google, by an exact match
 * on the email. Nothing here creates one and nothing here signs anything.
 */
import { listUserSourceConnections, hasUsablePassword } from "@chatcenter/shared";

/** The Authentik source that is Google. Unset = the feature is off everywhere. */
export function googleSourceSlug(): string {
  return (process.env.AUTHENTIK_GOOGLE_SOURCE_SLUG || "").trim();
}

/**
 * Whether the Google connection can go, given everything else the person holds.
 * "Another way in" is a usable password or a connection to another source. When
 * the password question cannot be answered (the IdP failed, or the policy that
 * answers it is not set up) the answer is "no", so the doubt always falls on
 * the side of keeping the person able to sign in.
 */
export async function hasAnotherWayIn(pk: number, otherConnections: number): Promise<boolean> {
  if (otherConnections > 0) return true;
  return (await hasUsablePassword(pk)) === true;
}

export type EmailChangeGoogleStep =
  /** No Google connection (or the feature is off): the change needs nothing more. */
  | { state: "none" }
  /** The connection must go first; this is its id. */
  | { state: "remove"; connectionId: string }
  /** No usable password can be proven: the email must not change. */
  | { state: "blocked" };

/**
 * What an email change has to do about the person's Google connection.
 *
 * The connection was made by matching the OLD address. Left in place after the
 * address changes, the Google account of the old address would still open this
 * person's account, so a changed email always removes it. And because removing
 * it must never lock the person out, the change is refused unless the person
 * is known to have a usable password. Only a password counts here: a
 * connection to some other source was matched on the old address as well, so
 * it is no proof of a way in that survives the change. An answer that cannot
 * be had (the IdP failed, or the policy that answers it is not set up) is "no".
 *
 * Throws when Authentik cannot be read: "could not ask" is never "no connection".
 */
export async function emailChangeGoogleStep(pk: number): Promise<EmailChangeGoogleStep> {
  const slug = googleSourceSlug();
  if (!slug) return { state: "none" };
  const connections = await listUserSourceConnections(pk);
  const google = connections.find((c) => c.sourceSlug === slug);
  if (!google) return { state: "none" };
  if ((await hasUsablePassword(pk)) !== true) return { state: "blocked" };
  return { state: "remove", connectionId: google.id };
}
