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

/**
 * The phone follows the design; the desktop does not move.
 *
 * The mobile export finished four product-page sections and recropped the home
 * hero, and both show on desktop as well as on the phone. The desktop is signed
 * off as it stands, so those five are admitted below the design's breakpoint
 * and held off above it - and nothing else in the port is allowed to differ.
 *
 * Measured rather than asserted, in a browser, against the design served from
 * its own folder: at 393, 375 and 320 the built page is the same height as the
 * design to the pixel, and every one of the design's 93 mobile rules reaches at
 * least as many elements in the build as in the design. These assertions keep
 * the three mechanisms that make that true from being quietly removed.
 */
describe("the phone layout is wired to the design", () => {
  const expander = () => read("landing/tools/expand-style-selectors.mjs");
  const compiler = () => read("landing/tools/dc2jsx.mjs");

  it("gives the host the id the runtime gives it", () => {
    // support.js sets hostEl.id = "dc-root", and the design's fitMobile() walks
    // `#dc-root *` to stack pixel-sized columns and lift 10px labels. Without
    // the id that selector matched nothing and the phone came out ~700px short.
    expect(compiler()).toContain('name: \'id\', value: \'dc-root\'');
    for (const rel of ["landing/src/generated/Template.jsx", "landing/src/generated/Chrome.jsx"]) {
      expect(read(rel), `${rel} must carry the host id`).toContain('id="dc-root"');
    }
  });

  it("matches the flex shorthand the server renders", () => {
    // CSSOM serialises `flex: 1` as `flex: 1 1 0%`, which is what the design's
    // selector is written against; the server-rendered attribute still says
    // `flex:1`. 52 flex children on the home page alone.
    expect(expander()).toMatch(/function flexShorthand/);
    const css = read("landing/src/app/globals.css");
    expect(css, "the anchored suffix form must be emitted").toMatch(/\[style\$="flex:\s?1"\]/);
  });

  it("anchors that shorthand instead of matching it loosely", async () => {
    // A bare [style*="flex:1"] also hits flex:1 1 420px and flex:1.35, which
    // this rule never touches - the design's runtime spells those out in full,
    // so its own selector never sees them. Tested on the expander rather than
    // on the sheet, because the design has its OWN loose
    // `.m-norow > [style*="flex: 1"]`, which is reproduced faithfully and is a
    // different rule.
    const { expandStyleSelectors } = await import(
      path.join(ROOT, "landing/tools/expand-style-selectors.mjs")
    );
    const { css } = expandStyleSelectors('[style*="flex: 1 1 0"]{flex-basis:100% !important}');
    expect(css, "the suffix form catches the declaration when it is last").toContain('[style$="flex:1"]');
    expect(css, "and the `;` form when something follows it").toContain('[style*="flex:1;"]');
    const selectors = css.slice(0, css.indexOf("{"));
    expect(selectors, "never unanchored").not.toMatch(/\[style\*="flex:\s?1"\]/);
  });

  it("keeps the design's own mobile breakpoint", () => {
    // 820px in the design, so the freeze starts at 821 and there is no width
    // where both apply or neither does.
    expect(read("landing/design/GOTCHA Landing.dc.html")).toContain("@media (max-width: 820px)");
    expect(read("landing/src/app/site.css")).toContain("@media (min-width: 821px)");
  });
});
