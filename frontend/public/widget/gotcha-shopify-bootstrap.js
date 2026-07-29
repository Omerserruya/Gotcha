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

  // Where GOTCHA lives. Prefer the explicit setting, but fall back to the
  // origin this very script was loaded from: whoever served the bootstrap
  // is by definition the deployment that owns this widget. That removes a
  // whole class of failure where a merchant (or a dev store) has the asset
  // host right and the API host wrong, and the two silently disagree.
  function originOfThisScript() {
    try {
      var el = document.currentScript;
      if (!el) {
        var all = document.getElementsByTagName("script");
        for (var i = all.length - 1; i >= 0; i--) {
          if (all[i].src && all[i].src.indexOf("gotcha-shopify-bootstrap") !== -1) { el = all[i]; break; }
        }
      }
      return el && el.src ? new URL(el.src, window.location.href).origin : "";
    } catch (e) {
      return "";
    }
  }

  var API = String(cfg.apiBase || originOfThisScript() || "").replace(/\/$/, "");
  var ASSETS = String(cfg.assetBase || "").replace(/\/$/, "");
  // Whatever ?v= the <script> tag was loaded with, reused for every other
  // asset this bootstrap pulls.
  var ASSET_VERSION_QS = (function () {
    try {
      var src = (document.currentScript && document.currentScript.src) || "";
      var m = src.match(/[?&]v=([^&]+)/);
      return m ? "?v=" + m[1] : "";
    } catch (e) {
      return "";
    }
  })();

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

  /**
   * Draw the launcher entirely from merchant configuration.
   *
   * Falls back to the legacy `appearance` fields whenever a channel has
   * no `ux.launcher` block, so a store configured before any of this
   * shipped renders exactly as it did yesterday.
   *
   * Nothing here interpolates merchant text into markup: the label goes
   * in via textContent and the custom icon via a src attribute that has
   * already survived HTTPS + no-SVG validation on the server.
   */
  function paintLauncher(widget) {
    var a = widget.appearance || {};
    var L = (widget.ux && widget.ux.launcher) || null;
    var mobile = window.matchMedia("(max-width: 560px)").matches;

    var size = L ? L.size : 56;
    var bg = L ? L.backgroundColor : a.primaryColor;
    var fg = L ? L.iconColor : a.contrastColor;
    var side = (L ? (mobile ? L.mobilePosition : L.position) : a.launcherPosition) === "left" ? "left" : "right";
    var offSide = L ? L.offsetSide : 20;
    var offBottom = L ? (mobile ? L.mobileOffsetBottom : L.offsetBottom) : 20;

    // Shape is expressed as a radius so one rule covers all three, and a
    // pill only widens when it actually carries a label.
    var showLabel = !!(L && L.showLabel && L.label);
    var radius = L
      ? (L.shape === "circle" ? Math.round(size / 2) : L.shape === "pill" ? Math.round(size / 2) : 16)
      : 28;
    var width = showLabel ? "auto" : size + "px";
    var padding = showLabel ? "0 " + Math.round(size / 3.5) + "px" : "0";

    var SHADOWS = [
      "none",
      "0 2px 8px rgba(15,23,42,.14)",
      "0 6px 24px rgba(15,23,42,.22),0 2px 6px rgba(15,23,42,.12)",
      "0 12px 38px rgba(15,23,42,.32),0 4px 10px rgba(15,23,42,.18)",
    ];
    var shadow = SHADOWS[L ? L.shadow : 2] || SHADOWS[2];

    host.style.setProperty(side, offSide + "px");
    host.style.setProperty("bottom", offBottom + "px");
    host.style.setProperty(side === "left" ? "right" : "left", "auto");

    launcherStyle.textContent = [
      ":host { all: initial; }",
      ".ldr{",
      "  min-width:" + size + "px;width:" + width + ";height:" + size + "px;",
      "  padding:" + padding + ";border-radius:" + radius + "px;cursor:pointer;",
      "  display:flex;align-items:center;justify-content:center;gap:8px;position:relative;",
      "  background:" + bg + ";color:" + fg + ";",
      "  border:" + (L && L.showBorder ? "2px solid " + L.borderColor : "0") + ";",
      "  box-shadow:" + shadow + ";",
      "  transition:transform .18s ease, box-shadow .18s ease;",
      "  font:600 14px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;",
      "}",
      ".ldr:hover{transform:translateY(-2px);box-shadow:" + (SHADOWS[3]) + ";}",
      ".ldr:active{transform:translateY(0);}",
      ".ldr:focus-visible{outline:3px solid " + bg + ";outline-offset:3px;}",
      ".ldr svg{width:" + Math.round(size * 0.46) + "px;height:" + Math.round(size * 0.46) + "px;",
      "  fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;flex:none;}",
      // A custom image is clipped to the launcher's own shape so it can
      // never spill outside the button.
      ".ldr img{width:" + size + "px;height:" + size + "px;border-radius:" + radius + "px;object-fit:cover;flex:none;}",
      ".ldr .lbl{white-space:nowrap;}",
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
      widget.welcome && widget.welcome.assistantName
        ? "Chat with " + widget.welcome.assistantName
        : "Open chat",
    );

    var iconUrl = L && L.icon === "custom" && L.iconUrl ? L.iconUrl : a.avatarUrl;
    launcher.innerHTML = iconUrl
      ? '<img src="' + escapeAttr(iconUrl) + '" alt="" />'
      : '<svg viewBox="0 0 24 24" aria-hidden="true">' +
        (ICONS[(L && L.icon) || a.launcherIcon] || ICONS.chat) +
        "</svg>";

    // A custom icon that fails to load must not leave an empty button.
    var iconImg = launcher.querySelector("img");
    if (iconImg) {
      iconImg.onerror = function () {
        launcher.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICONS.chat + "</svg>";
        launcher.appendChild(badge);
      };
    }

    if (showLabel) {
      var lbl = document.createElement("span");
      lbl.className = "lbl";
      lbl.textContent = L.label;
      launcher.appendChild(lbl);
    }

    badge.className = "bdg";
    badge.setAttribute("aria-hidden", "true");
    if (!L || L.showUnreadBadge) launcher.appendChild(badge);
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
      // Inherit the entry point's version token so the lazy half can never
      // be served from a different release than the bootstrap that asked
      // for it — the filenames carry no content hash.
      s.src = ASSETS + "/widget/gotcha-shopify-chat.js" + ASSET_VERSION_QS;
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
    // top of it steals a tap target and covers content. A merchant can
    // opt out if their layout wants the button to stay.
    var L = state.widget && state.widget.ux && state.widget.ux.launcher;
    var hide = L ? L.hideOnMobileWhenOpen : true;
    if (hide && window.matchMedia("(max-width: 560px)").matches) launcher.style.display = "none";
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
