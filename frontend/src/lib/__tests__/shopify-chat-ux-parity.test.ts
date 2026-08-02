/**
 * The client-side chat settings rules must agree with the server's.
 *
 * `frontend/src/lib/shopify-chat-ux-client.ts` deliberately restates a
 * few rules from `packages/shared/src/lib/shopify-chat-ux.ts`, because the
 * frontend is not an npm workspace and cannot import that package at
 * runtime. Restating a rule is only safe if drift is caught, which is what
 * this file is for: it imports BOTH and fails the moment they disagree.
 *
 * The import of the shared package works here because tests run on the
 * host, where the root `node_modules` symlink exists — not inside the
 * frontend container, where it does not.
 */
import { describe, it, expect } from "vitest";
import * as server from "../../../../packages/shared/src/lib/shopify-chat-ux";
import * as client from "../shopify-chat-ux-client";

describe("media URL rule", () => {
  const CASES: Array<[string, "image" | "video"]> = [
    // Accepted
    ["https://cdn.example.com/hero.jpg", "image"],
    ["https://cdn.example.com/hero.png", "image"],
    ["https://cdn.example.com/hero.webp", "image"],
    ["https://cdn.example.com/loop.gif", "image"],
    ["https://cdn.example.com/clip.mp4", "video"],
    ["https://cdn.example.com/clip.webm", "video"],
    // Extensionless CDN paths are allowed: an extension is a hint.
    ["https://images.unsplash.com/photo-1522335789203?w=800&q=70", "image"],
    // Refused
    ["http://cdn.example.com/hero.jpg", "image"],
    ["javascript:alert(1)", "image"],
    ["data:image/png;base64,AAA", "image"],
    ["https://cdn.example.com/logo.svg", "image"],
    ["https://cdn.example.com/logo.svgz", "image"],
    ["https://cdn.example.com/clip.mp4", "image"],
    ["https://cdn.example.com/hero.jpg", "video"],
    ["https://localhost/hero.jpg", "image"],
    ["", "image"],
    ["   ", "image"],
    ["not a url", "image"],
  ];

  for (const [url, kind] of CASES) {
    it(`agrees on ${kind}: ${url || "(empty)"}`, () => {
      expect(client.sanitizeMediaUrl(url, kind)).toBe(server.sanitizeMediaUrl(url, kind));
    });
  }

  it("agrees that a non-string is not a URL", () => {
    for (const raw of [null, undefined, 42, {}, []]) {
      expect(client.sanitizeMediaUrl(raw as unknown)).toBe(server.sanitizeMediaUrl(raw as unknown));
    }
  });
});

describe("hero height resolution", () => {
  const PANELS = [568, 640, 667, 844, 932, 1024];
  const HEIGHTS = [80, 100, 124, 150, 190, 220, 320];

  it("agrees on every combination of configured height and panel", () => {
    for (const panelHeight of PANELS) {
      for (const configured of HEIGHTS) {
        for (const isMobile of [true, false]) {
          const input = { configured, panelHeight, isMobile };
          expect(client.resolveHeroHeight(input)).toBe(server.resolveHeroHeight(input));
          expect(client.heroHeightWarning(input)).toBe(server.heroHeightWarning(input));
        }
      }
    }
  });
});

describe("shared constants", () => {
  it("agrees on the media guidance the form quotes to the merchant", () => {
    expect(client.MEDIA_GUIDANCE).toEqual(server.MEDIA_GUIDANCE);
  });

  it("agrees on which file types belong in which slot", () => {
    expect(client.HERO_IMAGE_EXTENSIONS).toEqual(server.HERO_IMAGE_EXTENSIONS);
    expect(client.HERO_VIDEO_EXTENSIONS).toEqual(server.HERO_VIDEO_EXTENSIONS);
  });
});

describe("fallbacks for an unsaved channel", () => {
  // These are what the form shows before a channel exists. They must match
  // what the server would have produced, or the merchant sees one thing in
  // the form and a different thing the instant they press save.
  it("matches the server's welcome defaults", () => {
    const s = server.defaultWelcome();
    for (const key of Object.keys(client.WELCOME_FALLBACK) as Array<keyof typeof client.WELCOME_FALLBACK>) {
      if (key === "suggestedQuestions") continue; // the server seeds examples; the form starts empty
      expect({ [key]: client.WELCOME_FALLBACK[key] }).toEqual({ [key]: s[key as keyof typeof s] });
    }
  });

  it("matches the server's hero defaults", () => {
    const s = server.defaultHero();
    for (const key of Object.keys(client.HERO_FALLBACK) as Array<keyof typeof client.HERO_FALLBACK>) {
      expect({ [key]: client.HERO_FALLBACK[key] }).toEqual({ [key]: s[key as keyof typeof s] });
    }
  });
});
