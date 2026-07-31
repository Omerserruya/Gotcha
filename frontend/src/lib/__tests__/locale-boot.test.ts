import { describe, it, expect } from "vitest";
import { pickLocale, directionFor, LOCALE_BOOT_SCRIPT, LOCALE_COOKIE } from "../locale-boot";

/**
 * What language the page is in before React has run.
 *
 * The root layout renders `lang="en" dir="ltr"` and a post-hydration effect
 * corrects it. For the Hebrew launch market that meant every full page load
 * flashed left-to-right, and a first-time visitor got English regardless of
 * what their browser asked for.
 *
 * The script below runs in <head>, before the first paint. These tests cover
 * the choice it makes AND the fact that it makes the same choice as the
 * TypeScript the rest of the app uses - a script that drifts from its own
 * reference implementation would set a direction the app then argues with.
 */

describe("an explicit choice wins", () => {
  it("uses the cookie", () => {
    expect(pickLocale("he", ["en-US", "en"])).toBe("he");
    expect(pickLocale("en", ["he-IL", "he"])).toBe("en");
  });

  it("ignores a language we do not ship", () => {
    expect(pickLocale("fr", [])).toBe("en");
    expect(pickLocale("", [])).toBe("en");
    expect(pickLocale(null, [])).toBe("en");
    expect(pickLocale(undefined, [])).toBe("en");
  });
});

describe("with no choice made, the browser is asked", () => {
  it("honours a Hebrew browser - the case that was silently broken", () => {
    expect(pickLocale(null, ["he-IL", "he", "en-US", "en"])).toBe("he");
  });

  it("takes the tags in the order given", () => {
    // Browsers already order these by preference. Deliberately not re-ranking:
    // mis-ranking someone's language is worse than ignoring a q-weight.
    expect(pickLocale(null, ["en-GB", "en", "he"])).toBe("en");
  });

  it("matches the base tag, not the region", () => {
    expect(pickLocale(null, ["he-IL"])).toBe("he");
    expect(pickLocale(null, ["en-AU"])).toBe("en");
  });

  it("falls back to English for languages we do not ship", () => {
    expect(pickLocale(null, ["fr-FR", "de-DE"])).toBe("en");
  });

  it("survives junk without throwing", () => {
    expect(pickLocale(null, ["", "  ", "-", "??"])).toBe("en");
    expect(pickLocale(null, [])).toBe("en");
  });
});

describe("direction", () => {
  it("is rtl for Hebrew and ltr for English", () => {
    expect(directionFor("he")).toBe("rtl");
    expect(directionFor("en")).toBe("ltr");
  });
});

describe("the inline script agrees with pickLocale", () => {
  /** Run the boot script against a fake document/navigator and report the result. */
  function boot(cookie: string, languages: string[]): { lang: string; dir: string } {
    const documentElement = { lang: "", dir: "" };
    const fakeDocument = { cookie, documentElement };
    const fakeNavigator = { languages, language: languages[0] ?? "" };
    // eslint-disable-next-line no-new-func
    new Function("document", "navigator", LOCALE_BOOT_SCRIPT)(fakeDocument, fakeNavigator);
    return { lang: documentElement.lang, dir: documentElement.dir };
  }

  const cases: Array<{ cookie: string; languages: string[] }> = [
    { cookie: `${LOCALE_COOKIE}=he`, languages: ["en-US"] },
    { cookie: `${LOCALE_COOKIE}=en`, languages: ["he-IL"] },
    { cookie: "", languages: ["he-IL", "he", "en"] },
    { cookie: "", languages: ["en-GB", "he"] },
    { cookie: "", languages: ["fr-FR"] },
    { cookie: "", languages: [] },
    { cookie: "other=1; theme=dark", languages: ["he"] },
    { cookie: `${LOCALE_COOKIE}=fr`, languages: ["he"] },
  ];

  it.each(cases)("matches for cookie=%j languages=%j", ({ cookie, languages }) => {
    const cookieValue = cookie.match(new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]*)`))?.[1] ?? null;
    const expected = pickLocale(cookieValue, languages);
    const actual = boot(cookie, languages);
    expect(actual.lang).toBe(expected);
    expect(actual.dir).toBe(directionFor(expected));
  });

  it("reads the cookie even when it is not first", () => {
    // A naive `startsWith` match would miss this and silently fall through to
    // the browser language, overriding a choice the user made.
    expect(boot(`theme=dark; ${LOCALE_COOKIE}=he; x=1`, ["en"]).lang).toBe("he");
  });

  it("cannot throw - it runs before everything else on the page", () => {
    // No navigator.languages, no navigator.language, no cookie.
    const documentElement = { lang: "", dir: "" };
    expect(() =>
      // eslint-disable-next-line no-new-func
      new Function("document", "navigator", LOCALE_BOOT_SCRIPT)(
        { cookie: undefined as any, documentElement },
        {},
      ),
    ).not.toThrow();
  });
});
