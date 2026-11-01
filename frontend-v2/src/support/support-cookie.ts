import 'server-only';

import { hkdf } from 'node:crypto';
import { promisify } from 'node:util';

import { CompactEncrypt, compactDecrypt } from 'jose';
import { cookies } from 'next/headers';
import { z } from 'zod';

import { readSession } from '@/auth/session-store';
import { nowInSeconds } from '@/auth/session';
import { serverEnv } from '@/config/env.server';

const hkdfAsync = promisify(hkdf);

/**
 * The support session this browser is in - its own cookie, beside the
 * session's, sealed the same way under a key of its own purpose.
 *
 * ★ IT HOLDS AN ID, NOT A CREDENTIAL. The platform decides everything from
 *   the admin's own token plus `x-support-session` (Backend
 *   `support-principal.ts`): the session must be live, this login's, and for
 *   the tenant named. Sealed anyway, so the browser can neither read which
 *   workspace it names nor point it at another.
 *
 * ★ BOUND TO THE LOGIN THAT STARTED IT (`sid`). Another sign-in in the same
 *   browser reads no support session - the platform would refuse it too, and
 *   this way a stale cookie sends nothing at all.
 */
export const SUPPORT_COOKIE = 'sup';

const supportSchema = z.object({
  /** The platform's SupportSession id. */
  id: z.string().min(1),
  /** The workspace it is for: `x-tenant-id` on every call. */
  tid: z.string().min(1),
  /** The local session id of the login that started it. */
  sid: z.string().min(1),
  /** The session's expiry, epoch seconds. */
  exp: z.number().int().positive(),
});

type SealedSupport = z.infer<typeof supportSchema>;

export interface ActiveSupport {
  readonly id: string;
  readonly tenantId: string;
}

const ENCRYPTION = { alg: 'dir', enc: 'A256GCM' } as const;

let keyPromise: Promise<CryptoKey> | undefined;

function encryptionKey(): Promise<CryptoKey> {
  keyPromise ??= (async () => {
    const derived = (await hkdfAsync(
      'sha256',
      serverEnv().SESSION_SECRET,
      'gotcha.session.v1',
      'gotcha.support.encryption',
      32,
    )) as ArrayBuffer;
    return globalThis.crypto.subtle.importKey('raw', derived, 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ]);
  })();
  return keyPromise;
}

export async function sealSupport(value: SealedSupport): Promise<string> {
  const key = await encryptionKey();
  return new CompactEncrypt(new TextEncoder().encode(JSON.stringify(value)))
    .setProtectedHeader(ENCRYPTION)
    .encrypt(key);
}

/** The sealed value, or `null` for anything tampered, malformed or past its expiry. */
export async function unsealSupport(sealed: string | undefined): Promise<SealedSupport | null> {
  if (!sealed) return null;
  try {
    const key = await encryptionKey();
    const { plaintext } = await compactDecrypt(sealed, key);
    const parsed = supportSchema.safeParse(JSON.parse(new TextDecoder().decode(plaintext)));
    if (!parsed.success) return null;
    if (parsed.data.exp <= nowInSeconds()) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function cookieOptions(maxAge: number) {
  return {
    name: SUPPORT_COOKIE,
    httpOnly: true as const,
    secure: !serverEnv().APP_ORIGIN.startsWith('http://'),
    sameSite: 'lax' as const,
    path: '/',
    maxAge,
  };
}

/**
 * The live support session of THIS login, or `null`: no cookie, a cookie
 * that does not unseal, one past its expiry, or one another login started.
 */
export async function readSupport(): Promise<ActiveSupport | null> {
  const value = await unsealSupport((await cookies()).get(SUPPORT_COOKIE)?.value);
  if (!value) return null;
  const session = await readSession();
  if (!session || session.sid !== value.sid) return null;
  return { id: value.id, tenantId: value.tid };
}

/** The workspace a cookie names, whoever's it is - for the way back to the console. */
export async function supportTenant(): Promise<string | null> {
  const value = await unsealSupport((await cookies()).get(SUPPORT_COOKIE)?.value);
  return value?.tid ?? null;
}

/** Route handlers and server actions only: a render cannot write a cookie. */
export async function writeSupport(started: {
  readonly id: string;
  readonly tenantId: string;
  readonly expiresAt: string;
}): Promise<boolean> {
  const session = await readSession();
  const exp = Math.floor(Date.parse(started.expiresAt) / 1000);
  if (!session || !Number.isFinite(exp)) return false;
  const maxAge = exp - nowInSeconds();
  if (maxAge <= 0) return false;
  const sealed = await sealSupport({
    id: started.id,
    tid: started.tenantId,
    sid: session.sid,
    exp,
  });
  (await cookies()).set(SUPPORT_COOKIE, sealed, cookieOptions(maxAge));
  return true;
}

export async function clearSupport(): Promise<void> {
  (await cookies()).delete({ name: SUPPORT_COOKIE, path: '/' });
}
