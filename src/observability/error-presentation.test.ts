import { describe, expect, it } from 'vitest';

import { ApiError } from '@/api/client/api-error';

import { presentError } from './error-presentation';

describe('presentError', () => {
  it('routes a validation failure inline, with its field errors', () => {
    const presented = presentError(
      new ApiError({
        kind: 'validation',
        fieldErrors: [{ field: 'email', message: 'Invalid' }],
      }),
    );
    expect(presented.presentation).toBe('inline');
    expect(presented.fieldErrors.get('email')).toBe('Invalid');
  });

  it('routes an expired session to re-authentication rather than a toast', () => {
    expect(presentError(new ApiError({ kind: 'authentication' })).presentation).toBe(
      'reauthenticate',
    );
  });

  it('blocks the page on an authorization failure', () => {
    expect(presentError(new ApiError({ kind: 'authorization' })).presentation).toBe('blocking');
  });

  it('degrades an unknown throwable to the unknown kind', () => {
    const presented = presentError(new Error('boom'));
    expect(presented.kind).toBe('unknown');
    expect(presented.titleKey).toBe('kind.unknown.title');
  });

  it('honours a caller override', () => {
    expect(
      presentError(new ApiError({ kind: 'not_found' }), { presentation: 'inline' }).presentation,
    ).toBe('inline');
  });
});
