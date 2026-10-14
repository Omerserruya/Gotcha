#!/usr/bin/env node
/**
 * The storefront widget (gotcha-shopify-bootstrap.js), in a real browser:
 * design 7's bubble and pop-up, the panel it opens, docking, and the
 * WhatsApp kind - on a page shaped like a Shopify theme (the context JSON
 * the theme block prints, the App Proxy), with the server stubbed.
 *
 * WIDGET_DIR: a staged copy (built, not yet in place). dev serves
 * frontend/public/widget from the working tree, so a change is tested
 * there first.
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import process from "node:process";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const pwPath = [
  process.env.PLAYWRIGHT_PATH,
  path.join(ROOT, "frontend-v2/node_modules/playwright/index.mjs"),
  path.join(os.homedir(), "projects/marketing/node_modules/playwright/index.mjs"),
].filter(Boolean).find((c) => fs.existsSync(c));
if (!pwPath) { console.error("playwright not found; set PLAYWRIGHT_PATH"); process.exit(2); }
const { chromium } = await import(pwPath);

const DIR = process.env.WIDGET_DIR || path.join(ROOT, "frontend/public/widget");
const ORIGIN = "https://demo-shop.test";
const SHOTS = path.join(os.homedir(), ".cache/cc-work/shots");
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "✓" : "✗"} ${name}${detail ? "  - " + detail : ""}`);
}

function widgetConfig(over = {}) {
  return {
    appearance: { primaryColor: "#2b2622", contrastColor: "#ffffff", logoUrl: null, avatarUrl: null, launcherIcon: "chat",
      launcherPosition: "right", cornerRadius: 20, language: "en", direction: "auto", showPoweredBy: true },
    welcome: { headline: "Hi", subline: "", assistantName: "Store Assistant", suggestedQuestions: ["Where is my order?"] },
    offline: { active: false, message: "Away", behavior: "ai", formFields: [], consentRequired: false, consentText: "" },
    features: { humanHandoff: false, productMessaging: false, addToCart: false, whatsappHandoff: false },
    brand: { name: "Urban Supply - GOTCHA Demo", initial: "U" },
    ux: {
      welcome: { title: "Hi! How can we help?", subtitle: "", assistantName: "Store Assistant", suggestedQuestions: ["Where is my order?", "Do you ship abroad?"] },
      launcher: { shape: "pill", size: 48, position: "right", mobilePosition: "right", offsetBottom: 18, offsetSide: 18,
        mobileOffsetBottom: 14, backgroundColor: "#2b2622", iconColor: "#ffffff", borderColor: "#ffffff", showBorder: false,
        shadow: 2, icon: "chat", iconUrl: null, label: "Chat with us", showLabel: true, showUnreadBadge: true, hideOnMobileWhenOpen: true },
      hero: { mediaType: "none", mediaUrl: null },
      proactive: { enabled: false, trigger: "time_on_page", delaySeconds: 1, mobileDelaySeconds: 1, minPageViews: 1,
        scrollPercent: 50, customEvent: "", title: "Need a hand?", message: "Looking for something?", actionLabel: "Chat with us",
        autoOpen: false, playSound: false, maxPerSession: 1, maxPerVisitor: 9, cooldownHours: 0, includeUrls: [], excludeUrls: [],
        desktopEnabled: true, mobileEnabled: true, firstVisitOnly: false, returningVisitorOnly: false, respectBusinessHours: false },
      sounds: { enabled: false },
      behavior: { openOnLoad: false },
      kind: "chat",
      look: "gotcha",
    },
    ...over,
  };
}

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  headless: true,
});

async function openShop({ widget = widgetConfig(), availability = "online", lang = "en", wait = 1200, theme = {} } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const calls = [];
  const starts = [];
  const conversations = [];
  await page.addInitScript(() => { window.open = () => null; });
  await page.route(`${ORIGIN}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    calls.push(url.pathname);
    const json = (status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/") {
      const context = { pageType: "product", productHandle: "cotton-trench-coat", locale: lang, ...theme };
      return route.fulfill({
        status: 200, contentType: "text/html",
        body: `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"></head>` +
          '<body style="margin:0;min-height:100vh;background:#faf7f2"><h1 style="font:600 22px sans-serif;padding:24px">A Shopify store</h1>' +
          `<script type="application/json" id="gotcha-chat-context">${JSON.stringify(context)}</script>` +
          `<script>window.__gotchaShopifyChat={shopDomain:"demo-shop.myshopify.com",apiBase:"${ORIGIN}",assetBase:"${ORIGIN}"};</script>` +
          '<script src="/widget/gotcha-shopify-bootstrap.js"></script></body></html>',
      });
    }
    if (url.pathname.startsWith("/widget/")) {
      const rel = url.pathname.replace(/^\/widget\//, "");
      const file = path.join(DIR, rel);
      if (rel.split("/").includes("..") || !fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
      const type = rel.endsWith(".json") ? "application/json" : rel.endsWith(".png") ? "image/png" : "application/javascript";
      return route.fulfill({ status: 200, contentType: type, body: fs.readFileSync(file) });
    }
    // The App Proxy, set up, for an anonymous shopper.
    if (url.pathname === "/apps/gotcha-chat/identity") return json(200, { data: { identified: false } });
    if (url.pathname === "/api/shopify-chat/bootstrap") return json(200, { data: { session: { token: "visitor-token" }, availability, widget } });
    if (url.pathname === "/api/shopify-chat/conversation") {
      const body = JSON.parse(req.postData() || "{}");
      conversations.push(body);
      return json(200, { data: { conversationId: body.fresh ? "c2" : "c1", status: "OPEN", isHandedOver: false, messages: [] } });
    }
    if (url.pathname.startsWith("/api/shopify-chat/messages")) return json(200, { data: { messages: [] } });
    if (url.pathname === "/api/shopify-chat/whatsapp-start") {
      starts.push({ body: JSON.parse(req.postData() || "{}"), token: req.headers()["x-visitor-token"] || null });
      return json(200, { data: { url: "https://wa.me/972500000000?text=hi%20(ref)", ref: "ref" } });
    }
    if (url.pathname.startsWith("/api/shopify-chat/")) return json(200, { data: {} });
    return route.fulfill({ status: 404, body: "" });
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));
  page.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("WebSocket connection to")) errors.push(m.text().slice(0, 160)); });
  page.on("response", (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(wait);
  return { ctx, page, calls, starts, errors, conversations };
}

const look = (page) => page.evaluate(() => {
  const s = document.getElementById("gotcha-chat-root")?.shadowRoot;
  if (!s) return null;
  const rect = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(innerWidth - r.right), bottom: Math.round(innerHeight - r.bottom) }; };
  const b = s.querySelector('[data-act="launcher"]');
  const pop = s.querySelector('[data-act="popup"]');
  const bdg = s.querySelector(".bdg");
  const p = s.querySelector(".panel");
  return {
    bubble: rect(b), bg: b && getComputedStyle(b).backgroundColor, fg: b && getComputedStyle(b).color, display: b && getComputedStyle(b).display,
    face: b ? (b.querySelector(".mark") || {}).textContent || "" : "", chevron: !!(b && b.querySelector(".chev")), glyph: !!(b && b.querySelector("svg path[d^='M12 2a10']")),
    dot: !!(b && b.querySelector(".on")), badge: bdg && bdg.getAttribute("data-show") === "1" ? bdg.textContent : "",
    pop: rect(pop), popText: pop ? pop.textContent : null, typing: !!(pop && pop.querySelector(".pop-ty")),
    panel: p ? p.getAttribute("data-state") : null, panelRect: rect(p),
    tools: Array.from(s.querySelectorAll(".tools > button")).map((t) => t.getAttribute("data-act")),
    wa: rect(s.querySelector('[data-act="wa-panel"]')),
  };
});
const click = (page, sel) => page.evaluate((q) => document.getElementById("gotcha-chat-root").shadowRoot.querySelector(q).click(), sel);

{
  const { ctx, page, errors } = await openShop();
  const a = await look(page);
  check("S1 bubble: 56px at 22/22, the main colour, the brand's initial in cream, the dot",
    a.bubble.w === 56 && a.bubble.right === 22 && a.bubble.bottom === 22 && a.bg === "rgb(43, 38, 34)" && a.fg === "rgb(251, 248, 243)" && a.face === "U" && a.dot,
    JSON.stringify({ ...a.bubble, bg: a.bg, fg: a.fg, f: a.face, d: a.dot }));
  check("S1 bubble: the legacy pill, label and 48px are not drawn", a.bubble.h === 56 && !(await page.evaluate(() => document.getElementById("gotcha-chat-root").shadowRoot.textContent.includes("Chat with us"))));
  await click(page, '[data-act="launcher"]');
  await page.waitForTimeout(900);
  const o = await look(page);
  check("S2 open: design 7's panel, and the bubble is the chevron", o.panel === "open" && o.panelRect.w === 400 && o.panelRect.bottom === 96 && o.chevron && !o.dot, JSON.stringify({ p: o.panel, r: o.panelRect, c: o.chevron }));
  check("S2 open: New conversation and Dock are offered on the storefront too",
    o.tools.join() === "new,dock,close", o.tools.join());
  await click(page, '[data-act="dock"]');
  await page.waitForTimeout(500);
  const d = await look(page);
  check("S3 docked: the bubble steps aside, the page makes room",
    d.display === "none" && (await page.evaluate(() => getComputedStyle(document.documentElement).paddingRight)) === "400px", d.display);
  await click(page, '[data-act="close"]');
  await page.waitForTimeout(500);
  const c = await look(page);
  check("S3 minimised: closed, the bubble back with its initial", c.panel === "closed" && c.display !== "none" && c.face === "U" && (await page.evaluate(() => getComputedStyle(document.documentElement).paddingRight)) === "0px", JSON.stringify({ p: c.panel, d: c.display }));
  await click(page, '[data-act="launcher"]');
  await page.waitForTimeout(600);
  await click(page, '[data-act="launcher"]');
  await page.waitForTimeout(400);
  const t = await look(page);
  check("S2 the chevron minimises the chat", t.panel === "closed" && !t.chevron, t.panel);
  check("S: logs nothing", errors.length === 0, errors.slice(0, 2).join(" | "));
  await page.screenshot({ path: path.join(SHOTS, "storefront-l5.png") }).catch(() => {});
  await ctx.close();
}

{
  const w = widgetConfig();
  w.ux = { ...w.ux, proactive: { ...w.ux.proactive, enabled: true } };
  const { ctx, page } = await openShop({ widget: w, wait: 1700 });
  const typing = await look(page);
  check("S4 pop-up: who is writing, then typing; the legacy title and button are not drawn",
    typing.pop && typing.typing && typing.popText.startsWith("UStore Assistantreplies right away") && !typing.popText.includes("Need a hand?") && !typing.popText.includes("Chat with us"),
    typing.popText);
  await page.waitForTimeout(1700);
  const ready = await look(page);
  check("S4 pop-up: the merchant's message; the bubble's '1'; above the bubble on its side",
    ready.popText.endsWith("Looking for something?") && ready.badge === "1" && ready.pop.right === 22 && ready.pop.bottom === 90 && ready.pop.w === 330,
    JSON.stringify({ t: ready.popText, b: ready.badge, r: ready.pop }));
  await click(page, '[data-act="popup-open"]');
  await page.waitForTimeout(900);
  const opened = await look(page);
  check("S4 pop-up: its message opens the chat; pop-up and '1' go", opened.panel === "open" && opened.pop === null && opened.badge === "", JSON.stringify({ p: opened.panel, b: opened.badge }));
  await ctx.close();
}

{
  const w = widgetConfig();
  w.ux = { ...w.ux, look: "whatsapp" };
  const { ctx, page } = await openShop({ widget: w });
  const a = await look(page);
  check("S5 the WhatsApp look: a green bubble with the WhatsApp mark, no dot", a.bg === "rgb(37, 211, 102)" && a.glyph && !a.dot, JSON.stringify({ bg: a.bg, g: a.glyph }));
  await ctx.close();
}

{
  const { ctx, page } = await openShop({ availability: "offline" });
  const a = await look(page);
  check("S6 offline: no green dot", !a.dot);
  await ctx.close();
}

{
  const w = widgetConfig();
  w.ux = { ...w.ux, kind: "whatsapp", look: "whatsapp" };
  w.features = { ...w.features, whatsappHandoff: true };
  const { ctx, page, starts, calls, errors } = await openShop({ widget: w });
  const a = await look(page);
  check("S7 the WhatsApp kind: WhatsApp's 58px button, no chat", a.bubble.w === 58 && a.bg === "rgb(37, 211, 102)" && a.panel === null, JSON.stringify(a.bubble));
  await click(page, '[data-act="launcher"]');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const s = document.getElementById("gotcha-chat-root").shadowRoot;
    s.querySelector('[data-act="wa-panel"] textarea').value = "Is it in size M?";
    s.querySelector('[data-act="wa-send"]').click();
  });
  await page.waitForTimeout(500);
  check("S7 send: /api/shopify-chat/whatsapp-start with the visitor's token, the words and the product page",
    starts.length === 1 && starts[0].token === "visitor-token" && starts[0].body.text === "Is it in size M?" &&
      starts[0].body.context.pageType === "product" && starts[0].body.context.productHandle === "cotton-trench-coat",
    JSON.stringify(starts));
  check("S7 never a storefront conversation", !calls.includes("/api/shopify-chat/conversation"));
  check("S7 logs nothing", errors.length === 0, errors.slice(0, 2).join(" | "));
  await page.screenshot({ path: path.join(SHOTS, "storefront-l5-wa.png") }).catch(() => {});
  await ctx.close();
}

{
  const w = widgetConfig();
  w.appearance = { ...w.appearance, language: "he", launcherPosition: "left" };
  w.ux = { ...w.ux, launcher: { ...w.ux.launcher, position: "left", mobilePosition: "left" }, proactive: { ...w.ux.proactive, enabled: true, message: "מחפשים משהו?" } };
  const { ctx, page } = await openShop({ widget: w, lang: "he", wait: 3400 });
  const a = await look(page);
  check("S8 Hebrew, left: the bubble and the pop-up on the left, in Hebrew", a.bubble.x === 22 && a.pop.x === 22 && a.popText.includes("עונה מיד"), JSON.stringify({ b: a.bubble.x, p: a.pop.x, t: a.popText }));
  await page.screenshot({ path: path.join(SHOTS, "storefront-l5-he.png") }).catch(() => {});
  await ctx.close();
}

{
  // New conversation (Backend 2c32a9a1): the next /conversation is {fresh: true}.
  const { ctx, page, conversations } = await openShop();
  await click(page, '[data-act="launcher"]');
  await page.waitForTimeout(900);
  await page.evaluate(() => document.getElementById("gotcha-chat-root").shadowRoot.querySelector(".qs .q").click());
  await page.waitForTimeout(800);
  await click(page, '[data-act="new"]');
  await page.waitForTimeout(300);
  const view = await page.evaluate(() => document.getElementById("gotcha-chat-root").shadowRoot.querySelector(".panel").getAttribute("data-view"));
  const before = conversations.length;
  await page.evaluate(() => document.getElementById("gotcha-chat-root").shadowRoot.querySelector(".qs .q").click());
  await page.waitForTimeout(800);
  const next = conversations.slice(before);
  check("S9 New conversation: back to the welcome, and the next message asks for a fresh one",
    view === "welcome" && next.length >= 1 && next[0].fresh === true, JSON.stringify({ view, next }));
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed in Chromium`);
process.exit(failed.length ? 1 : 0);
