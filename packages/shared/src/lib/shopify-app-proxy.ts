/**
 * Shopify App Proxy - the only trustworthy way the storefront can tell us
 * WHO is chatting.
 *
 * Liquid exposes `customer.id` to the theme, and passing it to us is the
 * obvious thing to do. It is also worthless as proof: it reaches us
 * through the shopper's browser, where anyone can change it. Believing it
 * would let a visitor type someone else's customer id and read their
 * orders - exactly what `customer-access-guard.ts` exists to prevent.
 *
 * An App Proxy request cannot be forged that way. The shopper's browser
 * calls the MERCHANT's own origin (`https://shop.myshopify.com/apps/…`);
 * Shopify then calls us server-to-server, appending `logged_in_customer_id`
 * and a `signature` computed with our app secret. The browser never sees
 * the secret and cannot produce the signature, so a valid signature means
 * Shopify itself is asserting the identity.
 *
 * Two different HMAC schemes exist in this integration and they are not
 * interchangeable:
 *
 *   webhooks     base64 HMAC over the RAW BODY, header X-Shopify-Hmac-Sha256
 *   OAuth        hex HMAC over sorted params joined with "&", param `hmac`
 *   app proxy    hex HMAC over sorted params joined with NOTHING, param `signature`
 *
 * The proxy's empty separator is easy to miss and produces a signature
 * that never matches, which reads exactly like a misconfigured secret.
 */

import crypto from "crypto";

/** How long a minted identity token is good for. */
export const IDENTITY_TOKEN_TTL_SECONDS = 120;

export interface ShopifyCustomerIdentity {
  /** Version marker so the format can change without accepting old shapes. */
  v: 1;
  shopDomain: string;
  /** Shopify's numeric customer id, as a string. */
  customerId: string;
  iat: number;
  exp: number;
}

/**
 * Verify an App Proxy request's signature.
 *
 * `query` is the parsed query string. Values may be arrays when a key
 * repeats, which Shopify joins with a comma before hashing.
 */
export function verifyAppProxySignature(
  query: Record<string, string | string[] | undefined>,
  secret: string,
): boolean {
  if (!secret) return false;

  const provided = query.signature;
  if (typeof provided !== "string" || !provided) return false;

  const message = Object.keys(query)
    .filter((key) => key !== "signature")
    .sort()
    .map((key) => {
      const value = query[key];
      const joined = Array.isArray(value) ? value.join(",") : (value ?? "");
      // No separator between pairs. This is the part that differs from
      // the OAuth callback, which joins with "&".
      return `${key}=${joined}`;
    })
    .join("");

  const expected = crypto.createHmac("sha256", secret).update(message, "utf8").digest("hex");

  // Length check first: timingSafeEqual throws on a length mismatch, and
  // the throw itself would be an oracle.
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * The customer id Shopify asserts for this request.
 *
 * Empty or absent means a signed-in shopper was not present - a logged-out
 * visitor still produces a perfectly valid signed request, so "no id" is a
 * normal answer and not a failure.
 */
export function loggedInCustomerId(
  query: Record<string, string | string[] | undefined>,
): string | null {
  const raw = query.logged_in_customer_id;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  // Deliberately NOT trimmed: this value is part of the signed message, so
  // accepting a padded variant would mean acting on an id that differs
  // from the one Shopify actually signed. Shopify sends a bare numeric id,
  // and an empty string when the shopper is not signed in.
  if (!/^\d{1,32}$/.test(value)) return null;
  return value;
}

// ─── The identity token ──────────────────────────────────────
//
// A short-lived, encrypted hand-off from the proxy route to the bootstrap
// route. It exists so the rest of the widget API can stay where it is:
// only the identity hop needs to travel through Shopify.

function identityKey(): Buffer {
  const secret =
    process.env.WIDGET_SESSION_SECRET || process.env.JWT_SECRET || "";
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "WIDGET_SESSION_SECRET (or JWT_SECRET) is required in production. " +
          "Refusing to issue customer identity tokens with a default secret.",
      );
    }
    return derive("slc:dev-identity-secret");
  }
  return derive(secret);
}

function derive(secret: string): Buffer {
  // A different label from the visitor session's, so the two tokens can
  // never be swapped for one another even under the same secret.
  return crypto.createHash("sha256").update(`shopify-live-chat:identity:${secret}`).digest();
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** AES-256-GCM, `iv || tag || ciphertext`, base64url - as the visitor session. */
export function signCustomerIdentity(input: {
  shopDomain: string;
  customerId: string;
  ttlSeconds?: number;
}): string {
  const iat = Math.floor(Date.now() / 1000);
  const payload: ShopifyCustomerIdentity = {
    v: 1,
    shopDomain: input.shopDomain,
    customerId: input.customerId,
    iat,
    exp: iat + (input.ttlSeconds ?? IDENTITY_TOKEN_TTL_SECONDS),
  };
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", identityKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return b64url(Buffer.concat([iv, cipher.getAuthTag(), ciphertext]));
}

/**
 * Decrypt and validate an identity token.
 *
 * `expectedShopDomain` is required: a token minted for one store must not
 * be accepted by another, or a merchant who runs two stores could carry an
 * identity across them.
 */
export function verifyCustomerIdentity(
  token: unknown,
  expectedShopDomain: string,
): ShopifyCustomerIdentity | null {
  if (typeof token !== "string" || !token || token.length > 4096) return null;

  let plaintext: string;
  try {
    const raw = fromB64url(token);
    if (raw.length <= IV_BYTES + TAG_BYTES) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", identityKey(), raw.subarray(0, IV_BYTES));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    plaintext = Buffer.concat([
      decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Wrong key, flipped bit, truncated token, junk: one answer.
    return null;
  }

  let payload: ShopifyCustomerIdentity;
  try {
    payload = JSON.parse(plaintext);
  } catch {
    return null;
  }

  if (payload?.v !== 1) return null;
  if (!payload.shopDomain || !payload.customerId) return null;
  if (payload.shopDomain !== expectedShopDomain) return null;

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) return null;
  // A token from the future is a clock problem or a forgery attempt; both
  // are reasons not to believe it.
  if (typeof payload.iat !== "number" || payload.iat > now + 60) return null;

  return payload;
}

/**
 * The `customerExternalId` a verified shopper's conversations are keyed by.
 *
 * Namespaced so it can never collide with an anonymous visitor id, and so
 * it is obvious in the database which conversations are attached to a real
 * customer and which are not.
 */
export function verifiedCustomerExternalId(customerId: string): string {
  return `shopify-customer:${customerId}`;
}

/** True when a conversation is attached to a proven Shopify customer. */
export function isVerifiedCustomerExternalId(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith("shopify-customer:");
}
