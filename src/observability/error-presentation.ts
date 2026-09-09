import { ApiError, type ApiErrorKind } from '@/api/client/api-error';

/**
 * How a failure should be surfaced.
 *
 * A single global toast for everything is the failure mode this exists to
 * prevent. Where an error appears determines whether the user can act on it:
 * a validation failure belongs beside the field, a dead page belongs in the
 * page, and a failed background refresh belongs somewhere quiet.
 */
export type ErrorPresentation =
  /** Beside the field or control that caused it. */
  | 'inline'
  /** Replaces the page or region; the user cannot continue without resolving. */
  | 'blocking'
  /** Attached to the action the user just took. */
  | 'action'
  /** Non-blocking; the surrounding content is still usable. */
  | 'warning'
  /** Interrupts everything: the session is over. */
  | 'reauthenticate';

export interface PresentedError {
  readonly kind: ApiErrorKind;
  readonly presentation: ErrorPresentation;
  /** Translation key under the `errors` namespace. */
  readonly titleKey: string;
  readonly bodyKey: string;
  /** Whether offering a retry button makes sense. */
  readonly retryable: boolean;
  /** Shown so a user can quote it to support. Absent when the API sent none. */
  readonly requestId?: string;
  readonly fieldErrors: ReadonlyMap<string, string>;
}

const DEFAULT_PRESENTATION: Record<ApiErrorKind, ErrorPresentation> = {
  network: 'warning',
  timeout: 'warning',
  cancelled: 'warning',
  authentication: 'reauthenticate',
  authorization: 'blocking',
  // The tenant is locked out commercially. Nothing on the page will work and
  // no retry helps, so it takes over the region rather than nagging quietly.
  tenant_inactive: 'blocking',
  validation: 'inline',
  not_found: 'blocking',
  conflict: 'action',
  rate_limited: 'warning',
  integration: 'action',
  server: 'action',
  contract: 'action',
  unknown: 'action',
};

/**
 * Turns any thrown value into something the interface can render.
 *
 * `context` lets a caller override the default placement: the same 404 is a
 * blocking page error when it is the record you navigated to, and an inline
 * one when it is a lookup inside a form.
 */
export function presentError(
  error: unknown,
  context?: { readonly presentation?: ErrorPresentation },
): PresentedError {
  const apiError = error instanceof ApiError ? error : null;
  const kind: ApiErrorKind = apiError?.kind ?? 'unknown';

  return {
    kind,
    presentation: context?.presentation ?? DEFAULT_PRESENTATION[kind],
    titleKey: `kind.${kind}.title`,
    bodyKey: `kind.${kind}.body`,
    retryable: apiError?.isRetryable ?? false,
    requestId: apiError?.requestId,
    fieldErrors: new Map(apiError?.fieldErrors.map((field) => [field.field, field.message]) ?? []),
  };
}
