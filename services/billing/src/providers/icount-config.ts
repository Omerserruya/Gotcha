/**
 * iCount authentication and configuration.
 *
 * API TOKEN ONLY. There is one authentication method and no fallback: a missing
 * token is a hard failure, never a downgrade to some other credential. Mixed
 * -mode auth is how a service ends up quietly sending a password because a
 * token lookup returned empty.
 *
 * There is deliberately no ICOUNT_AUTH_MODE knob. A setting whose only legal
 * value is the one thing the code does is not configuration, it is a chance to
 * misconfigure something that has no alternative.
 *
 * Transport is `Authorization: Bearer <token>` with a JSON body, verified
 * against iCount's own first-party integration, which builds every request as:
 *
 *     POST https://api.icount.co.il/api/v3.php/{action}
 *     Content-Type: application/json
 *     Authorization: Bearer {access_token}
 *
 * The token therefore never appears in a URL or a request body. Tokens are
 * created in the iCount UI under System -> Settings -> Automation -> API Tokens.
 *
 * Config (env, billing service only - never NEXT_PUBLIC):
 *   ICOUNT_MODE            "mock" (default) | "simulator" | "live"
 *   ICOUNT_API_TOKEN       the SID / API token
 *   ICOUNT_API_BASE_URL    default https://api.icount.co.il/api/v3.php
 *   ICOUNT_PAYMENT_PAGE_ID the "Credit card token" PayPage id - CONFIGURATION,
 *                          not a credential
 *   ICOUNT_WEBHOOK_SECRET  shared secret for callback verification
 *   ICOUNT_ALLOW_LIVE      explicit acknowledgement required to charge live
 */
import { redact } from "@chatcenter/shared";

const DEFAULT_API_BASE_URL = "https://api.icount.co.il/api/v3.php";

/**
 * The three modes, and what separates them.
 *
 *   mock       no network, no credentials, deterministic fixtures. The default,
 *              so a stack that was never configured cannot charge anything.
 *   simulator  no network either, but it models the provider's failure
 *              behaviour: declines, timeouts, ambiguous outcomes. This is what
 *              the end-to-end payment tests run against, because the paths that
 *              matter most are the ones where things go wrong, and those cannot
 *              be exercised against a real payments API.
 *   live       real network, real money.
 *
 * Only `live` reaches the network. Simulator is deliberately NOT a mode that
 * "sometimes" calls out - a mode that occasionally touches production is a mode
 * that will touch production on the wrong day.
 */
export type IcountMode = "mock" | "simulator" | "test" | "live";

/**
 * The three DEPLOYMENT modes are mock, test and live.
 *
 * `simulator` is not a fourth deployment mode: it is the in-process failure
 * engine the automated suite runs against - declines, timeouts, ambiguous
 * outcomes - and it reaches the network exactly as often as mock does, which is
 * never. It is spelled separately only so the test suite can ask for failure
 * modelling without pretending to be configured for a provider.
 */
export function icountMode(): IcountMode {
  const raw = String(process.env.ICOUNT_MODE || "mock").toLowerCase();
  if (raw === "live") return "live";
  if (raw === "test") {
    // Test reaches the real API with real credentials. It is opt-in for the
    // same reason live is, and it degrades to mock rather than quietly
    // enabling network calls nobody asked for.
    return process.env.ICOUNT_ALLOW_TEST === "true" ? "test" : "mock";
  }
  if (raw === "simulator") {
    // Simulator is opt-in. Without the acknowledgement it degrades to mock
    // rather than silently enabling a mode someone did not ask for.
    return process.env.ICOUNT_ALLOW_SIMULATOR === "true" ? "simulator" : "mock";
  }
  return "mock";
}

export function isLive(): boolean {
  return icountMode() === "live";
}

export function isSimulator(): boolean {
  return icountMode() === "simulator";
}

/** Real HTTP to api.icount.co.il, against the configured TEST account. */
export function isTest(): boolean {
  return icountMode() === "test";
}

/**
 * True for every mode that performs no network call and can charge nothing.
 *
 * Kept as the single question call sites ask before deciding whether a guard
 * applies, so adding a mode later cannot leave one of them behind.
 *
 * Written as an explicit list of the no-network modes rather than `!== "live"`.
 * That inversion was correct while live was the only mode that reached the
 * network; with `test` added it would have made every provider method
 * short-circuit to the fixture and a "real" test run would have proved nothing
 * while looking like it passed.
 */
export function isMock(): boolean {
  const mode = icountMode();
  return mode === "mock" || mode === "simulator";
}

/** Every mode that performs real HTTP against the provider. */
export function isNetworkMode(): boolean {
  return !isMock();
}

/**
 * The account this stack is allowed to be talking to in test mode.
 *
 * Configuration, not a credential: it names which iCount account the token is
 * expected to resolve to, so a production token dropped into a dev .env is
 * caught by identity rather than by an invoice.
 */
export function icountTestAccountId(): string | null {
  const id = (process.env.ICOUNT_TEST_ACCOUNT_ID || "").trim();
  return id || null;
}

export function icountApiBaseUrl(): string {
  return (process.env.ICOUNT_API_BASE_URL || DEFAULT_API_BASE_URL).replace(/\/+$/, "");
}

/**
 * The tokenization PayPage id.
 *
 * Configuration, not a secret: it identifies which hosted page to send a
 * customer to and grants no access on its own. It is still server-side only,
 * because the checkout URL is generated by the backend.
 */
export function icountPaymentPageId(): string | null {
  const id = (process.env.ICOUNT_PAYMENT_PAGE_ID || "").trim();
  return id || null;
}

/**
 * The API token, or a hard failure.
 *
 * Deliberately throws rather than returning empty: an unauthenticated call to
 * a payments API must never be attempted, and a caller that forgot to check
 * should crash here rather than send a request with no Authorization header.
 */
export function icountApiToken(): string {
  const token = (process.env.ICOUNT_API_TOKEN || "").trim();
  if (!token) {
    throw new Error(
      "[icount] ICOUNT_API_TOKEN is not configured - refusing to call the iCount API unauthenticated (there is no credential fallback)",
    );
  }
  return token;
}

/** Request headers for an authenticated call. Bearer transport, JSON body. */
export function authHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${icountApiToken()}`,
  };
}

/**
 * Startup gate.
 *
 * Fails closed when the service is configured to talk to the real iCount API
 * without a token: better to refuse to boot than to run a billing service whose
 * every charge will fail at the worst possible moment.
 *
 * Mock mode is exempt because it performs no network calls and holds no
 * credentials by design - requiring a real token there would break every
 * development stack and CI run without protecting anything.
 */
export function assertIcountConfig(env: NodeJS.ProcessEnv = process.env): void {
  const mode = String(env.ICOUNT_MODE || "mock").toLowerCase();

  if (mode === "test") {
    // Test and live are mutually exclusive intents. Set together, the operator
    // has said two contradictory things about where the money goes, and
    // resolving that silently in either direction is the wrong call.
    if (env.ICOUNT_ALLOW_LIVE === "true") {
      throw new Error(
        "[icount] ICOUNT_MODE=test with ICOUNT_ALLOW_LIVE=true - refusing to start: these say opposite things about which account is charged",
      );
    }
    if (env.ICOUNT_ALLOW_TEST !== "true") {
      throw new Error(
        "[icount] ICOUNT_MODE=test requires ICOUNT_ALLOW_TEST=true - refusing to start a stack that would reach the provider without the acknowledgement",
      );
    }
    if (!(env.ICOUNT_API_TOKEN || "").trim()) {
      throw new Error(
        "[icount] ICOUNT_MODE=test requires ICOUNT_API_TOKEN - refusing to start a billing service that cannot authenticate",
      );
    }
    // Without this, "test mode" is a label rather than a guarantee: nothing
    // would stop the configured token belonging to the production account, and
    // the first charge would be real money on a real customer's card.
    if (!(env.ICOUNT_TEST_ACCOUNT_ID || "").trim()) {
      throw new Error(
        "[icount] ICOUNT_MODE=test requires ICOUNT_TEST_ACCOUNT_ID - refusing to start without knowing which account the token must resolve to",
      );
    }
    if (env.NODE_ENV === "production") {
      throw new Error(
        "[icount] ICOUNT_MODE=test is refused in production - a production stack must not be pointed at a test terminal",
      );
    }
    return;
  }

  if (mode !== "live") return; // mock/simulator: no network, no credentials needed

  if (!(env.ICOUNT_API_TOKEN || "").trim()) {
    throw new Error(
      "[icount] ICOUNT_MODE=live requires ICOUNT_API_TOKEN - refusing to start a billing service that cannot authenticate",
    );
  }
}

/**
 * Mask secrets before anything reaches a log or an error message.
 *
 * The shared `redact()` covers Bearer headers and token-shaped fields. It
 * cannot know THIS service's token when it appears bare, so the configured
 * value is stripped literally as well.
 */
export function redactIcount(value: unknown): unknown {
  const safe = redact(value);
  const token = (process.env.ICOUNT_API_TOKEN || "").trim();
  if (!token || token.length < 8) return safe;
  try {
    const json = JSON.stringify(safe);
    if (!json || !json.includes(token)) return safe;
    return JSON.parse(json.split(token).join("[REDACTED]"));
  } catch {
    return safe;
  }
}

/**
 * Turn a provider/transport failure into a safe Error.
 *
 * An axios error carries `config.headers`, which holds the Authorization
 * header. Rethrowing it verbatim would put the API token into every log that
 * catches it, so the original is dropped entirely and only a redacted summary
 * survives.
 */
export function sanitizeIcountError(path: string, err: unknown): Error {
  const e = err as any;
  const status = e?.response?.status;
  const detail =
    e?.response?.data?.error_description ||
    e?.response?.data?.reason ||
    e?.message ||
    "request_failed";
  return new Error(
    `[icount] ${path} failed${status ? ` (HTTP ${status})` : ""}: ${String(redactIcount(detail))}`,
  );
}

/**
 * Which payment capabilities are switched on.
 *
 * Separate from ICOUNT_MODE, and deliberately so. Mode answers "may this stack
 * reach the provider and move real money". These answer "is this capability
 * part of the product yet" - a question with a different answer per capability
 * and a different owner. Collecting cards can be switched on before charging
 * them is, and self-service checkout can stay closed while both work.
 *
 * All three default OFF. A capability that switches itself on when nobody has
 * configured anything is a capability that will be on somewhere nobody meant it
 * to be, and for these three that means taking a customer's money.
 */
export type PaymentCapability = "checkout" | "tokenization" | "stored_card_charge";

const CAPABILITY_ENV: Record<PaymentCapability, string> = {
  checkout: "ICOUNT_CHECKOUT_ENABLED",
  tokenization: "ICOUNT_TOKENIZATION_ENABLED",
  stored_card_charge: "ICOUNT_STORED_CARD_CHARGE_ENABLED",
};

/**
 * Opt-in, and only on the exact string "true".
 *
 * Not truthiness: "false", "0" and "no" all read as true under a loose check,
 * and each of those is something an operator would plausibly write meaning off.
 */
export function paymentCapabilityEnabled(capability: PaymentCapability): boolean {
  return String(process.env[CAPABILITY_ENV[capability]] || "").trim().toLowerCase() === "true";
}

export class PaymentCapabilityDisabledError extends Error {
  readonly code = "PAYMENT_CAPABILITY_DISABLED";
  /**
   * Nothing was sent, and nothing could have been.
   *
   * This is thrown by a switch that is read before any I/O happens, so the
   * money provably did not move. Saying so is not a detail: without it the
   * caller falls back on "we do not know", which is the right default for a
   * mid-flight failure and exactly wrong here - it left the charge PENDING,
   * and a PENDING row reads as in-flight for ever, so the idempotency key was
   * permanently occupied and that subscription could never be charged again.
   *
   * It is the earliest guard in the chain and was the only one not marked.
   */
  readonly neverSent = true;
  readonly failureCode: string;
  constructor(readonly capability: PaymentCapability) {
    super(
      `[icount] the "${capability}" capability is disabled. ` +
        `Set ${CAPABILITY_ENV[capability]}=true to enable it.`,
    );
    this.name = "PaymentCapabilityDisabledError";
    this.failureCode = `capability_disabled: ${capability}`;
  }
}

/**
 * Refuse before doing anything.
 *
 * Called at the provider boundary rather than by each caller, because a guard
 * every caller has to remember is a guard one caller will not.
 */
export function assertPaymentCapability(capability: PaymentCapability): void {
  if (!paymentCapabilityEnabled(capability)) throw new PaymentCapabilityDisabledError(capability);
}
