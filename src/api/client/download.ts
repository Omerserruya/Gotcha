'use client';

import { appPath } from '@/lib/base-path';

/**
 * A file from the platform, through this app's BFF - the one GET the JSON
 * client cannot make (the WooCommerce plugin's zip). The answer is the
 * bytes, or the refusal's status: a 403's JSON is never handed back as a
 * file to save.
 */
export async function downloadFromPlatform(
  path: `/api/${string}`,
): Promise<
  | { readonly ok: true; readonly blob: Blob }
  | { readonly ok: false; readonly status: number | null }
> {
  try {
    const response = await fetch(appPath(`/api/bff${path}` as `/${string}`), {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!response.ok) return { ok: false, status: response.status };
    return { ok: true, blob: await response.blob() };
  } catch {
    return { ok: false, status: null };
  }
}
