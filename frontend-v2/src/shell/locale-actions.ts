'use server';

import { z } from 'zod';

import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { workspaceEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/** Kept on the account, or not - and why not, for the log. */
export type MyLanguageResult = { readonly ok: true } | { readonly ok: false };

/**
 * This person's own interface language, kept on their account
 * (`PUT /api/agents/me/locale {locale}`, auth agents.ts) so it is theirs on
 * every device. It is personal (Omer, 2026-10-11): the rail's account menu
 * and the person's own row in 12d write it, never a workspace setting.
 *
 * In the shell rather than a feature: the shell's account menu calls it, and
 * the shell may not import a feature.
 */
export async function saveMyLanguage(locale: string): Promise<MyLanguageResult> {
  try {
    await serverApi().put({
      endpoint: workspaceEndpoints.myLocale(),
      payload: z.unknown(),
      body: { locale },
    });
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('shell.my_locale_failed', { cause, locale });
    return { ok: false };
  }
}
