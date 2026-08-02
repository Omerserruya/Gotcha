#!/usr/bin/env node
/**
 * The website chat widget, in a real browser.
 *
 * Two questions, both of which used to have the wrong answer:
 *
 *   1. Does a DELETED widget draw anything? It must not. The old script
 *      painted its launcher before asking the server, so removing a
 *      channel left a button on a customer's site that opened onto
 *      silence.
 *   2. Does a live widget render the SAME experience as the storefront?
 *      They were two implementations and had drifted.
 *
 * The server is stubbed here — this is about the script's behaviour, and
 * a real tenant's widget id is not something to require in a test — but
 * the SCRIPT and the BUNDLE are the real files, and Chromium is real.
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import process from "node:process";

const pwPath = [
  process.env.PLAYWRIGHT_PATH,
  path.join(os.homedir(), "projects/marketing/node_modules/playwright/index.mjs"),
].filter(Boolean).find((c) => fs.existsSync(c));
if (!pwPath) { console.error("playwright not found; set PLAYWRIGHT_PATH"); process.exit(2); }
const { chromium } = await import(pwPath);

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const DIR = path.join(ROOT, "frontend/public/widget");
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, "widget-manifest.json"), "utf8"));
const embedScript = fs.readFileSync(path.join(DIR, "chatcenter-widget.js"), "utf8");
const chatBundle = fs.readFileSync(path.join(DIR, manifest.chat), "utf8");

const ORIGIN = "https://example-tenant-site.test";

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`);
}

/** The public widget config the bootstrap endpoint returns. */
function widgetConfig(overrides = {}) {
  return {
    appearance: {
      primaryColor: "#0ea5e9", contrastColor: "#ffffff", logoUrl: null, avatarUrl: null,
      launcherIcon: "chat", launcherPosition: "right", cornerRadius: 20,
      language: "en", direction: "ltr", showPoweredBy: true,
    },
    welcome: { headline: "Talk to us", subline: "Ask us anything.", assistantName: "Support", suggestedQuestions: ["Where is my order?"] },
    offline: { active: false, message: "Away", behavior: "ai", formFields: [], consentRequired: false, consentText: "" },
    features: { humanHandoff: true, productMessaging: false, addToCart: false },
    ux: {
      welcome: { title: "Talk to us", subtitle: "Ask us anything about our service.", assistantName: "Support",
        suggestedQuestions: ["Where is my order?", "Do you ship abroad?", "How do refunds work?"],
        avatarUrl: null, avatarSize: 56, avatarOverlap: 30, showAvatarBorder: true, textAlign: "center",
        accentColor: "#0ea5e9", textColor: "#0f172a" },
      launcher: { shape: "pill", size: 48, position: "right", mobilePosition: "right", offsetBottom: 18,
        offsetSide: 18, mobileOffsetBottom: 14, backgroundColor: "#0ea5e9", iconColor: "#ffffff",
        borderColor: "#ffffff", showBorder: false, shadow: 2, icon: "chat", iconUrl: null,
        label: "Chat with us", showLabel: true, showUnreadBadge: true, hideOnMobileWhenOpen: true },
      hero: { mediaType: "none", mediaUrl: null, posterUrl: null, height: 124, mobileHeight: 108,
        focalPoint: "50% 50%", objectFit: "cover", overlayStrength: 0, fadeStrength: 60,
        cornerRadius: 0, backgroundColor: "#ffffff", videoLoop: true, videoAutoplay: true },
      proactive: { enabled: false, trigger: "time_on_page", delaySeconds: 15, mobileDelaySeconds: 25,
        minPageViews: 2, scrollPercent: 50, customEvent: "", title: "", message: "", actionLabel: "",
        autoOpen: false, playSound: false, maxPerSession: 1, maxPerVisitor: 3, cooldownHours: 24,
        includeUrls: [], excludeUrls: [], desktopEnabled: true, mobileEnabled: true,
        firstVisitOnly: false, returningVisitorOnly: false },
      sounds: { enabled: false, pack: "subtle", volume: 40, outgoing: false, incomingAi: false,
        incomingHuman: false, proactive: false },
      behavior: { openOnLoad: false, closeOnOutsideClick: false, rememberOpenState: true,
        mobileFullScreen: true, keepHeaderMedia: false },
    },
    ...overrides,
  };
}

const browser = await chromium.launch({
  executablePath: path.join(os.homedir(), ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome"),
  headless: true,
});

/**
 * Serve a tenant's page with the embed snippet on it, with the widget
 * either alive or deleted.
 */
async function openSite({ widgetExists }) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const calls = [];

  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    calls.push(url.pathname);

    if (url.pathname === "/") {
      return route.fulfill({
        status: 200, contentType: "text/html",
        body: '<!doctype html><html lang="en"><head><meta charset="utf-8"></head>' +
          '<body style="margin:0;min-height:100vh;background:#f8fafc">' +
          '<h1 style="font:600 22px sans-serif;padding:24px">A tenant\'s own website</h1>' +
          `<script>window.__chatcenter={apiUrl:"${ORIGIN}",widgetId:"wid_test_123"};</script>` +
          '<script src="/widget/chatcenter-widget.js"></script>' +
          "</body></html>",
      });
    }
    if (url.pathname === "/widget/chatcenter-widget.js") {
      return route.fulfill({ status: 200, contentType: "application/javascript", body: embedScript });
    }
    if (url.pathname === `/widget/${manifest.chat}`) {
      return route.fulfill({ status: 200, contentType: "application/javascript", body: chatBundle });
    }
    if (url.pathname === "/widget/widget-manifest.json") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(manifest) });
    }
    if (url.pathname === "/api/embedded-chat/bootstrap") {
      // The uniform refusal a deleted widget gets.
      if (!widgetExists) {
        // 200 with an empty body: "render nothing" is an answer, and a
        // 404 would put a red line in the tenant's own console.
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {} }) });
      }
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ data: { availability: "online", widget: widgetConfig() } }),
      });
    }
    if (url.pathname === "/api/embedded-chat/init") {
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ data: { sessionId: "conv_1", visitorId: "v1", sessionToken: "conv_1" } }) });
    }
    if (url.pathname.startsWith("/api/embedded-chat/messages")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { messages: [] } }) });
    }
    if (url.pathname === "/api/embedded-chat/message") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {} }) });
    }
    return route.fulfill({ status: 404, body: "" });
  });

  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });

  await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1800);
  return { ctx, page, calls, errors };
}

// ── A widget that no longer exists ──
{
  const { ctx, page, calls, errors } = await openSite({ widgetExists: false });
  const host = await page.locator("#gotcha-chat-root").count();
  check("deleted widget: nothing is added to the page at all", host === 0, `hosts=${host}`);
  check("deleted widget: it asked the server before drawing",
    calls.includes("/api/embedded-chat/bootstrap"), calls.filter((c) => c.startsWith("/api")).join(", ") || "no api calls");
  check("deleted widget: the chat bundle is never even downloaded",
    !calls.some((c) => c.includes(manifest.chat)));
  check("deleted widget: nothing is printed on the tenant's page",
    errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

// ── A live widget ──
{
  const { ctx, page, errors } = await openSite({ widgetExists: true });

  const launcher = await page.evaluate(() => {
    const host = document.getElementById("gotcha-chat-root");
    if (!host || !host.shadowRoot) return null;
    const b = host.shadowRoot.querySelector('[data-act="launcher"]');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    const cs = getComputedStyle(b);
    return { w: Math.round(r.width), h: Math.round(r.height), bg: cs.backgroundColor, label: b.textContent.trim() };
  });
  check("live widget: the launcher is painted", !!launcher, launcher ? `${launcher.w}x${launcher.h} "${launcher.label}"` : "missing");
  check("live widget: it uses the tenant's own accent",
    launcher && launcher.bg === "rgb(14, 165, 233)", launcher ? launcher.bg : "");

  await page.evaluate(() => {
    document.getElementById("gotcha-chat-root").shadowRoot.querySelector('[data-act="launcher"]').click();
  });
  await page.waitForTimeout(1200);

  const panel = await page.evaluate(() => {
    const s = document.getElementById("gotcha-chat-root").shadowRoot;
    const p = s.querySelector(".panel");
    if (!p) return null;
    const box = (sel) => { const e = s.querySelector(sel); return e ? Math.round(e.getBoundingClientRect().height) : null; };
    return {
      view: p.getAttribute("data-view"),
      title: (s.querySelector(".wel-h") || {}).textContent,
      suggestions: s.querySelectorAll(".sug-b:not([hidden])").length,
      composer: box(".ft"),
      close: !!s.querySelector('[data-act="close"]'),
      hasProductCard: !!s.querySelector(".card"),
    };
  });

  check("live widget: opens into the SAME welcome experience as the storefront",
    !!panel && panel.view === "welcome", panel ? `view=${panel.view}` : "no panel");
  check("live widget: shows the tenant's configured welcome copy",
    !!panel && panel.title === "Talk to us", panel ? `"${panel.title}"` : "");
  check("live widget: shows the configured suggested questions",
    !!panel && panel.suggestions === 3, panel ? `${panel.suggestions} shown` : "");
  check("live widget: the composer is the compact one",
    !!panel && panel.composer <= 96, panel ? `${panel.composer}px` : "");
  check("live widget: the close control is present",
    !!panel && panel.close);
  check("live widget: no commerce UI on a website widget",
    !!panel && panel.hasProductCard === false);

  const closed = await page.evaluate(() => {
    const s = document.getElementById("gotcha-chat-root").shadowRoot;
    s.querySelector('[data-act="close"]').click();
    const p = s.querySelector(".panel");
    return { display: getComputedStyle(p).display, state: p.getAttribute("data-state") };
  });
  check("live widget: X closes it", closed.display === "none" && closed.state === "closed",
    `display=${closed.display}`);

  check("live widget: logs nothing on the tenant's page", errors.length === 0, errors.slice(0, 2).join(" | "));

  await page.screenshot({ path: path.join(os.homedir(), ".cache/cc-work/shots/webchat-live.png") }).catch(() => {});
  await ctx.close();
}

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed in Chromium`);
if (failed.length) {
  console.log("\nFAILED:");
  for (const r of failed) console.log(`  • ${r.name}${r.detail ? " — " + r.detail : ""}`);
}
process.exit(failed.length ? 1 : 0);
