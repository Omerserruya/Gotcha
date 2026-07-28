/**
 * GOTCHA Shopify Live Chat — bootstrap.
 *
 * This file is on the critical path of every storefront page, so it does
 * the minimum that has to happen there and nothing more:
 *
 *   1. read the page context the Liquid block published
 *   2. one POST to /bootstrap (branding + availability + session)
 *   3. draw the launcher inside a Shadow DOM host
 *   4. load the chat application ONLY when the shopper reaches for it
 *
 * The chat app — message list, product cards, carousel, cart flow — is a
 * separate file that most visitors never download. A merchant judges a
 * chat widget by what it costs them in Core Web Vitals long before they
 * judge it by its conversation quality.
 *
 * No dependencies. No bundler. The widget shares a page with an unknown
 * theme and an unknown set of other apps; shipping a framework here would
 * mean shipping a second copy of whatever the theme already loaded.
 */
(function () {
  "use strict";

  var cfg = window.__gotchaShopifyChat;
  // Either identifier is enough to ASK. Neither is authority: the server
  // answers only if the request Origin belongs to the resolved store.
  // shopDomain is the App Store path; channelKey is recovery only.
  if (!cfg || (!cfg.shopDomain && !cfg.channelKey)) return;
  if (window.__gotchaShopifyChatLoaded) return;
  window.__gotchaShopifyChatLoaded = true;

  var API = String(cfg.apiBase || "").replace(/\/$/, "");
  var ASSETS = String(cfg.assetBase || "").replace(/\/$/, "");
  var IDENTITY = String(cfg.shopDomain || cfg.channelKey || "");
  var STORAGE_PREFIX = "gotcha_sfy_" + IDENTITY.slice(-12);

  // ── Storefront context (hints only; the server re-resolves truth) ──
  var context = {};
  try {
    var node = document.getElementById("gotcha-chat-context");
    if (node) context = JSON.parse(node.textContent || "{}");
  } catch (e) {
    context = {};
  }

  // ── First-party storage. No cookies at all, so nothing here is
  //    affected by third-party cookie blocking, ITP or a shopper's
  //    cross-site tracking preferences. ─────────────────────────────
  var store = {
    get: function (k) {
      try {
        return window.localStorage.getItem(STORAGE_PREFIX + "_" + k);
      } catch (e) {
        return null;
      }
    },
    set: function (k, v) {
      try {
        window.localStorage.setItem(STORAGE_PREFIX + "_" + k, v);
      } catch (e) {
        /* private mode — the session simply won't survive a reload */
      }
    },
    del: function (k) {
      try {
        window.localStorage.removeItem(STORAGE_PREFIX + "_" + k);
      } catch (e) {}
    },
  };

  function post(path, body, token) {
    var headers = { "Content-Type": "application/json" };
    if (token) headers["X-Visitor-Token"] = token;
    return fetch(API + path, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(body || {}),
      credentials: "omit",
      mode: "cors",
    }).then(function (res) {
      return res
        .json()
        .catch(function () {
          return {};
        })
        .then(function (json) {
          if (!res.ok) {
            var err = new Error(json.error || "request_failed");
            err.status = res.status;
            err.body = json;
            throw err;
          }
          return json;
        });
    });
  }

  // ── Host element ────────────────────────────────────────────────
  //
  // One fixed-position host, one closed-ish shadow root. `all: initial`
  // on the host is what guarantees a theme's aggressive `* { }` rules
  // cannot reach in, and Shadow DOM guarantees our styles cannot leak
  // out and reflow the merchant's layout.
  var host = document.createElement("div");
  host.id = "gotcha-chat-root";
  host.setAttribute("data-gotcha", "chat");
  host.style.cssText = "all: initial; position: fixed; z-index: 2147483000;";
  var shadow = host.attachShadow({ mode: "open" });

  var state = {
    cfg: cfg,
    api: API,
    assets: ASSETS,
    context: context,
    store: store,
    post: post,
    shadow: shadow,
    host: host,
    session: null,
    widget: null,
    availability: "online",
    open: false,
    unread: 0,
  };

  // ── Launcher ────────────────────────────────────────────────────

  var launcherStyle = document.createElement("style");
  var launcher = document.createElement("button");
  var badge = document.createElement("span");

  var ICONS = {
    chat:
      '<path d="M12 3c5 0 9 3.36 9 7.5S17 18 12 18a10.7 10.7 0 0 1-3-.42L5 19l1.2-3.2A7.9 7.9 0 0 1 3 10.5C3 6.36 7 3 12 3Z"/>',
    sparkle:
      '<path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Z"/>',
    bag:
      '<path d="M6 8h12l-1 12H7L6 8Zm3 0V6a3 3 0 1 1 6 0v2"/>',
    question:
      '<path d="M12 17h.01M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7"/>',
  };

  function paintLauncher(widget) {
    var a = widget.appearance;
    var side = a.launcherPosition === "left" ? "left" : "right";
    host.style.setProperty(side, "20px");
    host.style.setProperty("bottom", "20px");
    host.style.setProperty(side === "left" ? "right" : "left", "auto");

    launcherStyle.textContent = [
      ":host { all: initial; }",
      ".ldr{",
      "  width:56px;height:56px;border-radius:28px;border:0;cursor:pointer;",
      "  display:flex;align-items:center;justify-content:center;position:relative;",
      "  background:" + a.primaryColor + ";color:" + a.contrastColor + ";",
      "  box-shadow:0 6px 24px rgba(15,23,42,.22),0 2px 6px rgba(15,23,42,.12);",
      "  transition:transform .18s ease, box-shadow .18s ease;",
      "  font:inherit;padding:0;",
      "}",
      ".ldr:hover{transform:translateY(-2px);box-shadow:0 10px 30px rgba(15,23,42,.28);}",
      ".ldr:focus-visible{outline:3px solid " + a.primaryColor + ";outline-offset:3px;}",
      ".ldr svg{width:26px;height:26px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;}",
      ".ldr img{width:56px;height:56px;border-radius:28px;object-fit:cover;}",
      ".bdg{",
      "  position:absolute;top:-2px;" + side + ":-2px;min-width:20px;height:20px;border-radius:10px;",
      "  background:#e11d48;color:#fff;font:600 11px/20px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;",
      "  text-align:center;padding:0 5px;display:none;",
      "}",
      ".bdg[data-show='1']{display:block;}",
      "@media (prefers-reduced-motion: reduce){.ldr{transition:none;}.ldr:hover{transform:none;}}",
      "@media (forced-colors: active){.ldr{border:1px solid ButtonText;}}",
    ].join("\n");

    launcher.className = "ldr";
    launcher.type = "button";
    launcher.setAttribute("aria-haspopup", "dialog");
    launcher.setAttribute("aria-expanded", "false");
    launcher.setAttribute(
      "aria-label",
      widget.welcome.assistantName
        ? "Chat with " + widget.welcome.assistantName
        : "Open chat",
    );
    launcher.innerHTML = a.avatarUrl
      ? '<img src="' + escapeAttr(a.avatarUrl) + '" alt="" />'
      : '<svg viewBox="0 0 24 24" aria-hidden="true">' +
        (ICONS[a.launcherIcon] || ICONS.chat) +
        "</svg>";
    badge.className = "bdg";
    badge.setAttribute("aria-hidden", "true");
    launcher.appendChild(badge);
  }

  function escapeAttr(v) {
    return String(v).replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  state.setUnread = function (n) {
    state.unread = n;
    badge.textContent = n > 9 ? "9+" : String(n);
    badge.setAttribute("data-show", n > 0 ? "1" : "0");
    launcher.setAttribute(
      "aria-label",
      n > 0 ? n + " new message" + (n === 1 ? "" : "s") + " from the store" : "Open chat",
    );
  };

  // ── Lazy app load ───────────────────────────────────────────────

  var appPromise = null;
  function loadApp() {
    if (appPromise) return appPromise;
    appPromise = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = ASSETS + "/widget/gotcha-shopify-chat.js";
      s.async = true;
      s.crossOrigin = "anonymous";
      s.onload = function () {
        if (window.__gotchaShopifyChatApp) resolve(window.__gotchaShopifyChatApp);
        else reject(new Error("app_missing"));
      };
      s.onerror = function () {
        reject(new Error("app_failed"));
      };
      document.head.appendChild(s);
    });
    return appPromise;
  }

  var app = null;
  function openChat() {
    launcher.setAttribute("aria-expanded", "true");
    launcher.setAttribute("data-busy", "1");
    loadApp()
      .then(function (factory) {
        if (!app) app = factory(state);
        state.open = true;
        app.open();
      })
      .catch(function () {
        // A failed app load must not leave a dead button. Surface it
        // where the shopper is looking rather than only in the console.
        launcher.setAttribute("aria-expanded", "false");
        launcher.title = "Chat is unavailable right now. Please try again.";
      })
      .then(function () {
        launcher.removeAttribute("data-busy");
      });
  }

  state.onClosed = function () {
    state.open = false;
    launcher.setAttribute("aria-expanded", "false");
    launcher.style.display = "";
    try {
      launcher.focus();
    } catch (e) {}
  };
  state.onOpened = function () {
    // On phones the panel is full height; leaving a floating button on
    // top of it steals a tap target and covers content.
    if (window.matchMedia("(max-width: 560px)").matches) launcher.style.display = "none";
  };

  launcher.addEventListener("click", function () {
    if (state.open) return;
    openChat();
  });

  // ── Go ──────────────────────────────────────────────────────────

  function start() {
    var existingToken = store.get("session");
    post("/api/shopify-chat/bootstrap", {
      shopDomain: cfg.shopDomain || undefined,
      publicKey: cfg.channelKey || undefined,
      context: context,
      themeId: context.themeId ? String(context.themeId) : null,
      sessionToken: existingToken || undefined,
    })
      .then(function (res) {
        var data = res.data || {};
        state.session = data.session && data.session.token;
        state.widget = data.widget;
        state.availability = data.availability || "online";
        if (!state.session || !state.widget) return;
        store.set("session", state.session);

        paintLauncher(state.widget);
        shadow.appendChild(launcherStyle);
        shadow.appendChild(launcher);
        document.body.appendChild(host);

        // A returning shopper with an open conversation gets the app
        // warmed in idle time so an agent's reply can raise the unread
        // badge without a poll loop. Everyone else pays nothing.
        if (store.get("conversation")) {
          idle(function () {
            loadApp()
              .then(function (factory) {
                if (!app) app = factory(state);
                app.watchInBackground();
              })
              .catch(function () {});
          });
        }

        if (cfg.openOnLoad) openChat();
      })
      .catch(function (err) {
        // Every refusal — disabled channel, wrong origin, plan without
        // the feature — looks identical here on purpose. The storefront
        // simply renders no widget.
        if (err && err.status !== 403) {
          console.warn("[gotcha-chat] bootstrap failed:", err.message);
        }
      });
  }

  function idle(fn) {
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(fn, { timeout: 4000 });
    } else {
      setTimeout(fn, 1500);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
