'use server';

import { revalidatePath } from 'next/cache';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { z } from 'zod';

import {
  channelSchema,
  OAUTH_PLATFORMS,
  type Channel,
  type ChannelType,
  type ResponseMode,
} from '@/api/contracts/channels';
import { channelEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';
import { signInIfSignedOut } from '@/api/client/signed-out';

/**
 * Writes for screen 13.
 *
 * Server actions, so the credentials below never travel from the browser to
 * anywhere but our own origin, and the BFF's origin check and session cookie
 * keep doing their jobs without the form knowing either exists.
 *
 * **Nothing here logs a request body.** An email connect carries an SMTP
 * password and an IMAP password; a failure is logged by its `cause`, which is
 * an `ApiError` carrying a status and a route, never the payload that produced
 * it. That is deliberate and it is the reason these actions do not share the
 * generic "log the input on failure" habit.
 */

export type ChannelWriteResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly reason: 'invalid'; readonly fields: Record<string, string> }
  /** Already connected, or a widget already exists. */
  | { readonly ok: false; readonly reason: 'duplicate' }
  /** The plan has no room for another channel. */
  | { readonly ok: false; readonly reason: 'limit' }
  | { readonly ok: false; readonly reason: 'forbidden' }
  | { readonly ok: false; readonly reason: 'failed' };

function classify(cause: unknown): Extract<ChannelWriteResult<never>, { ok: false }> {
  if (isApiError(cause)) {
    // 402 maps to `tenant_inactive` in the transport, but `requireChannelCapacity`
    // answers 402 too. Told apart by `code`, never by status, so a tenant that
    // has simply run out of channels is not reported as suspended.
    if (cause.code === 'PLAN_LIMIT_REACHED') return { ok: false, reason: 'limit' };
    if (cause.kind === 'conflict') return { ok: false, reason: 'duplicate' };
    if (cause.kind === 'authorization') return { ok: false, reason: 'forbidden' };
    if (cause.kind === 'validation') {
      return {
        ok: false,
        reason: 'invalid',
        fields: Object.fromEntries(cause.fieldErrors.map((f) => [f.field, f.message])),
      };
    }
  }
  return { ok: false, reason: 'failed' };
}

/**
 * Creates the web chat widget.
 *
 * The one connect path with no third party in it: nothing is authorised
 * anywhere, so nothing has to be revoked to undo it. The backend creates it
 * `PENDING` rather than `CONNECTED` — a freshly made widget is a draft until
 * it is actually on a page — which is the design's two-step arriving from the
 * backend rather than being imposed by the form.
 *
 * It is also idempotent: an existing widget is returned rather than a second
 * one created.
 */
export async function connectWebChat(name: string): Promise<ChannelWriteResult<Channel>> {
  try {
    const data = await serverApi().post({
      endpoint: channelEndpoints.createWebChat(),
      payload: channelSchema,
      body: name.trim() ? { name: name.trim() } : {},
    });
    revalidatePath('/[locale]/settings/channels', 'page');
    return { ok: true, data };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('channels.webchat_create_failed', { cause });
    return classify(cause);
  }
}

/** The fields `POST /api/channels/connect/email` requires, plus IMAP's optional half. */
export interface EmailConnectInput {
  emailAddress: string;
  displayName: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  imapHost?: string;
  imapPort?: number;
  imapUser?: string;
  imapPass?: string;
}

/**
 * Connects a mailbox over SMTP/IMAP.
 *
 * Credentials, not OAuth — the backend stores them and uses them to send and
 * receive as this address. So this is a real secret leaving a person's hands,
 * and it is never exercised by a test: a capture that submits this form has
 * given a mailbox password to a system on someone's behalf.
 *
 * The passwords are passed straight through and never touched otherwise. They
 * are not trimmed — leading or trailing whitespace can be part of a password,
 * and silently "cleaning" one turns a correct credential into a failed login
 * nobody can explain.
 */
export async function connectEmail(input: EmailConnectInput): Promise<ChannelWriteResult<Channel>> {
  try {
    const data = await serverApi().post({
      endpoint: channelEndpoints.connectEmail(),
      payload: channelSchema,
      body: {
        emailAddress: input.emailAddress.trim(),
        displayName: input.displayName.trim(),
        smtpHost: input.smtpHost.trim(),
        smtpPort: input.smtpPort,
        smtpUser: input.smtpUser.trim(),
        smtpPass: input.smtpPass,
        ...(input.imapHost?.trim() ? { imapHost: input.imapHost.trim() } : {}),
        ...(typeof input.imapPort === 'number' ? { imapPort: input.imapPort } : {}),
        ...(input.imapUser?.trim() ? { imapUser: input.imapUser.trim() } : {}),
        ...(input.imapPass ? { imapPass: input.imapPass } : {}),
      },
    });
    revalidatePath('/[locale]/settings/channels', 'page');
    return { ok: true, data };
  } catch (cause) {
    await signInIfSignedOut(cause);
    // `cause` carries a status and a route. It does not carry the body, which
    // is the whole point on a call that includes two passwords.
    logger.warn('channels.email_connect_failed', { cause });
    return classify(cause);
  }
}

/**
 * Step 2: who answers this channel.
 *
 * The only routing a `ChannelAccount` can store. Reversible by construction —
 * it is one field with two values — which is what makes it the one part of the
 * connect flow a capture may safely exercise and put back.
 */
export async function setResponseMode(
  id: string,
  mode: ResponseMode,
): Promise<ChannelWriteResult<Channel>> {
  try {
    const data = await serverApi().patch({
      endpoint: channelEndpoints.responseMode(id),
      payload: channelSchema,
      body: { responseMode: mode },
    });
    revalidatePath('/[locale]/settings/channels', 'page');
    return { ok: true, data };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('channels.response_mode_failed', { cause });
    return classify(cause);
  }
}

export type ChannelConnectStart =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: 'not_configured' | 'forbidden' | 'failed' };

/**
 * 13's Connect for an OAuth channel: the provider's page, asked for server
 * side, then the browser goes there. Nothing is connected until the person
 * approves at the provider and comes back.
 */
export async function startChannelConnect(channel: ChannelType): Promise<ChannelConnectStart> {
  const platform = (OAUTH_PLATFORMS as Partial<Record<ChannelType, string>>)[channel];
  if (!platform) return { ok: false, reason: 'failed' };
  try {
    const { url } = await serverApi().get({
      endpoint: channelEndpoints.oauthInitUrl(platform),
      payload: z.object({ url: z.string().url() }),
      raw: true,
    });
    if (new URL(url).protocol !== 'https:') return { ok: false, reason: 'failed' };
    return { ok: true, url };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('channels.connect_start_failed', { channel, cause });
    if (isApiError(cause)) {
      if (cause.status === 409) return { ok: false, reason: 'not_configured' };
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
    }
    return { ok: false, reason: 'failed' };
  }
}
