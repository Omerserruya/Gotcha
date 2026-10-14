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
 * The server is stubbed here - this is about the script's behaviour, and
 * a real tenant's widget id is not something to require in a test - but
 * the SCRIPT and the BUNDLE are the real files, and Chromium is real.
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import process from "node:process";

const pwPath = [
  process.env.PLAYWRIGHT_PATH,
  path.join(path.resolve(new URL("../..", import.meta.url).pathname), "frontend-v2/node_modules/playwright/index.mjs"),
  path.join(os.homedir(), "projects/marketing/node_modules/playwright/index.mjs"),
].filter(Boolean).find((c) => fs.existsSync(c));
if (!pwPath) { console.error("playwright not found; set PLAYWRIGHT_PATH"); process.exit(2); }
const { chromium } = await import(pwPath);

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
// WIDGET_DIR: a staged copy (built, not yet in place). dev serves
// frontend/public/widget from the working tree, so changes are tested there
// first; mutation runs use it too.
const DIR = process.env.WIDGET_DIR || path.join(ROOT, "frontend/public/widget");
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, "widget-manifest.json"), "utf8"));
const widgetFile = (pathname) => {
  const rel = pathname.replace(/^\/widget\//, "");
  if (rel.split("/").includes("..")) return null;
  const file = path.join(DIR, rel);
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
};

const ORIGIN = "https://example-tenant-site.test";

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "✓" : "✗"} ${name}${detail ? "  - " + detail : ""}`);
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

// The browser the installed Playwright ships with, unless one is named:
// a hardcoded build path broke this script the day that build was replaced.
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  headless: true,
});

/**
 * Serve a tenant's page with the embed snippet on it, with the widget
 * either alive or deleted.
 */
async function openSite({ widgetExists, widget = widgetConfig(), availability = "online", lang = "en",
  stored = null, history = [], wait = 1800, ctx: given = null, waStart = null, blockPopups = false,
  pagePath = "/", bodyClass = "", cart = null }) {
  const ctx = given || await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const calls = [];
  // A returning visitor: the loader's own keys (cc_ + the widget id's last 12).
  if (stored) {
    await page.addInitScript((entries) => {
      for (const [k, v] of Object.entries(entries)) localStorage.setItem("cc_wid_test_123_" + k, v);
    }, stored);
  }

  const inits = [];
  const starts = [];
  const validates = [];
  const messages = [];
  const adds = [];
  if (blockPopups) await page.addInitScript(() => { window.open = () => null; });
  // wa.me is never reached: a popup pointed at it gets an empty page.
  await ctx.route("https://wa.me/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>wa</title>" }));
  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    calls.push(url.pathname);
    if (url.pathname === "/api/embedded-chat/init") inits.push(JSON.parse(route.request().postData() || "{}"));
    if (url.pathname === "/api/embedded-chat/message") messages.push(JSON.parse(route.request().postData() || "{}"));
    if (url.pathname === "/api/embedded-chat/cart/validate") {
      validates.push(JSON.parse(route.request().postData() || "{}"));
      const answer = cart || { status: 200, body: { data: { cartUrl: `${ORIGIN}/?add-to-cart=111&quantity=1`, productId: "111", variantId: "9001", quantity: 1 } } };
      return route.fulfill({ status: answer.status, contentType: "application/json", body: JSON.stringify(answer.body) });
    }
    // The store's add-to-cart link, followed in place on the store's host.
    if (url.searchParams.has("add-to-cart")) {
      adds.push({ url: url.toString(), credentials: route.request().headers()["sec-fetch-mode"] || "" });
      return route.fulfill({ status: 200, contentType: "text/html", body: "<p>added</p>" });
    }
    if (url.pathname === "/api/embedded-chat/whatsapp-start") {
      starts.push(JSON.parse(route.request().postData() || "{}"));
      const answer = waStart || { status: 200, body: { data: { url: "https://wa.me/972500000000?text=hi%20(ref)", ref: "ref" } } };
      return route.fulfill({ status: answer.status, contentType: "application/json", body: JSON.stringify(answer.body) });
    }

    if (url.pathname === new URL(pagePath, ORIGIN).pathname) {
      return route.fulfill({
        status: 200, contentType: "text/html",
        body: `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"></head>` +
          `<body class="${bodyClass}" style="margin:0;min-height:100vh;background:#f8fafc">` +
          '<h1 style="font:600 22px sans-serif;padding:24px">A tenant\'s own website</h1>' +
          `<script>window.__chatcenter={apiUrl:"${ORIGIN}",widgetId:"wid_test_123"};</script>` +
          '<script src="/widget/chatcenter-widget.js"></script>' +
          "</body></html>",
      });
    }
    if (url.pathname.startsWith("/widget/")) {
      const body = widgetFile(url.pathname);
      if (!body) return route.fulfill({ status: 404, body: "" });
      const type = url.pathname.endsWith(".json") ? "application/json" : url.pathname.endsWith(".png") ? "image/png" : "application/javascript";
      return route.fulfill({ status: 200, contentType: type, body });
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
        body: JSON.stringify({ data: { availability, widget } }),
      });
    }
    if (url.pathname === "/api/embedded-chat/init") {
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ data: { sessionId: "conv_1", visitorId: "v1", sessionToken: "tok_1" } }) });
    }
    if (url.pathname.startsWith("/api/embedded-chat/messages")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { messages: history } }) });
    }
    if (url.pathname === "/api/embedded-chat/message") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {} }) });
    }
    return route.fulfill({ status: 404, body: "" });
  });

  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));
  // The harness has no socket server; the widget falls back to polling, and
  // Chromium's own line about the failed handshake is not the widget's.
  page.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("WebSocket connection to")) errors.push(m.text().slice(0, 160)); });

  await page.goto(new URL(pagePath, ORIGIN).toString(), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(wait);
  return { ctx, page, calls, errors, inits, starts, validates, adds, messages };
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
  check("deleted widget: nor the site script, nor the manifest",
    !calls.some((c) => c.includes("gotcha-site") || c.includes("widget-manifest")));
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
      title: (s.querySelector(".disc-nm") || {}).textContent,
      suggestions: s.querySelectorAll(".sug-b:not([hidden])").length,
      composer: box(".ft"),
      close: !!s.querySelector('[data-act="close"]'),
      hasProductCard: !!s.querySelector(".card"),
    };
  });

  check("live widget: opens into the SAME welcome experience as the storefront",
    !!panel && panel.view === "welcome", panel ? `view=${panel.view}` : "no panel");
  check("live widget: shows the assistant's name under the brand's disc",
    !!panel && panel.title === "Support", panel ? `"${panel.title}"` : "");
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

// ── Design 7: the bubble and the pop-up (live widget, L1) ──
//
// What the shadow root holds, read in one place.
const look = (page) => page.evaluate(() => {
  const s = document.getElementById("gotcha-chat-root")?.shadowRoot;
  if (!s) return null;
  const rect = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(innerWidth - r.right), bottom: Math.round(innerHeight - r.bottom) }; };
  const b = s.querySelector('[data-act="launcher"]');
  const pop = s.querySelector('[data-act="popup"]');
  const bdg = s.querySelector(".bdg");
  return {
    bubble: rect(b), bg: b && getComputedStyle(b).backgroundColor, fg: b && getComputedStyle(b).color,
    face: b ? (b.querySelector(".mark") || {}).textContent || "" : "", chevron: !!(b && b.querySelector(".chev")),
    expanded: b && b.getAttribute("aria-expanded"),
    dot: !!(b && b.querySelector(".on")),
    badge: bdg && bdg.getAttribute("data-show") === "1" ? bdg.textContent : "",
    pop: rect(pop), popDir: pop && pop.getAttribute("dir"),
    typing: !!(pop && pop.querySelector(".pop-ty")),
    name: pop ? (pop.querySelector(".pop-nm") || {}).textContent : null,
    replies: pop ? (pop.querySelector(".pop-t") || {}).textContent || "" : null,
    message: pop ? (pop.querySelector(".pop-m") || {}).textContent || "" : null,
    deals: pop && pop.querySelector('[data-act="deals"]') ? pop.querySelector('[data-act="deals"]').textContent : "",
    dealNext: !!(pop && pop.querySelector('[data-act="deal-next"]')),
    panel: (s.querySelector(".panel") || {}).getAttribute?.("data-state") || null,
  };
});
const shadowClick = (page, sel) => page.evaluate((q) => document.getElementById("gotcha-chat-root").shadowRoot.querySelector(q).click(), sel);
const withUx = (ux, extra = {}) => { const w = widgetConfig(extra); w.ux = { ...w.ux, ...ux }; return w; };
const popupOn = (over = {}) => ({ ...widgetConfig().ux.proactive, enabled: true, delaySeconds: 1, mobileDelaySeconds: 1, message: "Hi! Looking for a gift?", ...over });

{
  const { ctx, page, errors } = await openSite({ widgetExists: true,
    widget: { ...widgetConfig({ brand: { name: "Urban Supply - GOTCHA Demo", initial: "U" } }), appearance: { ...widgetConfig().appearance, primaryColor: "#2b2622", contrastColor: "#fbf8f3" } } });
  const a = await look(page);
  check("L1 bubble: 56px, 22px from the side and the bottom", a.bubble.w === 56 && a.bubble.h === 56 && a.bubble.right === 22 && a.bubble.bottom === 22, JSON.stringify(a.bubble));
  check("L1 bubble: the main colour, the brand's initial in its contrast colour", a.bg === "rgb(43, 38, 34)" && a.fg === "rgb(251, 248, 243)" && a.face === "U", `${a.bg} ${a.fg} "${a.face}"`);
  check("L1 bubble: the green dot while someone answers", a.dot);
  check("L1: a pop-up switched off never shows", a.pop === null);
  await shadowClick(page, '[data-act="launcher"]');
  await page.waitForTimeout(500);
  const o = await look(page);
  check("L1 bubble: open, it is a chevron that minimises", o.chevron && o.expanded === "true" && !o.dot && o.panel === "open", JSON.stringify({ c: o.chevron, e: o.expanded, d: o.dot, p: o.panel }));
  await shadowClick(page, '[data-act="launcher"]');
  await page.waitForTimeout(300);
  const c = await look(page);
  check("L1 bubble: the chevron closes the chat", c.panel === "closed" && c.face === "U" && c.dot, JSON.stringify({ p: c.panel, f: c.face }));
  check("L1: logs nothing (bubble)", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

{
  // A pale main colour: dark text, whatever the stored contrastColor (Settings never writes it).
  const pale = widgetConfig({ brand: { name: "Aviv & Co.", initial: "A" } });
  pale.appearance = { ...pale.appearance, primaryColor: "#f5e6c8", contrastColor: "#ffffff" };
  const { page, ctx } = await openSite({ widgetExists: true, widget: pale, wait: 900 });
  const a = await look(page);
  check("L1 bubble: a pale main colour gets dark text", a.bg === "rgb(245, 230, 200)" && a.fg === "rgb(43, 38, 34)" && a.face === "A", `${a.bg} ${a.fg} "${a.face}"`);
  await ctx.close();
}

{
  const { page, ctx } = await openSite({ widgetExists: true, availability: "offline", widget: withUx({ proactive: popupOn() }), wait: 3400 });
  const a = await look(page);
  check("L1 offline: no green dot, and the pop-up does not promise a quick reply", !a.dot && a.pop && a.replies === "", JSON.stringify({ d: a.dot, r: a.replies }));
  await ctx.close();
}

{
  const { ctx, page, errors } = await openSite({ widgetExists: true, widget: withUx({ proactive: popupOn() }), wait: 400 });
  const before = await look(page);
  check("L1 pop-up: not before the merchant's delay", before.pop === null);
  await page.waitForTimeout(900);
  const typing = await look(page);
  check("L1 pop-up: who is writing, then typing", !!typing.pop && typing.typing && typing.name === "Support" && typing.replies === "replies right away" && !typing.message, JSON.stringify({ t: typing.typing, n: typing.name, r: typing.replies }));
  check("L1 pop-up: no '1' while it is still typing", typing.badge === "", typing.badge);
  await page.waitForTimeout(1700);
  const ready = await look(page);
  check("L1 pop-up: the merchant's message, after the typing", ready.message === "Hi! Looking for a gift?" && !ready.typing, ready.message);
  check("L1 pop-up: 330px, 90px up, 22px from the side", ready.pop.w === 330 && ready.pop.bottom === 90 && ready.pop.right === 22, JSON.stringify(ready.pop));
  check("L1 bubble: '1' once the pop-up has its message", ready.badge === "1", ready.badge);
  check("L1 pop-up: no deals strip without chosen coupons", ready.deals === "");
  await shadowClick(page, '[data-act="popup-open"]');
  await page.waitForTimeout(500);
  const opened = await look(page);
  check("L1 pop-up: its message opens the chat, and both pop-up and '1' go", opened.panel === "open" && opened.pop === null && opened.badge === "", JSON.stringify({ p: opened.panel, b: opened.badge }));
  // Once per visit: the next page of the same visit offers nothing.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3200);
  const again = await look(page);
  check("L1 pop-up: once per visit", again.pop === null);
  check("L1: logs nothing (pop-up)", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

{
  const { ctx, page } = await openSite({ widgetExists: true, widget: withUx({ proactive: popupOn() }), wait: 3200 });
  await shadowClick(page, '[data-act="popup-close"]');
  await page.waitForTimeout(200);
  const a = await look(page);
  check("L1 pop-up: ✕ dismisses it and its '1'", a.pop === null && a.badge === "" && a.panel === "closed", JSON.stringify({ b: a.badge, p: a.panel }));
  await ctx.close();
}

{
  const w = withUx({ proactive: popupOn() });
  w.promotions = [
    { code: "SPRING15", amount: "15.00", discountType: "percent", expiresAt: null, minimumAmount: null },
    { code: "TENOFF", amount: "10.00", discountType: "fixed_cart", expiresAt: null, minimumAmount: null },
    { code: "VIP20", amount: "20", discountType: "percent", expiresAt: "2026-12-31T21:59:59.000Z", minimumAmount: "100" },
  ];
  const { ctx, page } = await openSite({ widgetExists: true, widget: w, wait: 3200 });
  const a = await look(page);
  check("L1 deals: the first chosen coupon, in words", a.deals.includes("Active deal") && a.deals.includes("15% off") && a.deals.includes("Coupon code SPRING15"), a.deals);
  await shadowClick(page, '[data-act="deal-next"]');
  const b = await look(page);
  check("L1 deals: onward skips an amount with no currency", b.deals.includes("20% off") && b.deals.includes("VIP20") && b.deals.includes("valid until 31/12"), b.deals);
  await shadowClick(page, '[data-act="deal-next"]');
  const c = await look(page);
  check("L1 deals: and comes round again", c.deals.includes("SPRING15"), c.deals);
  await ctx.close();
}

{
  // Backend: promotions carry `currency` (null when unknown).
  const w = withUx({ proactive: popupOn() });
  w.promotions = [{ code: "TWENTY", amount: "20.00", discountType: "fixed_cart", expiresAt: null, minimumAmount: null, currency: "ILS" }];
  const { ctx, page } = await openSite({ widgetExists: true, widget: w, wait: 3200 });
  const a = await look(page);
  check("L1 deals: a fixed amount with its currency is said", a.deals.includes("₪20.00 off") || a.deals.includes("₪20 off"), a.deals);
  await ctx.close();
}

{
  const w = withUx({ proactive: popupOn() });
  w.promotions = [{ code: "TENOFF", amount: "10.00", discountType: "fixed_cart", expiresAt: null, minimumAmount: null, currency: null }];
  const { ctx, page } = await openSite({ widgetExists: true, widget: w, wait: 3200 });
  const a = await look(page);
  check("L1 deals: nothing truthful to say, no strip", a.message && a.deals === "", a.deals);
  await ctx.close();
}

{
  const history = [
    { id: "m1", direction: "INBOUND", body: "Do you ship to Eilat?", createdAt: "2026-10-14T08:00:00.000Z" },
    { id: "m2", direction: "OUTBOUND", body: "Yes, in two days.\nAnything else?", createdAt: "2026-10-14T08:00:05.000Z" },
  ];
  const { ctx, page } = await openSite({ widgetExists: true, widget: withUx({ proactive: popupOn() }), wait: 3200,
    stored: { conversation: "conv_1", token: "conv_1", session: "conv_1" }, history });
  const a = await look(page);
  check("L1 resume: a conversation under way is offered back, with its last line", a.message === "Pick up where we left off?Yes, in two days.", a.message);
  check("L1 resume: no '1' for an offer", a.badge === "", a.badge);
  await ctx.close();
}

{
  const he = widgetConfig();
  he.appearance = { ...he.appearance, language: "he" };
  he.ux = { ...he.ux, proactive: popupOn({ message: "היי, אפשר לעזור?" }), launcher: { ...he.ux.launcher, position: "left", mobilePosition: "left" } };
  const { ctx, page } = await openSite({ widgetExists: true, widget: he, lang: "he", wait: 3200 });
  const a = await look(page);
  check("L1 Hebrew: the pop-up reads right to left, in Hebrew", a.popDir === "rtl" && a.replies === "עונה מיד", `${a.popDir} "${a.replies}"`);
  check("L1 left side: bubble and pop-up on the left", a.bubble.x === 22 && a.pop.x === 22, `${a.bubble.x} ${a.pop.x}`);
  await page.screenshot({ path: path.join(os.homedir(), ".cache/cc-work/shots/webchat-l1-he.png") }).catch(() => {});
  await ctx.close();
}

// ── Design 7: the panel (live widget L2) ──
const panelLook = (page) => page.evaluate(() => {
  const s = document.getElementById("gotcha-chat-root").shadowRoot;
  const rect = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(innerWidth - r.right), bottom: Math.round(innerHeight - r.bottom) }; };
  const p = s.querySelector(".panel");
  const cs = (e, k) => (e ? getComputedStyle(e)[k] : null);
  const send = s.querySelector(".snd");
  const pw = s.querySelector("a.pwl");
  const logo = pw && pw.querySelector("img");
  return {
    view: p.getAttribute("data-view"), panel: rect(p), radius: cs(p, "borderTopLeftRadius"), bg: cs(p, "backgroundColor"),
    cover: rect(s.querySelector(".cv")), disc: rect(s.querySelector(".disc")), discOn: !!s.querySelector(".disc-on"),
    rows: Array.from(s.querySelectorAll(".qs .q")).map((q) => Math.round(q.getBoundingClientRect().height)),
    send: rect(send), sendBg: cs(send, "backgroundColor"), sendRadius: cs(send, "borderTopLeftRadius"),
    powered: pw ? { href: pw.getAttribute("href"), text: pw.textContent, logo: logo ? logo.naturalWidth : 0 } : null,
    tools: Array.from(s.querySelectorAll(".tools > button")).map((b) => ({ act: b.getAttribute("data-act"), ...rect(b), visible: getComputedStyle(b).display !== "none" })),
    header: rect(s.querySelector(".hd")), headerShown: s.querySelector(".hd") ? getComputedStyle(s.querySelector(".hd")).display !== "none" : false,
    avatar: rect(s.querySelector(".hd-av")), status: (s.querySelector(".hd-st") || {}).textContent,
    mine: (() => { const b = s.querySelector(".row[data-me='1'] .bub"); return b ? { bg: cs(b, "backgroundColor"), fg: cs(b, "color") } : null; })(),
  };
});

{
  const w = widgetConfig({ brand: { name: "Urban Supply - GOTCHA Demo", initial: "U" } });
  w.appearance = { ...w.appearance, primaryColor: "#2b2622", cornerRadius: 8 };
  const { ctx, page, errors, inits } = await openSite({ widgetExists: true, widget: w, wait: 1200 });
  await shadowClick(page, '[data-act="launcher"]');
  await page.waitForTimeout(700);
  const a = await panelLook(page);
  check("L2 panel: 400 × 680, 96px up and 22px in, radius 22, on #FBF8F3 (configured radius 8 ignored)",
    a.panel.w === 400 && a.panel.h === 680 && a.panel.bottom === 96 && a.panel.right === 22 && a.radius === "22px" && a.bg === "rgb(251, 248, 243)", JSON.stringify({ ...a.panel, r: a.radius, bg: a.bg }));
  check("L2 welcome: a 168px cover, the 100px disc 56px over its edge, with the green dot",
    a.cover.h === 168 && a.disc.w === 100 && a.disc.y === a.cover.y + 168 - 56 && a.discOn, JSON.stringify({ c: a.cover, d: a.disc }));
  check("L2 welcome: the questions are 52px rows", a.rows.length === 3 && a.rows.every((h) => h >= 52), JSON.stringify(a.rows));
  check("L2 welcome: no header; the tools are 34px glass circles 12px from the corner, minimise last",
    !a.headerShown && a.tools.filter((t) => t.visible).map((t) => t.act).join() === "dock,close" && a.tools.find((t) => t.act === "close").w === 34 && a.tools.find((t) => t.act === "close").y === a.panel.y + 12,
    JSON.stringify(a.tools));
  check("L2 composer: a 40px round send, #D6CCBF while empty", a.send.w === 40 && a.send.h === 40 && a.sendRadius === "50%" && a.sendBg === "rgb(214, 204, 191)", JSON.stringify({ ...a.send, bg: a.sendBg, r: a.sendRadius }));
  check("L2 powered by: the words and our logo, linked", a.powered && a.powered.href === "https://gotcha.co.il" && a.powered.text === "Powered by" && a.powered.logo > 0, JSON.stringify(a.powered));
  await page.screenshot({ path: path.join(os.homedir(), ".cache/cc-work/shots/webchat-l2-welcome.png") }).catch(() => {});

  await page.evaluate(() => {
    const s = document.getElementById("gotcha-chat-root").shadowRoot;
    const ta = s.querySelector("textarea");
    ta.value = "Do you ship to Eilat?";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const typed = await panelLook(page);
  check("L2 composer: the send takes the main colour once there is text", typed.sendBg === "rgb(43, 38, 34)", typed.sendBg);
  await page.evaluate(() => document.getElementById("gotcha-chat-root").shadowRoot.querySelector(".snd").click());
  await page.waitForTimeout(700);
  const c = await panelLook(page);
  // 12 + the 38px avatar + 12, and its 1px rule (design 7).
  check("L2 conversation: the header, 63px, the 38px avatar, and who answers", c.view === "conversation" && c.headerShown && c.header.h === 63 && c.avatar.w === 38 && /Typing|Replies right away/.test(c.status), JSON.stringify({ v: c.view, h: c.header, a: c.avatar, s: c.status }));
  check("L2 conversation: the visitor's bubble in the main colour, cream on it", c.mine && c.mine.bg === "rgb(43, 38, 34)" && c.mine.fg === "rgb(251, 248, 243)", JSON.stringify(c.mine));
  check("L2 conversation: the tools in the header: new conversation, dock, then minimise", c.tools.filter((t) => t.visible).map((t) => t.act).join() === "new,dock,close" && c.tools[0].w === 32, JSON.stringify(c.tools));
  await page.screenshot({ path: path.join(os.homedir(), ".cache/cc-work/shots/webchat-l2-conversation.png") }).catch(() => {});

  const before = inits.length;
  await shadowClick(page, '[data-act="new"]');
  await page.waitForTimeout(300);
  const n = await panelLook(page);
  check("L2 new conversation: back to the welcome", n.view === "welcome", n.view);
  await page.evaluate(() => {
    const s = document.getElementById("gotcha-chat-root").shadowRoot;
    s.querySelector(".qs .q").click();
  });
  await page.waitForTimeout(600);
  const fresh = inits.slice(before);
  check("L2 new conversation: the next message starts one - /init without the old token",
    fresh.length >= 1 && fresh.every((b) => !b.sessionToken), JSON.stringify(fresh.map((b) => b.sessionToken ?? null)));
  check("L2: logs nothing (panel)", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

{
  const he = widgetConfig({ brand: { name: "אורבן סאפליי", initial: "א" } });
  // The server sends the side in both places (publicWebchatConfig).
  he.appearance = { ...he.appearance, language: "he", direction: "auto", primaryColor: "#2b2622", launcherPosition: "left" };
  he.ux = { ...he.ux, launcher: { ...he.ux.launcher, position: "left", mobilePosition: "left" }, welcome: { ...he.ux.welcome, assistantName: "נועה", suggestedQuestions: ["איפה ההזמנה שלי?", "יש משלוח לאילת?", "איך מחזירים?"] } };
  const { ctx, page } = await openSite({ widgetExists: true, widget: he, lang: "he", wait: 1200 });
  await shadowClick(page, '[data-act="launcher"]');
  await page.waitForTimeout(700);
  const a = await panelLook(page);
  check("L2 Hebrew, left: the panel 22px from the left, the tools in the left corner",
    a.panel.x === 22 && a.tools.find((t) => t.act === "close").x === a.panel.x + 12, JSON.stringify({ p: a.panel.x, t: a.tools }));
  await page.screenshot({ path: path.join(os.homedir(), ".cache/cc-work/shots/webchat-l2-he.png") }).catch(() => {});
  await ctx.close();
}

// ── Design 7: docking (live widget L3) ──
const dockLook = (page) => page.evaluate(() => {
  const s = document.getElementById("gotcha-chat-root").shadowRoot;
  const p = s.querySelector(".panel");
  const r = p.getBoundingClientRect();
  const b = s.querySelector('[data-act="launcher"]');
  const cs = getComputedStyle(document.documentElement);
  return {
    docked: p.getAttribute("data-docked"), state: p.getAttribute("data-state"),
    panel: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    radius: getComputedStyle(p).borderTopLeftRadius,
    padR: cs.paddingRight, padL: cs.paddingLeft,
    bubble: b ? getComputedStyle(b).display : null,
    dock: (s.querySelector('[data-act="dock"]') || {}).getAttribute?.("aria-pressed") ?? null,
  };
});

{
  const w = widgetConfig({ brand: { name: "Urban Supply", initial: "U" } });
  const { ctx, page, errors } = await openSite({ widgetExists: true, widget: w, wait: 1200 });
  await shadowClick(page, '[data-act="launcher"]');
  await page.waitForTimeout(600);
  await shadowClick(page, '[data-act="dock"]');
  await page.waitForTimeout(500);
  const d = await dockLook(page);
  check("L3 docked: the full height, flush right, 400px wide, square", d.docked === "1" && d.panel.x === 880 && d.panel.y === 0 && d.panel.w === 400 && d.panel.h === 900 && d.radius === "0px", JSON.stringify(d));
  check("L3 docked: the page makes 400px of room; the bubble steps aside", d.padR === "400px" && d.bubble === "none" && d.dock === "true", JSON.stringify({ p: d.padR, b: d.bubble }));
  await page.screenshot({ path: path.join(os.homedir(), ".cache/cc-work/shots/webchat-l3-docked.png") }).catch(() => {});
  await shadowClick(page, '[data-act="dock"]');
  await page.waitForTimeout(500);
  const u = await dockLook(page);
  check("L3 undocked: back to the floating panel, the page as it was", !u.docked && u.panel.h === 680 && u.padR === "0px" && u.bubble !== "none", JSON.stringify(u));
  await shadowClick(page, '[data-act="dock"]');
  await page.waitForTimeout(300);
  await shadowClick(page, '[data-act="close"]');
  await page.waitForTimeout(500);
  const m = await dockLook(page);
  check("L3 minimised while docked: closed, the page's room returned, the bubble back", m.state === "closed" && m.padR === "0px" && m.bubble !== "none", JSON.stringify(m));
  await page.setViewportSize({ width: 800, height: 900 });
  await shadowClick(page, '[data-act="launcher"]');
  await page.waitForTimeout(500);
  const narrow = await page.evaluate(() => getComputedStyle(document.getElementById("gotcha-chat-root").shadowRoot.querySelector('[data-act="dock"]')).display);
  check("L3 narrow screen: no dock offered", narrow === "none", narrow);
  check("L3: logs nothing (docking)", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

{
  const he = widgetConfig();
  he.appearance = { ...he.appearance, language: "he", direction: "auto", launcherPosition: "left" };
  he.ux = { ...he.ux, launcher: { ...he.ux.launcher, position: "left", mobilePosition: "left" } };
  const { ctx, page } = await openSite({ widgetExists: true, widget: he, lang: "he", wait: 1200 });
  await shadowClick(page, '[data-act="launcher"]');
  await page.waitForTimeout(600);
  await shadowClick(page, '[data-act="dock"]');
  await page.waitForTimeout(500);
  const d = await dockLook(page);
  check("L3 docked on the left: flush left, the page's room on the left", d.panel.x === 0 && d.padL === "400px" && d.padR === "0px", JSON.stringify(d));
  await ctx.close();
}

// ── Design 7: the WhatsApp kind (live widget L4) ──
const waLook = (page) => page.evaluate(() => {
  const s = document.getElementById("gotcha-chat-root").shadowRoot;
  const rect = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(innerWidth - r.right), bottom: Math.round(innerHeight - r.bottom) }; };
  const fab = s.querySelector('[data-act="launcher"]');
  const pn = s.querySelector('[data-act="wa-panel"]');
  const nt = pn && pn.querySelector(".nt");
  return {
    fab: rect(fab), fabBg: fab && getComputedStyle(fab).backgroundColor, fabLabel: fab && fab.getAttribute("aria-label"),
    teaser: (s.querySelector('[data-act="popup"]') || {}).textContent ?? null,
    panel: rect(pn), dir: (s.querySelector(".wa") || {}).getAttribute?.("dir"),
    head: pn ? getComputedStyle(pn.querySelector(".hd")).backgroundColor : null,
    title: pn ? pn.querySelector(".hd-n").textContent : null,
    greeting: pn && pn.querySelector('[data-act="greeting"]') ? pn.querySelector('[data-act="greeting"]').textContent : null,
    note: nt && !nt.hidden ? nt.textContent : "", noteLink: nt && nt.querySelector("a") ? nt.querySelector("a").getAttribute("href") : null,
    chat: !!s.querySelector(".panel"),
  };
});
const waWidget = (extra = {}) => {
  const w = widgetConfig({ brand: { name: "Urban Supply", initial: "U" } });
  w.ux = { ...w.ux, kind: "whatsapp", look: "whatsapp", welcome: { ...w.ux.welcome, title: "Hi! How can we help?" }, ...extra };
  w.features = { ...w.features, whatsappHandoff: true };
  return w;
};

{
  const { ctx, page, errors, inits, starts } = await openSite({ widgetExists: true, widget: waWidget({ proactive: popupOn({ message: "Got a question? We're here." }) }), wait: 3000 });
  const a = await waLook(page);
  check("L4 WhatsApp kind: a 58px green button, 18px from the side, 22px up", a.fab.w === 58 && a.fab.right === 18 && a.fab.bottom === 22 && a.fabBg === "rgb(37, 211, 102)", JSON.stringify({ ...a.fab, bg: a.fabBg }));
  check("L4 WhatsApp kind: the teaser is the merchant's pop-up line", a.teaser === "Got a question? We're here.✕", a.teaser);
  check("L4 WhatsApp kind: no chat on the site (no chat panel)", !a.chat);
  await shadowClick(page, '[data-act="popup-open"]');
  await page.waitForTimeout(300);
  const o = await waLook(page);
  check("L4 panel: 330px, WhatsApp's green header, the greeting the business wrote, marked now",
    o.panel.w === 330 && o.head === "rgb(0, 128, 105)" && o.title === "Chat with us" && o.greeting === "Hi! How can we help?now" && o.teaser === null && o.fabLabel === "Close",
    JSON.stringify(o));
  const popup = ctx.waitForEvent("page");
  await page.evaluate(() => {
    const s = document.getElementById("gotcha-chat-root").shadowRoot;
    const ta = s.querySelector('[data-act="wa-panel"] textarea');
    ta.value = "Is the blue one in stock?";
    s.querySelector('[data-act="wa-send"]').click();
  });
  const win = await popup;
  await win.waitForURL(/wa\.me/, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  const sent = await waLook(page);
  check("L4 send: /whatsapp-start with the widget, the words, the language and the page",
    starts.length === 1 && starts[0].widgetId === "wid_test_123" && starts[0].text === "Is the blue one in stock?" && starts[0].locale === "en" && starts[0].context.path === "/" && starts[0].context.pageType === "page",
    JSON.stringify(starts));
  check("L4 send: the window opened in the click goes to wa.me", /^https:\/\/wa\.me\//.test(win.url()), win.url());
  check("L4 send: says it continues on WhatsApp", sent.note === "Continuing on WhatsApp" && sent.noteLink === null, sent.note);
  check("L4: never an /init, never a conversation on the site", inits.length === 0, String(inits.length));
  check("L4: logs nothing", errors.length === 0, errors.slice(0, 2).join(" | "));
  await page.screenshot({ path: path.join(os.homedir(), ".cache/cc-work/shots/webchat-l4.png") }).catch(() => {});
  await ctx.close();
}

{
  const { ctx, page, starts } = await openSite({ widgetExists: true, widget: waWidget(), wait: 1000, blockPopups: true });
  await shadowClick(page, '[data-act="launcher"]');
  await page.waitForTimeout(200);
  await shadowClick(page, '[data-act="wa-send"]');
  await page.waitForTimeout(400);
  const a = await waLook(page);
  check("L4 blocked window: the link is offered to tap", a.noteLink === "https://wa.me/972500000000?text=hi%20(ref)" && a.note === "Continuing on WhatsApp Open WhatsApp", JSON.stringify(a.note));
  check("L4 empty message: sent without text (the server writes the greeting)", starts.length === 1 && !("text" in starts[0]), JSON.stringify(starts));
  await ctx.close();
}

{
  const { ctx, page } = await openSite({ widgetExists: true, widget: waWidget({ welcome: { ...widgetConfig().ux.welcome, title: "" } }), wait: 1000, waStart: { status: 404, body: { error: "unavailable" } } });
  await shadowClick(page, '[data-act="launcher"]');
  await page.waitForTimeout(200);
  const pages = ctx.pages().length;
  await shadowClick(page, '[data-act="wa-send"]');
  await page.waitForTimeout(600);
  const a = await waLook(page);
  check("L4 refused: says so, and the opened window is closed again", a.note === "WhatsApp didn't open. Please try again." && ctx.pages().length === pages, `${a.note} pages=${ctx.pages().length}/${pages}`);
  check("L4 no greeting written: no bubble", a.greeting === null);
  await ctx.close();
}

{
  const w = waWidget();
  w.appearance = { ...w.appearance, language: "he", direction: "auto" };
  w.ux = { ...w.ux, welcome: { ...w.ux.welcome, title: "היי! איך אפשר לעזור?" }, launcher: { ...w.ux.launcher, position: "left", mobilePosition: "left" } };
  const { ctx, page } = await openSite({ widgetExists: true, widget: w, lang: "he", wait: 1000 });
  await shadowClick(page, '[data-act="launcher"]');
  await page.waitForTimeout(300);
  const a = await waLook(page);
  check("L4 Hebrew, left: right to left, in Hebrew, on the left", a.dir === "rtl" && a.title === "דברו איתנו" && a.fab.x === 18 && a.panel.x === 18, JSON.stringify({ d: a.dir, t: a.title, f: a.fab.x, p: a.panel.x }));
  await page.screenshot({ path: path.join(os.homedir(), ".cache/cc-work/shots/webchat-l4-he.png") }).catch(() => {});
  await ctx.close();
}

// The page the visitor is on goes with them to WhatsApp (supervisor: the
// AI greets about the viewed product).
for (const [label, pagePath, bodyClass, want] of [
  ["a Woo product page: its slug and its id", "/product/blue-runner/", "single-product postid-12", { pageType: "product", productHandle: "blue-runner", path: "/product/blue-runner/", productId: "12" }],
  ["plain permalinks", "/?product=red-cap", "single-product", { pageType: "product", productHandle: "red-cap", path: "/" }],
  ["a Hebrew slug, decoded (Backend 2c32a9a1)", "/product/%D7%A0%D7%A2%D7%9C/", "single-product", { pageType: "product", productHandle: "נעל", path: "/product/%D7%A0%D7%A2%D7%9C/" }],
  ["not a product page", "/about/", "page", { pageType: "page", productHandle: null, path: "/about/" }],
]) {
  const { ctx, page, starts } = await openSite({ widgetExists: true, widget: waWidget(), wait: 1000, pagePath, bodyClass, blockPopups: true });
  await shadowClick(page, '[data-act="launcher"]');
  await page.waitForTimeout(200);
  await shadowClick(page, '[data-act="wa-send"]');
  await page.waitForTimeout(400);
  const got = starts[0] && starts[0].context;
  check(`L4 page context, ${label}`, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
  await ctx.close();
}

// ── Woo product cards and Add to cart (live widget L6, W9b/c) ──
const wooHistory = [
  { id: "m1", direction: "INBOUND", body: "Running shoes?", createdAt: "2026-10-14T08:00:00.000Z" },
  { id: "m2", direction: "OUTBOUND", body: "Cloud Pro Runner", messageType: "woo_product", createdAt: "2026-10-14T08:00:05.000Z",
    commerce: { addToCartEnabled: true, products: [{ productId: "111", handle: "cloud-pro", title: "Cloud Pro Runner", imageUrl: null,
      productUrl: `${ORIGIN}/product/cloud-pro/`, currency: "ILS", price: "120", compareAtPrice: null, available: true, published: true,
      selectedVariantId: "9001", optionNames: [], reason: "Light and quick.",
      variants: [{ variantId: "9001", title: "Default", price: "120", compareAtPrice: null, available: true, options: [], requiresSellingPlan: false }] }] } },
];
const wooWidget = () => { const w = widgetConfig(); w.features = { ...w.features, productMessaging: true, addToCart: true }; return w; };
const addToCartClick = (page) => page.evaluate(() => {
  const s = document.getElementById("gotcha-chat-root").shadowRoot;
  Array.from(s.querySelectorAll("button")).find((b) => b.textContent === "Add to cart").click();
});

{
  const { ctx, page, validates, adds, errors } = await openSite({ widgetExists: true, widget: wooWidget(), wait: 1000,
    stored: { conversation: "conv_1", token: "tok_1", session: "conv_1" }, history: wooHistory });
  await shadowClick(page, '[data-act="launcher"]');
  await page.waitForTimeout(900);
  const card = await page.evaluate(() => {
    const s = document.getElementById("gotcha-chat-root").shadowRoot;
    const c = s.querySelector(".card");
    return c ? { title: (c.querySelector(".card-ti") || {}).textContent, price: (c.querySelector(".pr") || {}).textContent } : null;
  });
  check("L6 a Woo product card from the conversation (commerce passed through)", card && card.title === "Cloud Pro Runner" && /120/.test(card.price), JSON.stringify(card));
  await addToCartClick(page);
  await page.waitForTimeout(800);
  check("L6 /cart/validate with the visitor's conversation, token and the line",
    validates.length === 1 && validates[0].sessionId === "conv_1" && validates[0].sessionToken === "tok_1" && validates[0].productId === "111" && validates[0].variantId === "9001" && validates[0].quantity === 1,
    JSON.stringify(validates));
  // A page that navigated away has no widget to read: that is the failure.
  const after = await page.evaluate(() => {
    const s = document.getElementById("gotcha-chat-root").shadowRoot;
    return { text: s.textContent, viewCart: Array.from(s.querySelectorAll("a")).some((a) => a.textContent === "View cart"), url: location.href };
  }).catch(() => ({ text: "", viewCart: false, url: page.url() }));
  check("L6 on the store's own host: the link is followed in place, the visitor stays, 'Added to cart'",
    adds.length === 1 && adds[0].url.includes("add-to-cart=111") && after.text.includes("Added to cart") && after.url === `${ORIGIN}/` && !after.viewCart,
    JSON.stringify({ adds, u: after.url, v: after.viewCart }));
  check("L6: logs nothing", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

{
  const other = "https://another-store.test";
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route(`${other}/**`, (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<p>store</p>" }));
  const { page } = await openSite({ widgetExists: true, widget: wooWidget(), wait: 1000, ctx,
    stored: { conversation: "conv_1", token: "tok_1", session: "conv_1" }, history: wooHistory,
    cart: { status: 200, body: { data: { cartUrl: `${other}/?add-to-cart=111&quantity=1`, productId: "111", variantId: "9001", quantity: 1 } } } });
  await shadowClick(page, '[data-act="launcher"]');
  await page.waitForTimeout(900);
  await addToCartClick(page);
  await page.waitForURL(/another-store/, { timeout: 5000 }).catch(() => {});
  check("L6 on another host: the page goes to the store's add-to-cart link", page.url().startsWith(`${other}/?add-to-cart=111`), page.url());
  await ctx.close();
}

{
  const { ctx, page } = await openSite({ widgetExists: true, widget: wooWidget(), wait: 1000,
    stored: { conversation: "conv_1", token: "tok_1", session: "conv_1" }, history: wooHistory,
    cart: { status: 422, body: { error: "out_of_stock" } } });
  await shadowClick(page, '[data-act="launcher"]');
  await page.waitForTimeout(900);
  await addToCartClick(page);
  await page.waitForTimeout(600);
  const err = await page.evaluate(() => (document.getElementById("gotcha-chat-root").shadowRoot.querySelector(".cart-err") || {}).textContent);
  check("L6 a refusal in words (422 out_of_stock)", err === "This one is sold out.", err);
  await ctx.close();
}

{
  // The site widget's messages carry the page they were written on (Backend 2c32a9a1).
  const { ctx, page, messages } = await openSite({ widgetExists: true, widget: widgetConfig(), wait: 1000, pagePath: "/product/blue-runner/", bodyClass: "single-product postid-12" });
  await shadowClick(page, '[data-act="launcher"]');
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById("gotcha-chat-root").shadowRoot.querySelector(".qs .q").click());
  await page.waitForTimeout(800);
  const c = messages[0] && messages[0].context;
  check("L6 a message carries the page: the product's id and slug", !!c && c.productId === "12" && c.productHandle === "blue-runner" && c.pageType === "product", JSON.stringify(c));
  await ctx.close();
}

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed in Chromium`);
if (failed.length) {
  console.log("\nFAILED:");
  for (const r of failed) console.log(`  • ${r.name}${r.detail ? " - " + r.detail : ""}`);
}
process.exit(failed.length ? 1 : 0);
