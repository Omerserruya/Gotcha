/**
 * The failure taxonomy the whole product reasons about.
 *
 * UI never inspects a raw HTTP status or a backend message string. It matches
 * on `kind`, which is stable, exhaustive and translatable. The backend's own
 * `error` text is kept as a developer-facing detail only - it is English,
 * written for engineers, and must never be shown to a customer.
 */
export type ApiErrorKind =
  /** The request never reached the server: offline, DNS, TLS, CORS. */
  | 'network'
  /** The request was abandoned because it exceeded its budget. */
  | 'timeout'
  /** The caller aborted deliberately (navigation, a superseded query). */
  | 'cancelled'
  /** 401 - no session, or the session is no longer valid. */
  | 'authentication'
  /** 403 - authenticated, but not permitted. */
  | 'authorization'
  /**
   * 402 - the tenant itself is gated: suspended, still onboarding, or without
   * an active plan. Not an error the user can retry past and not a permission
   * problem; it is a state the product has to render honestly.
   */
  | 'tenant_inactive'
  /** 400/422 with field-level detail. */
  | 'validation'
  /** 404 - absent, or invisible to this tenant. */
  | 'not_found'
  /** 409 - the resource changed underneath us. */
  | 'conflict'
  /** 429 - throttled. */
  | 'rate_limited'
  /** A third-party system the backend depends on failed. */
  | 'integration'
  /** 5xx. */
  | 'server'
  /** The response did not match the contract we parse it against. */
  | 'contract'
  | 'unknown';

/** A single field-level failure, as returned by the platform's `validate()`. */
export interface FieldError {
  readonly field: string;
  readonly message: string;
}

export interface ApiErrorInit {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  /** Developer-facing text from the backend. Never rendered to end users. */
  readonly developerMessage?: string;
  readonly fieldErrors?: readonly FieldError[];
  /** Correlation id, when the platform supplies one. */
  readonly requestId?: string;
  readonly method?: string;
  /** Endpoint path with parameters still templated, safe for grouping. */
  readonly route?: string;
  /**
   * Machine-readable reason from the tenant gate (402) and from the routes
   * that send a `code` field — the entitlement envelope in
   * `packages/shared`, and `auth`'s workspace routes.
   *
   * ⚠ MOST ROUTE-LEVEL REFUSALS DO NOT SEND ONE. A service that answers
   * `{ error: "no_knowledge_base" }` puts its reason in `developerMessage`,
   * and the billing services put theirs in `failureCode`. Matching `code`
   * against a route that sends neither compiles and never fires. Read the
   * route's own `json()` before choosing the field.
   */
  readonly code?: string;
  /** The billing services' reason. See `errorEnvelopeSchema.failureCode`. */
  readonly failureCode?: string;
  /** Per-code payload for `failureCode`; shape depends on the code. */
  readonly failureDetail?: Readonly<Record<string, unknown>>;
  /** Set only where a charge was actually attempted. */
  readonly invoiceId?: string | null;
  /** Tenant lifecycle status the gate reported (402). */
  readonly tenantStatus?: string;
  /** In-app path that would lift a 402, when the backend names one. */
  readonly checkoutPath?: string;
  /**
   * The FEATURE-level 402's own path, which is a different field from
   * `checkoutPath` and arrives from a different middleware. See
   * `errorEnvelopeSchema.upgradePath`.
   */
  readonly upgradePath?: string;
  /** The refused feature key, e.g. `ai.copilot`. */
  readonly feature?: string;
  /** The plan the tenant is on, `null` when it has none. */
  readonly currentPlan?: string | null;
  /** Limit breaches only. */
  readonly limit?: number;
  readonly current?: number;
  readonly cause?: unknown;
}

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  readonly developerMessage?: string;
  readonly fieldErrors: readonly FieldError[];
  readonly requestId?: string;
  readonly method?: string;
  readonly route?: string;
  readonly code?: string;
  readonly failureCode?: string;
  readonly failureDetail?: Readonly<Record<string, unknown>>;
  readonly invoiceId?: string | null;
  readonly tenantStatus?: string;
  readonly checkoutPath?: string;
  readonly upgradePath?: string;
  readonly feature?: string;
  readonly currentPlan?: string | null;
  readonly limit?: number;
  readonly current?: number;

  constructor(init: ApiErrorInit) {
    super(init.developerMessage ?? init.kind, { cause: init.cause });
    this.name = 'ApiError';
    this.kind = init.kind;
    this.status = init.status;
    this.developerMessage = init.developerMessage;
    this.fieldErrors = init.fieldErrors ?? [];
    this.requestId = init.requestId;
    this.method = init.method;
    this.route = init.route;
    this.code = init.code;
    this.failureCode = init.failureCode;
    this.failureDetail = init.failureDetail;
    this.invoiceId = init.invoiceId;
    this.tenantStatus = init.tenantStatus;
    this.checkoutPath = init.checkoutPath;
    this.upgradePath = init.upgradePath;
    this.feature = init.feature;
    this.currentPlan = init.currentPlan;
    this.limit = init.limit;
    this.current = init.current;
  }

  /**
   * Whether retrying the identical request could plausibly succeed.
   * Deliberately conservative: a write that failed for an unknown reason is
   * not retried, because we cannot know it did not partially apply.
   */
  get isRetryable(): boolean {
    return (
      this.kind === 'network' ||
      this.kind === 'timeout' ||
      this.kind === 'rate_limited' ||
      this.kind === 'server' ||
      this.kind === 'integration'
    );
  }

  /** True when the user must re-authenticate before anything else can work. */
  get requiresReauthentication(): boolean {
    return this.kind === 'authentication';
  }

  /** Context safe to attach to a log or a Sentry event: no bodies, no PII. */
  toDiagnostics(): Record<string, unknown> {
    return {
      kind: this.kind,
      status: this.status,
      method: this.method,
      route: this.route,
      requestId: this.requestId,
      fieldCount: this.fieldErrors.length,
      // Enum-valued, never PII: safe to log and the only way to tell a
      // suspended tenant apart from one that never finished onboarding.
      ...(this.code ? { code: this.code } : {}),
      ...(this.tenantStatus ? { tenantStatus: this.tenantStatus } : {}),
    };
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/** Maps an HTTP status onto the taxonomy. */
export function kindFromStatus(status: number): ApiErrorKind {
  if (status === 401) return 'authentication';
  if (status === 402) return 'tenant_inactive';
  if (status === 403) return 'authorization';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 422 || status === 400) return 'validation';
  if (status === 429) return 'rate_limited';
  if (status === 502 || status === 503 || status === 504) return 'integration';
  if (status >= 500) return 'server';
  return 'unknown';
}
