/**
 * Two things the public site got wrong that no unit test could have caught,
 * because both were about a browser rather than about a function.
 *
 * The tab icon: a black PNG at `media="(prefers-color-scheme: light)"` and a
 * white one at `dark` is correct markup, and Chrome ignores `media` on a
 * favicon link entirely. A visitor in dark mode got the black mark on a dark
 * tab strip while Firefox and Safari looked right, which is what made it read
 * as a caching problem rather than a browser difference. The fix is one SVG
 * carrying both colourways, so no browser has to choose between two files.
 *
 * The cookie banner: consent lived in localStorage, which is keyed by ORIGIN,
 * and this site is four origins. Answering the question on gotcha.co.il left
 * help.gotcha.co.il still asking. The fix is a cookie on the registrable
 * domain - and that domain has to be found by probing, because gotcha.co.il
 * has a two-label public suffix and "everything after the first dot" yields
 * `.co.il`, which browsers refuse outright.
 *
 * These assertions are static: they read the files and check the decisions are
 * still there. The behaviour itself is verified in a real browser against the
 * built export, which is the only place either question has a real answer.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

function repoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        if (JSON.parse(fs.readFileSync(pkg, "utf8")).workspaces) return dir;
      } catch { /* keep walking */ }
    }
    dir = path.dirname(dir);
  }
  throw new Error("workspace root not found");
}
const ROOT = repoRoot();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("the tab icon decides its own colour", () => {
  const LAYOUTS = [
    ["marketing", "landing/src/app/layout.tsx"],
    ["application", "frontend/src/app/layout.tsx"],
  ] as const;

  for (const [name, rel] of LAYOUTS) {
    it(`${name}: offers an SVG icon`, () => {
      expect(read(rel), "the SVG is the only icon that carries both colourways")
        .toMatch(/favicon\.svg["'][\s\S]{0,80}image\/svg\+xml/);
    });

    it(`${name}: offers no media-scoped icon`, () => {
      // Chrome ignores it, so a media-scoped icon is not a preference - it is
      // an extra file the browser may pick for reasons of its own.
      const icons = /icons:\s*\{[\s\S]*?\n  \},/.exec(read(rel));
      expect(icons, "the layout must still declare icons").not.toBeNull();
      expect(icons![0], "a favicon link's `media` is not honoured by Chrome")
        .not.toMatch(/prefers-color-scheme/);
    });
  }

  it("the generated SVG switches fill on the browser's theme", () => {
    const svg = read("landing/public/assets/favicon.svg");
    expect(svg).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)/);
    // Both ends of the switch, so a half-written rule cannot pass.
    expect(svg).toMatch(/fill:\s*#16150F/i);
    expect(svg).toMatch(/fill:\s*#FFFFFF/i);
  });

  it("the application serves the same file, not a copy that can drift", () => {
    expect(read("frontend/public/favicon.svg")).toEqual(read("landing/public/assets/favicon.svg"));
  });
});

describe("one answer to the cookie question, across every hostname", () => {
  const consent = () => read("landing/src/lib/consent.ts");

  it("stores the decision in a cookie with an explicit domain", () => {
    expect(consent(), "localStorage is keyed by origin and this site is four of them")
      .toMatch(/document\.cookie\s*=\s*[^\n]*domain=/);
  });

  it("finds that domain by probing, not by slicing the hostname", () => {
    // `gotcha.co.il` has a two-label public suffix. Deriving the parent domain
    // by string surgery yields `.co.il`, browsers refuse it, and the cookie is
    // silently never set - which looks exactly like the bug being fixed.
    const src = consent();
    expect(src).toMatch(/document\.cookie\s*=\s*`[^`]*probe/i);
    expect(src, "a comment is not enough - the reason has to be in the code")
      .toMatch(/document\.cookie\.includes\(/);
  });

  it("prefers the cookie over the legacy localStorage record", () => {
    // Inside readConsent specifically. Comparing positions across the whole
    // file would only be comparing where the constants are declared.
    const body = /export function readConsent\(\)[\s\S]*?\n\}/.exec(consent());
    expect(body, "readConsent must exist").not.toBeNull();
    const cookieRead = body![0].indexOf("readCookie(NAME)");
    const legacyRead = body![0].indexOf("LEGACY_KEY");
    expect(cookieRead, "the cookie must be read").toBeGreaterThan(-1);
    expect(legacyRead, "the old record must still be honoured, once").toBeGreaterThan(-1);
    expect(cookieRead, "an old same-origin record must not shadow the shared one")
      .toBeLessThan(legacyRead);
  });

  it("names the cookie in both language versions of the Cookie Policy", () => {
    // The policy said the answer was kept in localStorage. It is a published
    // legal document, so the code moving is only half of the change.
    const name = /const NAME = '([^']+)'/.exec(consent());
    expect(name, "the consent cookie must have one name in one place").not.toBeNull();
    for (const lang of ["en", "he"]) {
      expect(read(`docs/legal/${lang}/cookie-policy.md`), `${lang} policy must name the cookie`)
        .toContain(name![1]);
    }
  });
});
