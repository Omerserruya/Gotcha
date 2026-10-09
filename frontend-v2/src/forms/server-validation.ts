import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';

import { ApiError } from '@/api/client/api-error';

/**
 * Moves a server's field-level rejections onto the form that produced them.
 *
 * Client validation is a convenience; the server is the authority, and it will
 * reject things the browser could not know about - a name already taken, a
 * value another user changed a second ago. When that happens the error has to
 * land on the field, not in a toast: a toast leaves the user staring at a form
 * with no indication of which of twelve inputs is wrong.
 *
 * Anything the server rejects that has no matching field becomes a form-level
 * error, so it is still shown rather than silently dropped.
 *
 * Returns true when the failure was handled here, so callers can fall back to
 * their general error handling when it was not.
 */
export function applyServerValidation<TValues extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<TValues>,
  knownFields: readonly Path<TValues>[],
): boolean {
  if (!(error instanceof ApiError) || error.kind !== 'validation') return false;
  if (error.fieldErrors.length === 0) return false;

  for (const fieldError of error.fieldErrors) {
    const field = fieldError.field as Path<TValues>;
    if (knownFields.includes(field)) {
      // `type: 'server'` distinguishes these from client-side failures, so a
      // field can show that the server specifically objected.
      setError(field, { type: 'server', message: fieldError.message });
    } else {
      setError('root.serverError' as Path<TValues>, {
        type: 'server',
        message: fieldError.message,
      });
    }
  }

  return true;
}
