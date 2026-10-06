import 'server-only';

import type { Route } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { RETURN_TO_HEADER } from '@/auth/return-to';

import { isApiError } from './api-error';

/** `/api/auth/login`, with where they were - read from the proxy's header. */
export async function signInHere(): Promise<Route> {
  const here = (await headers()).get(RETURN_TO_HEADER);
  return (
    here ? `/api/auth/login?returnTo=${encodeURIComponent(here)}` : '/api/auth/login'
  ) as Route;
}

/**
 * ★★ A 401 IS "SIGN IN AGAIN" (Omer, 2026-10-04) - in a server action too.
 *
 * Every catch in a `'use server'` file calls this first: a session the
 * platform refuses becomes a redirect to sign-in with the way back, never a
 * "that didn't go through". A 403 is not this (no permission is not signed
 * out); nor is anything else. `src/server-actions-sign-in.test.ts` walks the
 * action files and fails on a catch that skips it.
 *
 * The redirect throws, and it is thrown from the catch - outside the `try` -
 * so it leaves the action and Next answers it.
 */
export async function signInIfSignedOut(cause: unknown): Promise<void> {
  if (isApiError(cause) && cause.status === 401) redirect(await signInHere());
}
