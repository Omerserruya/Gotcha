#!/usr/bin/env node
/**
 * Photograph the chat widget in a real browser, using the merchant's live
 * configuration.
 *
 * Used for before/after comparison during design work. The widget is the
 * REAL bundle, the config is fetched from the live API, and the browser is
 * Chromium - so what comes out is what a shopper would see, minus the
 * merchant's own theme behind it.
 *
 *   node scripts/shopify/shoot-widget.mjs <label>
 *
 * Writes <label>-<viewport>.png into shots/.
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

const LABEL = process.argv[2] ?? "shot";
const API = process.env.GOTCHA_API ?? "https://dev.gotcha.co.il";
const SHOP = process.env.SHOP_DOMAIN ?? "urban-supply-gotcha-demo.myshopify.com";
const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const OUT = process.env.SHOT_DIR ?? path.join(os.homedir(), ".cache/cc-work/shots");
fs.mkdirSync(OUT, { recursive: true });

const boot = await fetch(`${API}/api/shopify-chat/bootstrap`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: `https://${SHOP}` },
  body: JSON.stringify({ shopDomain: SHOP, context: { pageType: "index", locale: "en" } }),
}).then((r) => r.json());
if (!boot?.data?.widget) { console.error("no live config:", JSON.stringify(boot).slice(0, 200)); process.exit(2); }

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "frontend/public/widget/widget-manifest.json"), "utf8"));
const chat = fs.readFileSync(path.join(ROOT, "frontend/public/widget", manifest.chat), "utf8");

const browser = await chromium.launch({
  executablePath: path.join(os.homedir(), ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome"),
  headless: true,
});

const NOW = new Date().toISOString();
const CONVO = [
  { id: "a", direction: "INBOUND", body: "Do you have the trail runner in a 42?", messageType: "text", author: null, authorKind: "visitor", createdAt: NOW, commerce: null },
  { id: "b", direction: "OUTBOUND", body: "We do - it is in stock in black and white. Want me to check the fit for you?", messageType: "text", author: "Store Assistant", authorKind: "ai", createdAt: NOW, commerce: null },
];

const SHOTS = [
  { name: "desktop-welcome", width: 1280, height: 900, messages: [] },
  { name: "desktop-conversation", width: 1280, height: 900, messages: CONVO },
  { name: "mobile-390-welcome", width: 390, height: 844, messages: [] },
  { name: "mobile-360-welcome", width: 360, height: 640, messages: [] },
  { name: "mobile-320-welcome", width: 320, height: 568, messages: [] },
];

for (const shot of SHOTS) {
  const ctx = await browser.newContext({ viewport: { width: shot.width, height: shot.height } });
  const page = await ctx.newPage();
  // A real https origin is required - on about:blank the widget's own URL
  // parsing refuses every media URL and the hero silently disappears - but
  // the app that normally lives there is a React dev server that re-renders
  // and wipes the host element. So: a real origin, our own document.
  await page.route(`${API}/__widget-shot`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>' +
        '<body style="margin:0;min-height:100vh;background:linear-gradient(160deg,#f8fafc,#eaeff6)"></body></html>',
    }),
  );
  await page.goto(`${API}/__widget-shot`, { waitUntil: "domcontentloaded" });
  await page.addScriptTag({ content: chat });
  await page.evaluate(
    ([cfg, msgs]) => {
      const host = document.createElement("div");
      host.id = "gotcha-chat-root";
      document.body.appendChild(host);
      const shadow = host.attachShadow({ mode: "open" });
      const store = msgs.length ? { session: "t", conversation: "c" } : {};
      window.__gotchaShopifyChatApp({
        api: "", assets: "",
        context: { pageType: "index", locale: "en" },
        availability: "online",
        store: { get: (k) => store[k] ?? null, set: (k, v) => { store[k] = v; }, del: (k) => { delete store[k]; } },
        post: async (p) => p.endsWith("/conversation")
          ? { data: { conversationId: "c", status: "OPEN", isHandedOver: false, messages: msgs } }
          : { data: {} },
        shadow,
        setUnread: () => {}, onOpened: () => {}, onClosed: () => {},
        widget: cfg,
      }).open();
    },
    [boot.data.widget, shot.messages],
  );
  // Let the hero image actually arrive.
  await page.waitForTimeout(2200);
  const file = path.join(OUT, `${LABEL}-${shot.name}.png`);
  await page.screenshot({ path: file });
  const geom = await page.evaluate(() => {
    const s = document.getElementById("gotcha-chat-root").shadowRoot;
    const h = (sel) => { const e = s.querySelector(sel); return e ? Math.round(e.getBoundingClientRect().height) : null; };
    return { panel: h(".panel"), hero: h(".hero"), body: h(".bd"), composer: h(".ft"), header: h(".hd") };
  });
  console.log(`${shot.name.padEnd(22)} panel=${geom.panel} hero=${geom.hero} body=${geom.body} composer=${geom.composer} header=${geom.header}  → ${path.basename(file)}`);
  await ctx.close();
}

// ── The launcher, through the REAL bootstrap ──
//
// The launcher is painted by the bootstrap, not the chat bundle, so it
// only appears if the whole entry path runs: config discovery, the
// bootstrap POST, then paintLauncher.
const bootstrapJs = fs.readFileSync(path.join(ROOT, "frontend/public/widget/gotcha-shopify-bootstrap.js"), "utf8");

for (const [name, width, height] of [["launcher-desktop", 1280, 900], ["launcher-mobile", 390, 844]]) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  await page.route(`${API}/widget/gotcha-shopify-bootstrap.js*`, (r) =>
    r.fulfill({ status: 200, contentType: "application/javascript", body: bootstrapJs }));
  await page.route(`${API}/widget/${manifest.chat}`, (r) =>
    r.fulfill({ status: 200, contentType: "application/javascript", body: chat }));
  await page.route(`${API}/api/shopify-chat/bootstrap`, (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(boot) }));
  await page.route(`${API}/__launcher-shot`, (r) =>
    r.fulfill({
      status: 200,
      contentType: "text/html",
      body:
        '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>' +
        '<body style="margin:0;min-height:100vh;background:linear-gradient(160deg,#f8fafc,#eaeff6)">' +
        '<script>window.__gotchaShopifyChat={shopDomain:"' + SHOP + '"};<\/script>' +
        '<script src="' + API + '/widget/gotcha-shopify-bootstrap.js"><\/script>' +
        "</body></html>",
    }));
  await page.goto(`${API}/__launcher-shot`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const file = path.join(OUT, `${LABEL}-${name}.png`);
  await page.screenshot({ path: file });
  const geom = await page.evaluate(() => {
    const host = document.getElementById("gotcha-chat-root");
    const b = host && host.shadowRoot && host.shadowRoot.querySelector(".ldr");
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), fromRight: Math.round(window.innerWidth - r.right), fromBottom: Math.round(window.innerHeight - r.bottom) };
  });
  console.log(`${name.padEnd(22)} ${geom ? `${geom.w}x${geom.h} inset right=${geom.fromRight} bottom=${geom.fromBottom}` : "NOT PAINTED"}  → ${path.basename(file)}`);
  await ctx.close();
}

await browser.close();
console.log(`\nwritten to ${OUT}`);
