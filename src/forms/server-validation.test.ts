import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

import { applyServerValidation } from './server-validation';

describe('applyServerValidation', () => {
  it('routes a rejection onto the field that caused it', () => {
    const setError = vi.fn();
    const handled = applyServerValidation(
      new ApiError({ kind: 'validation', fieldErrors: [{ field: 'email', message: 'Taken' }] }),
      setError,
      ['email'],
    );

    expect(handled).toBe(true);
    expect(setError).toHaveBeenCalledWith('email', { type: 'server', message: 'Taken' });
  });

  it('surfaces a rejection for an unknown field at form level rather than dropping it', () => {
    const setError = vi.fn();
    applyServerValidation(
      new ApiError({ kind: 'validation', fieldErrors: [{ field: 'mystery', message: 'Nope' }] }),
      setError,
      ['email'],
    );

    expect(setError).toHaveBeenCalledWith('root.serverError', {
      type: 'server',
      message: 'Nope',
    });
  });

  it('declines non-validation failures so general handling takes over', () => {
    const setError = vi.fn();
    expect(applyServerValidation(new ApiError({ kind: 'server' }), setError, ['email'])).toBe(
      false,
    );
    expect(applyServerValidation(new Error('boom'), setError, ['email'])).toBe(false);
    expect(setError).not.toHaveBeenCalled();
  });

  it('declines a validation failure that carried no field detail', () => {
    const setError = vi.fn();
    expect(applyServerValidation(new ApiError({ kind: 'validation' }), setError, ['email'])).toBe(
      false,
    );
  });
});
