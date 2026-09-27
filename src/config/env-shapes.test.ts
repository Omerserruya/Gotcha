import { z } from 'zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { APP_ENVIRONMENTS } from './app-env';
import { emptyIsUnset } from './empty-is-unset';

/**
 * Empty is not absent, and four zod shapes disagree about it in four ways.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE CONTRACT THAT GATES THE APP'S BOOT HAD NO TEST FOR THIS
 * ════════════════════════════════════════════════════════════════════════════
 * `.optional()` and `.default()` fire on `undefined` **only**. Every mechanism
 * that supplies environment variables produces an empty string and means
 * "nothing": `ARG X=""` (a declared arg with a default is SET), `${X:-}` in a
 * compose file, `export X=` in a shell.
 *
 * Two things broke on this in one afternoon, in opposite ways and both
 * silently, so the shapes are pinned here rather than the variables. A test per
 * variable would be noise; a test per shape is the distinction that failed.
 */

const shapes = {
  'enum with a default': z.enum(APP_ENVIRONMENTS).default('local'),
  'url, optional': z.url().optional(),
  'string, optional': z.string().optional(),
  'coerced number with a default': z.coerce.number().min(0).max(1).default(0.1),
  'string, required, min(1), optional': z.string().min(1).optional(),
} as const;

describe('★★ what each shape does with an empty string, measured', () => {
  it('★★ an enum with a default THROWS on empty and only defaults on undefined', () => {
    /*
     * The one that takes the browser bundle down at module load. A healthy
     * container then serves a blank app: the process is up, the HTML is
     * served, and the client JavaScript throws before it renders.
     */
    expect(shapes['enum with a default'].safeParse('').success).toBe(false);
    expect(shapes['enum with a default'].parse(undefined)).toBe('local');
  });

  it('★★ an optional url THROWS on empty', () => {
    // Same blank app, and it is the realtime variable — so the failure would
    // have arrived on the one we had just finished proving works.
    expect(shapes['url, optional'].safeParse('').success).toBe(false);
    expect(shapes['url, optional'].parse(undefined)).toBeUndefined();
  });

  it('★★ a coerced number with a default SILENTLY BECOMES 0, which is the worst of the four', () => {
    /*
     * `Number('')` is 0, and 0 passes `min(0)`. So an empty value does not
     * throw and does not default — it turns the sample rate off and nothing
     * anywhere says so. No error, no warning, no missing field.
     */
    expect(shapes['coerced number with a default'].parse('')).toBe(0);
    expect(shapes['coerced number with a default'].parse(undefined)).toBe(0.1);
  });

  it('★ an optional string accepts empty, which is why this is not one rule', () => {
    // Harmless here, and the reason the fix normalises the input rather than
    // tightening every schema: these shapes genuinely differ.
    expect(shapes['string, optional'].parse('')).toBe('');
  });

  it('★★ `min(1).optional()` throws on empty — optional permits MISSING, not EMPTY', () => {
    /*
     * The server-side one. A compose `${SECRET:-}` — the documented way to
     * make a variable optional — supplies empty, every request reading the
     * server config fails validation, and pages that do not read it still
     * return 200. A container that looks healthy with a login route that 500s.
     */
    expect(shapes['string, required, min(1), optional'].safeParse('').success).toBe(false);
    expect(shapes['string, required, min(1), optional'].parse(undefined)).toBeUndefined();
  });
});

describe('★★ emptyIsUnset makes all five agree', () => {
  it('★★ turns empty into undefined so each shape takes its absent branch', () => {
    const cleaned = emptyIsUnset({ a: '', b: 'kept', c: undefined, d: 0, e: false });

    expect(cleaned.a).toBeUndefined();
    // Only the empty STRING is nothing. `0` and `false` are values somebody
    // set on purpose, and collapsing them would be the same defect inverted.
    expect(cleaned.b).toBe('kept');
    expect(cleaned.d).toBe(0);
    expect(cleaned.e).toBe(false);
  });

  it('★★ every shape above now behaves the same for empty and absent', () => {
    for (const [name, schema] of Object.entries(shapes)) {
      const viaEmpty = schema.safeParse(emptyIsUnset({ v: '' }).v);
      const viaAbsent = schema.safeParse(undefined);
      expect(viaEmpty.success, name).toBe(viaAbsent.success);
      if (viaEmpty.success && viaAbsent.success) {
        expect(viaEmpty.data, name).toEqual(viaAbsent.data);
      }
    }
  });
});

describe('★★ the real client config, through the module the app loads', () => {
  const load = async (env: Record<string, string | undefined>) => {
    vi.resetModules();
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return import('./env.client');
  };

  beforeEach(() => {
    vi.resetModules();
  });

  it('★★ an empty APP_ENV no longer takes the whole bundle down', async () => {
    /*
     * THE DEFECT, END TO END. Before `emptyIsUnset` this threw "Invalid public
     * environment configuration" at module load, in the browser, for anybody
     * who built the image without passing the variable — which the Dockerfile
     * made the default by giving the ARG an empty default.
     */
    const { clientEnv } = await load({
      NEXT_PUBLIC_APP_ENV: '',
      NEXT_PUBLIC_REALTIME_URL: '',
      NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE: '',
    });

    expect(clientEnv.APP_ENV).toBe('local');
    expect(clientEnv.REALTIME_URL).toBeUndefined();
    // And the sample rate is the default rather than a silent zero.
    expect(clientEnv.SENTRY_TRACES_SAMPLE_RATE).toBe(0.1);
  });

  it('★ a real value still arrives intact', async () => {
    const { clientEnv } = await load({
      NEXT_PUBLIC_APP_ENV: 'production',
      NEXT_PUBLIC_REALTIME_URL: 'https://dev.gotcha.co.il',
      NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE: '0.5',
    });

    expect(clientEnv.APP_ENV).toBe('production');
    expect(clientEnv.REALTIME_URL).toBe('https://dev.gotcha.co.il');
    expect(clientEnv.SENTRY_TRACES_SAMPLE_RATE).toBe(0.5);
  });

  it('★★ a genuinely invalid value still fails, because this is not a blanket "accept anything"', async () => {
    // The normalisation must not have turned validation off: only the empty
    // string becomes absent, and everything else is still checked.
    await expect(load({ NEXT_PUBLIC_APP_ENV: 'nonsense' })).rejects.toThrow(
      /Invalid public environment configuration/,
    );
  });
});
