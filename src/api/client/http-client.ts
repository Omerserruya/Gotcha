import type { z } from 'zod';

import { errorEnvelopeSchema } from '@/api/contracts/envelope';
import type { ApiEndpoint } from '@/api/endpoints/registry';

import { ApiError, kindFromStatus, type FieldError } from './api-error';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface HttpRequest<TPayload extends z.ZodType> {
  readonly method: HttpMethod;
  readonly endpoint: ApiEndpoint;
  /** Schema for the value inside the success envelope's `data`. */
  readonly payload: TPayload;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined | null>>;
  readonly body?: unknown;
  /** Caller-owned cancellation, composed with the client's own timeout. */
  readonly signal?: AbortSignal;
  /** Overrides the client default for this one request. */
  readonly timeoutMs?: number;
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Skips envelope unwrapping and parses the whole body.
   *
   * Needed where `data` is a sibling of other fields rather than the payload
   * itself — `/api/notifications` answers `{ data, nextCursor }`, and
   * unwrapping would throw the cursor away and silently break pagination.
   */
  readonly raw?: boolean;
}

/** Everything the transport needs that differs between server and browser. */
export interface HttpClientOptions {
  /** Absolute origin, or '' for same-origin (browser → this app's BFF). */
  readonly baseUrl: string;
  readonly defaultTimeoutMs: number;
  /**
   * Contributes per-request headers: authorization, tenant, correlation id.
   * Async so a server-side implementation can read the session cookie.
   */
  readonly prepareHeaders?: (request: {
    method: HttpMethod;
    route: string;
  }) => Promise<Record<string, string>> | Record<string, string>;
  /** Invoked once per 401, before the error is thrown. */
  readonly onUnauthenticated?: (error: ApiError) => void | Promise<void>;
  /** Invoked for every failure, for logging/telemetry. Must not throw. */
  readonly onError?: (error: ApiError) => void;
  /** Forwarded to fetch; lets server callers opt into Next's data cache. */
  readonly fetchOptions?: Pick<RequestInit, 'cache' | 'credentials'> & {
    next?: { revalidate?: number | false; tags?: string[] };
  };
}

/** Header the platform echoes for correlating a request across services. */
const REQUEST_ID_HEADER = 'x-request-id';

function newRequestId(): string {
  return globalThis.crypto.randomUUID();
}

function buildUrl(baseUrl: string, path: string, query: HttpRequest<z.ZodType>['query']): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    search.append(key, String(value));
  }
  const queryString = search.toString();
  return `${baseUrl}${path}${queryString ? `?${queryString}` : ''}`;
}

/**
 * Composes the caller's cancellation with a timeout, and reports which one
 * fired - a user navigating away and a slow backend are different events and
 * must not be logged, retried or surfaced identically.
 */
function composeSignals(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; didTimeOut: () => boolean } {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
  return { signal, didTimeOut: () => timeoutSignal.aborted };
}

async function readErrorBody(response: Response): Promise<{
  developerMessage?: string;
  fieldErrors?: FieldError[];
  code?: string;
  failureCode?: string;
  failureDetail?: Readonly<Record<string, unknown>>;
  invoiceId?: string | null;
  tenantStatus?: string;
  checkoutPath?: string;
  upgradePath?: string;
  feature?: string;
  currentPlan?: string | null;
  limit?: number;
  current?: number;
}> {
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return {};
  }
  const parsed = errorEnvelopeSchema.safeParse(raw);
  if (!parsed.success) return {};
  return {
    developerMessage: parsed.data.error,
    fieldErrors: parsed.data.details,
    code: parsed.data.code,
    failureCode: parsed.data.failureCode,
    failureDetail: parsed.data.detail,
    invoiceId: parsed.data.invoiceId,
    tenantStatus: parsed.data.tenantStatus,
    checkoutPath: parsed.data.checkoutPath,
    upgradePath: parsed.data.upgradePath,
    feature: parsed.data.feature,
    currentPlan: parsed.data.currentPlan,
    limit: parsed.data.limit,
    current: parsed.data.current,
  };
}

export class HttpClient {
  constructor(private readonly options: HttpClientOptions) {}

  async request<TPayload extends z.ZodType>(
    request: HttpRequest<TPayload>,
  ): Promise<z.infer<TPayload>> {
    const { method, endpoint, payload, query, body, headers } = request;
    const requestId = newRequestId();
    const timeoutMs = request.timeoutMs ?? this.options.defaultTimeoutMs;
    const { signal, didTimeOut } = composeSignals(request.signal, timeoutMs);

    const fail = (init: Omit<ConstructorParameters<typeof ApiError>[0], 'method' | 'route'>) => {
      const error = new ApiError({ ...init, method, route: endpoint.route });
      this.options.onError?.(error);
      return error;
    };

    const contributed =
      (await this.options.prepareHeaders?.({ method, route: endpoint.route })) ?? {};

    let response: Response;
    try {
      response = await fetch(buildUrl(this.options.baseUrl, endpoint.path, query), {
        method,
        signal,
        ...this.options.fetchOptions,
        headers: {
          accept: 'application/json',
          [REQUEST_ID_HEADER]: requestId,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...contributed,
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (cause) {
      if (didTimeOut()) {
        throw fail({ kind: 'timeout', requestId, cause });
      }
      if (request.signal?.aborted) {
        throw fail({ kind: 'cancelled', requestId, cause });
      }
      throw fail({ kind: 'network', requestId, cause });
    }

    // Prefer the correlation id the platform chose, if it returns one.
    const effectiveRequestId = response.headers.get(REQUEST_ID_HEADER) ?? requestId;

    if (!response.ok) {
      const {
        developerMessage,
        fieldErrors,
        code,
        failureCode,
        failureDetail,
        invoiceId,
        tenantStatus,
        checkoutPath,
        upgradePath,
        feature,
        currentPlan,
        limit,
        current,
      } = await readErrorBody(response);
      const error = fail({
        /*
         * A `TENANT_*` code means the ORGANIZATION is gated, not that this
         * user lacks a permission. The backend sends some of those as 403
         * (setup and onboarding still pending) and some as 402 (no plan,
         * payment unconfirmed), so status alone misfiles half of them as an
         * authorization failure - and "ask a workspace admin for access" is
         * the wrong thing to tell someone whose onboarding is unfinished.
         */
        kind: code?.startsWith('TENANT_') ? 'tenant_inactive' : kindFromStatus(response.status),
        status: response.status,
        developerMessage,
        fieldErrors,
        code,
        failureCode,
        failureDetail,
        invoiceId,
        tenantStatus,
        checkoutPath,
        upgradePath,
        feature,
        currentPlan,
        limit,
        current,
        requestId: effectiveRequestId,
      });
      if (error.kind === 'authentication') {
        await this.options.onUnauthenticated?.(error);
      }
      throw error;
    }

    if (response.status === 204) {
      const parsed = payload.safeParse(undefined);
      if (parsed.success) return parsed.data as z.infer<TPayload>;
      throw fail({
        kind: 'contract',
        status: 204,
        developerMessage: 'Endpoint returned no content but a payload was expected.',
        requestId: effectiveRequestId,
      });
    }

    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch (cause) {
      throw fail({
        kind: 'contract',
        status: response.status,
        developerMessage: 'Response body was not valid JSON.',
        requestId: effectiveRequestId,
        cause,
      });
    }

    /*
     * Unwrap `{ data }`.
     *
     * The envelope is not universal: roughly a third of handlers use it and
     * the rest answer bare, and at least one more shape exists
     * (`{ ok, pending, reviews }`). So a missing envelope is normal rather
     * than a contract break — and `raw` opts out entirely for the endpoints
     * where `data` sits alongside other fields.
     */
    const unwrapped =
      !request.raw && typeof envelope === 'object' && envelope !== null && 'data' in envelope
        ? (envelope as { data: unknown }).data
        : envelope;

    const parsed = payload.safeParse(unwrapped);
    if (!parsed.success) {
      throw fail({
        kind: 'contract',
        status: response.status,
        // Paths only - never the values, which may carry customer data.
        developerMessage: `Response did not match contract at: ${parsed.error.issues
          .map((issue) => issue.path.join('.') || '(root)')
          .join(', ')}`,
        requestId: effectiveRequestId,
        cause: parsed.error,
      });
    }

    return parsed.data as z.infer<TPayload>;
  }

  get<T extends z.ZodType>(request: Omit<HttpRequest<T>, 'method' | 'body'>) {
    return this.request({ ...request, method: 'GET' });
  }

  post<T extends z.ZodType>(request: Omit<HttpRequest<T>, 'method'>) {
    return this.request({ ...request, method: 'POST' });
  }

  patch<T extends z.ZodType>(request: Omit<HttpRequest<T>, 'method'>) {
    return this.request({ ...request, method: 'PATCH' });
  }

  put<T extends z.ZodType>(request: Omit<HttpRequest<T>, 'method'>) {
    return this.request({ ...request, method: 'PUT' });
  }

  delete<T extends z.ZodType>(request: Omit<HttpRequest<T>, 'method'>) {
    return this.request({ ...request, method: 'DELETE' });
  }
}
