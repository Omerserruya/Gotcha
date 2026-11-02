/*
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ★★ The support cookie holds an id the browser can neither read nor point
 * elsewhere, and only the login that started it reads a session from it.
 */
const jar = vi.hoisted(() => new Map<string, { value: string; options?: unknown }>());
const session = vi.hoisted(() => ({ value: { sid: 'sid-1' } as { sid: string } | null }));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)!.value } : undefined),
    set: (name: string, value: string, options: unknown) => jar.set(name, { value, options }),
    delete: ({ name }: { name: string }) => jar.delete(name),
  }),
}));
vi.mock('@/auth/session-store', () => ({ readSession: async () => session.value }));
vi.mock('@/config/env.server', () => ({
  serverEnv: () => ({ SESSION_SECRET: 'x'.repeat(48), APP_ORIGIN: 'https://app.test' }),
}));

const {
  SUPPORT_COOKIE,
  clearSupport,
  readSupport,
  sealSupport,
  supportReturnLocale,
  supportTenant,
  writeSupport,
} = await import('./support-cookie');

const inAnHour = () => new Date(Date.now() + 3600_000).toISOString();

beforeEach(() => {
  jar.clear();
  session.value = { sid: 'sid-1' };
});

describe('support cookie', () => {
  it('written by the login that starts it, read back as its id and workspace', async () => {
    expect(await writeSupport({ id: 'ss1', tenantId: 't9', expiresAt: inAnHour() })).toBe(true);
    const written = jar.get(SUPPORT_COOKIE)!;
    // Sealed: the id and the workspace are not readable in it.
    expect(written.value).not.toContain('ss1');
    expect(written.value).not.toContain('t9');
    expect(written.options).toMatchObject({
      httpOnly: true,
      secure: true,
      path: '/',
      sameSite: 'lax',
    });
    const maxAge = (written.options as { maxAge: number }).maxAge;
    expect(maxAge).toBeGreaterThan(3500);
    expect(maxAge).toBeLessThanOrEqual(3600);
    expect(await readSupport()).toEqual({ id: 'ss1', tenantId: 't9' });
  });

  it('★ another login in the same browser reads no session from it', async () => {
    await writeSupport({ id: 'ss1', tenantId: 't9', expiresAt: inAnHour() });
    session.value = { sid: 'sid-2' };
    expect(await readSupport()).toBeNull();
    // The way back to the console still knows the workspace.
    expect(await supportTenant()).toBe('t9');
  });

  it('signed out: no session read', async () => {
    await writeSupport({ id: 'ss1', tenantId: 't9', expiresAt: inAnHour() });
    session.value = null;
    expect(await readSupport()).toBeNull();
  });

  it('past its expiry: nothing', async () => {
    jar.set(SUPPORT_COOKIE, {
      value: await sealSupport({
        id: 'ss1',
        tid: 't9',
        sid: 'sid-1',
        exp: Math.floor(Date.now() / 1000) - 1,
      }),
    });
    expect(await readSupport()).toBeNull();
    expect(await supportTenant()).toBeNull();
  });

  it('tampered or foreign: nothing, never a throw', async () => {
    jar.set(SUPPORT_COOKIE, { value: 'not.a.sealed.value' });
    expect(await readSupport()).toBeNull();
    const sealed = await sealSupport({ id: 'ss1', tid: 't9', sid: 'sid-1', exp: 2_000_000_000 });
    jar.set(SUPPORT_COOKIE, { value: `${sealed.slice(0, -2)}AA` });
    expect(await readSupport()).toBeNull();
  });

  it('an expiry already passed, or none to read: not kept', async () => {
    expect(
      await writeSupport({ id: 'ss1', tenantId: 't9', expiresAt: new Date(0).toISOString() }),
    ).toBe(false);
    expect(await writeSupport({ id: 'ss1', tenantId: 't9', expiresAt: 'soon' })).toBe(false);
    session.value = null;
    expect(await writeSupport({ id: 'ss1', tenantId: 't9', expiresAt: inAnHour() })).toBe(false);
    expect(jar.has(SUPPORT_COOKIE)).toBe(false);
  });

  it('★ the language the admin entered in, sealed with it and read back for the way out', async () => {
    await writeSupport({ id: 'ss1', tenantId: 't9', expiresAt: inAnHour() }, 'he');
    expect(await supportReturnLocale()).toBe('he');
  });

  it('a cookie sealed before the language existed still reads; it names none', async () => {
    jar.set(SUPPORT_COOKIE, {
      value: await sealSupport({ id: 'ss1', tid: 't9', sid: 'sid-1', exp: 2_000_000_000 }),
    });
    expect(await readSupport()).toEqual({ id: 'ss1', tenantId: 't9' });
    expect(await supportReturnLocale()).toBeNull();
  });

  it('cleared', async () => {
    await writeSupport({ id: 'ss1', tenantId: 't9', expiresAt: inAnHour() });
    await clearSupport();
    expect(await readSupport()).toBeNull();
  });
});
