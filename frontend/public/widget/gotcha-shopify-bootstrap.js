/**
 * GOTCHA Shopify Live Chat - bootstrap.
 *
 * This file is on the critical path of every storefront page, so it does
 * the minimum that has to happen there and nothing more:
 *
 *   1. read the page context the Liquid block published
 *   2. one POST to /bootstrap (branding + availability + session)
 *   3. draw the launcher inside a Shadow DOM host
 *   4. load the chat application ONLY when the shopper reaches for it
 *
 * The chat app - message list, product cards, carousel, cart flow - is a
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
  // Stamped by scripts/widget/build-widget.mjs. Content-hashed, so this
  // bootstrap can only ever load the exact bundle it was built against -
  // a hand-typed ?v= let four commits change the bundle without changing
  // its URL, and every cache kept serving the old one.
  var CHAT_BUNDLE = "gotcha-shopify-chat.64e2b254bed0.js";
  // The shared WhatsApp widget (the WhatsApp kind), stamped the same way.
  var SITE_BUNDLE = "gotcha-site.c4014158c402.js";

  // The App Proxy subpath on the MERCHANT's domain. Must match `subpath`
  // and `prefix` in shopify.app.toml, or the request 404s and every
  // shopper stays anonymous.
  var PROXY_PATH = "/apps/" + (cfg.proxySubpath || "gotcha-chat");

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
        /* private mode - the session simply won't survive a reload */
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
  // A stable hook for verification, for the same reason the close button
  // has one: matching on tag or class made an acceptance test click the
  // wrong control and report a pass.
  launcher.setAttribute("data-act", "launcher");
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

  // ── Design 7 ("GOTCHA Widgets on Store") ─────────────────────────
  //
  // The same bubble and pop-up the code snippet draws (gotcha-site.js):
  // a 56px bubble in the main colour with the brand's initial and the
  // online dot, 22px from the bottom and the chosen side; the pop-up says
  // who is writing, types, then shows the merchant's message. The legacy
  // launcher size, shape, shadow, label and custom icon are no longer read
  // (supervisor-approved, 2026-10-14).

  var WORDS = {
    en: { replies: "replies right away", close: "Close", open: "Open chat", minimise: "Minimise" },
    he: { replies: "עונה מיד", close: "סגירה", open: "פתיחת הצ׳אט", minimise: "מזעור" },
  };

  function langOf(widget) {
    var chosen = widget && widget.appearance && widget.appearance.language;
    if (chosen === "he" || chosen === "en") return chosen;
    return /^he/i.test(String(context.locale || document.documentElement.lang || "")) ? "he" : "en";
  }

  /** Mirrors inkOn() in gotcha-site.js and gotcha-shopify-chat.js. */
  function inkOn(hex) {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ""));
    if (!m) return "#FBF8F3";
    var lum = function (r, g, b) {
      var c = [r, g, b].map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    var l = lum(parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16));
    var cream = (lum(251, 248, 243) + 0.05) / (l + 0.05);
    var ink = (l + 0.05) / (lum(43, 38, 34) + 0.05);
    return cream >= ink ? "#FBF8F3" : "#2B2622";
  }

  /** The server's initial (widget.brand), else the name's first letter or digit. */
  function brandInitial(widget) {
    if (widget.brand && widget.brand.initial) return String(widget.brand.initial);
    var name = String((widget.brand && widget.brand.name) || (widget.welcome && widget.welcome.assistantName) || "");
    var letter = Array.from(name).filter(function (ch) { return /[\p{L}\p{N}]/u.test(ch); })[0] || "";
    return letter.toUpperCase();
  }

  var WA_GLYPH = '<svg viewBox="0 0 24 24" aria-hidden="true" style="fill:currentColor;stroke:none"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.2.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.1.6a2.7 2.7 0 0 0 1.8-1.3 2.2 2.2 0 0 0 .2-1.3c-.1-.1-.3-.2-.5-.3z"/></svg>';
  var CHEVRON = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

  var launcherFace = "";
  var showDot = false;
  var teaserTyped = false;
  var launcherSide = "right";

  /** The face, the dot and the badge: repainted whenever the chat opens or closes. */
  function paintFace() {
    launcher.innerHTML = state.open ? CHEVRON : launcherFace;
    if (showDot && !state.open) {
      var d = document.createElement("span");
      d.className = "on";
      d.setAttribute("aria-hidden", "true");
      launcher.appendChild(d);
    }
    launcher.appendChild(badge);
    paintBadge();
  }

  /** A reply the shopper has not seen, or the pop-up waiting for them (design 7's "1"). */
  function paintBadge() {
    var n = state.unread > 0 ? state.unread : teaserTyped && !state.open ? 1 : 0;
    badge.textContent = n > 9 ? "9+" : n > 0 ? String(n) : "";
    badge.setAttribute("data-show", n > 0 && !state.open ? "1" : "0");
  }

  function paintLauncher(widget) {
    var a = widget.appearance || {};
    var L = (widget.ux && widget.ux.launcher) || null;
    var mobile = window.matchMedia("(max-width: 560px)").matches;
    var wa = !!(widget.ux && widget.ux.look === "whatsapp");
    var side = (L ? (mobile ? L.mobilePosition : L.position) : a.launcherPosition) === "left" ? "left" : "right";
    var accent = a.primaryColor || (L && L.backgroundColor) || "#2B2622";
    var bg = wa ? "#25D366" : accent;
    var fg = wa ? "#fff" : inkOn(accent);
    launcherSide = side;
    showDot = !wa && state.availability !== "offline";

    host.style.setProperty(side, "22px");
    host.style.setProperty("bottom", "22px");
    host.style.setProperty(side === "left" ? "right" : "left", "auto");

    launcherStyle.textContent = [
      ":host { all: initial; }",
      ".ldr{position:relative;width:56px;height:56px;border-radius:50%;padding:0;border:0;cursor:pointer;",
      "  display:flex;align-items:center;justify-content:center;background:" + bg + ";color:" + fg + ";",
      "  box-shadow:0 1px 0 rgba(255,255,255,.12) inset,0 10px 28px rgba(43,38,34,.28);transition:transform .2s ease;}",
      ".ldr:hover{transform:translateY(-2px);}",
      ".ldr:focus-visible{outline:3px solid " + bg + ";outline-offset:3px;}",
      ".ldr svg{width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;flex:none;}",
      ".ldr .chev{width:22px;height:22px;}",
      ".ldr[data-busy='1']{cursor:progress;}",
      ".mark{font:500 24px/1 'Cormorant Garamond',Georgia,'Times New Roman',serif;color:inherit;}",
      ".on{position:absolute;top:3px;left:3px;width:11px;height:11px;border-radius:50%;box-sizing:border-box;",
      "  background:#5FA578;border:2px solid " + accent + ";}",
      ".on::after,.pav-on::after{content:'';position:absolute;inset:-2px;border-radius:50%;",
      "  background:rgba(80,190,100,.45);animation:pulse 1.8s ease-out infinite;pointer-events:none;}",
      "@keyframes pulse{0%{transform:scale(1);opacity:.9}70%{transform:scale(2.8);opacity:0}100%{transform:scale(2.8);opacity:0}}",
      ".bdg{position:absolute;top:-3px;right:-3px;min-width:20px;height:20px;box-sizing:border-box;border-radius:10px;",
      "  padding:0 5px;background:#C4552F;color:#fff;border:2px solid #FBF8F3;",
      "  font:700 11.5px/16px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;text-align:center;display:none;}",
      ".bdg[data-show='1']{display:block;}",
      // The pop-up, above the bubble on its side (the host sits 22px in).
      ".pop{position:absolute;bottom:68px;" + side + ":0;width:min(330px, calc(100vw - 44px));",
      "  font:400 14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;",
      "  color:#2B2622;animation:pin .35s cubic-bezier(.2,.75,.2,1);}",
      ".pop-c{position:relative;background:#fff;border-radius:" + (side === "right" ? "18px 18px 6px 18px" : "18px 18px 18px 6px") + ";",
      "  box-shadow:0 0 0 1px rgba(43,38,34,.07),0 20px 44px -12px rgba(43,38,34,.28);",
      "  padding:12px 12px 14px;display:flex;flex-direction:column;gap:10px;}",
      ".pop-c::after{content:'';position:absolute;" + side + ":20px;bottom:-7px;width:16px;height:16px;background:#fff;",
      "  transform:rotate(45deg);border-radius:" + (side === "right" ? "0 0 4px 0" : "0 0 0 4px") + ";box-shadow:1px 1px 0 rgba(43,38,34,.07);}",
      ".pop-h{display:flex;align-items:center;gap:10px;}",
      ".pav{position:relative;width:32px;height:32px;border-radius:50%;flex:none;background:" + accent + ";color:" + inkOn(accent) + ";",
      "  display:flex;align-items:center;justify-content:center;font:500 19px/1 'Cormorant Garamond',Georgia,'Times New Roman',serif;}",
      ".pav-on{position:absolute;bottom:-1px;left:-1px;width:10px;height:10px;box-sizing:border-box;border-radius:50%;",
      "  background:#5FA578;border:2px solid #fff;}",
      ".pop-n{flex:1;min-width:0;display:flex;flex-direction:column;align-items:flex-start;gap:1px;}",
      ".pop-nm{max-width:100%;font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
      ".pop-t{font-size:12px;color:#8A7A6C;}",
      ".pop-x{width:28px;height:28px;border-radius:8px;border:0;background:transparent;color:#8A7A6C;padding:0;",
      "  display:flex;align-items:center;justify-content:center;flex:none;cursor:pointer;}",
      ".pop-x:hover{background:#F3ECE2;}",
      ".pop-x svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;}",
      ".pop-x:focus-visible,.pop-m:focus-visible{outline:2px solid " + accent + ";outline-offset:2px;}",
      ".pop-ty{align-self:flex-start;margin-inline-start:42px;background:#F4EFE8;border-radius:16px;border-start-end-radius:4px;",
      "  padding:12px 14px;display:flex;align-items:center;gap:5px;}",
      ".pop-ty i{width:6px;height:6px;border-radius:50%;background:#A99C8E;animation:bounce 1.2s ease-in-out infinite;}",
      ".pop-ty i:nth-child(2){animation-delay:.15s}.pop-ty i:nth-child(3){animation-delay:.3s}",
      "@keyframes bounce{0%,60%,100%{transform:translateY(0);opacity:.45}30%{transform:translateY(-4px);opacity:1}}",
      ".pop-m{align-self:stretch;margin-inline-start:42px;border:0;text-align:start;background:#F4EFE8;",
      "  border-radius:16px;border-start-end-radius:4px;padding:10px 13px;font:inherit;font-size:14.5px;line-height:1.5;color:#2B2622;",
      "  cursor:pointer;animation:pin .25s ease;}",
      "@keyframes pin{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}",
      "@media (prefers-reduced-motion: reduce){.ldr,.pop,.pop-m{transition:none;animation:none}.ldr:hover{transform:none}",
      "  .on::after,.pav-on::after{animation:none;opacity:0}.pop-ty i{animation:none;opacity:.6}}",
      "@media (forced-colors: active){.ldr{border:1px solid ButtonText;}}",
    ].join("\n");

    launcher.className = "ldr";
    launcher.type = "button";
    launcher.setAttribute("aria-haspopup", "dialog");
    launcher.setAttribute("aria-expanded", "false");
    launcher.setAttribute("aria-label", (widget.welcome && widget.welcome.assistantName) || WORDS[langOf(widget)].open);
    if (wa) {
      launcherFace = WA_GLYPH;
    } else {
      var initial = brandInitial(widget);
      launcherFace = initial
        ? '<span class="mark" dir="ltr" aria-hidden="true">' + escapeAttr(initial) + "</span>"
        : '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICONS.chat + "</svg>";
    }
    badge.className = "bdg";
    badge.setAttribute("aria-hidden", "true");
    // "9+" is a count, not prose: it stays left to right.
    badge.setAttribute("dir", "ltr");
    paintFace();
  }

  /**
   * Safe, read-only view of widget state for debugging a live storefront.
   *
   * Exposed always because a widget that misbehaves does so in
   * production, on a merchant's store, where a build flag helps nobody.
   * It carries no tenant id, no channel id, no session token, no message
   * content and no AI configuration - only what somebody staring at a
   * stuck widget needs.
   */
  window.__GOTCHA_CHAT_DEBUG__ = function () {
    var info = {
      bootstrapBundle: CHAT_BUNDLE,
      bootstrapSrc: (document.currentScript && document.currentScript.src) || "(async)",
      instances: document.querySelectorAll("#gotcha-chat-root").length,
      open: !!state.open,
      closedByVisitor: closedByVisitor(),
      teaserVisible: !!teaserEl,
      teaserTimerActive: !!teaserTimer,
      unread: state.unread || 0,
      userInteracted: userInteracted,
      visitorMuted: visitorMuted(),
      availability: state.availability || null,
      appLoaded: !!app,
    };
    try { if (app && app.debugState) info.app = app.debugState(); } catch (e) { info.app = "unavailable"; }
    return info;
  };

  // ── Proactive teaser ─────────────────────────────────────────
  //
  // Every rule below is a reason NOT to interrupt somebody, which is why
  // they are all checked before any reason to. The defaults are off, and
  // when a merchant turns it on it is a teaser they can ignore rather
  // than a panel that takes over their screen.
  //
  // Mirrors shouldShowTeaser() in @chatcenter/shared - same reason as the
  // sound rules: no bundler here, so the logic is duplicated on purpose
  // and tested on both sides.

  // Set the moment the shopper clicks X, and never cleared for the life
  // of this page view. The launcher can still reopen - that is the
  // shopper asking - but nothing automatic may.
  var visitorClosed = false;
  function closedByVisitor() {
    if (visitorClosed) return true;
    // The app owns the authoritative flag once it is loaded.
    try { return !!(app && app.closedByVisitor && app.closedByVisitor()); } catch (e) { return false; }
  }

  var teaserEl = null;
  var teaserTimer = null;
  var teaserShown = false;

  function pStore(key, fallback) {
    try { var v = window.localStorage.getItem("gotcha_sfy_p_" + key); return v === null ? fallback : v; }
    catch (e) { return fallback; }
  }
  function pSet(key, value) {
    try { window.localStorage.setItem("gotcha_sfy_p_" + key, String(value)); } catch (e) {}
  }
  function sStore(key, fallback) {
    try { var v = window.sessionStorage.getItem("gotcha_sfy_p_" + key); return v === null ? fallback : v; }
    catch (e) { return fallback; }
  }
  function sSet(key, value) {
    try { window.sessionStorage.setItem("gotcha_sfy_p_" + key, String(value)); } catch (e) {}
  }

  function teaserAllowed(cfg) {
    if (!cfg || !cfg.enabled) return false;
    if (state.open) return false;
    // A shopper who closed the panel has answered the question the teaser
    // exists to ask. Nothing auto-opens or re-offers for this page view.
    if (closedByVisitor()) return false;
    // Somebody already talking to us is not somebody to interrupt.
    if (state.store.get("conversation")) return false;
    var mobile = window.matchMedia("(max-width: 560px)").matches;
    if (mobile ? !cfg.mobileEnabled : !cfg.desktopEnabled) return false;
    if (cfg.respectBusinessHours && state.availability === "offline") return false;
    if (Number(sStore("session", 0)) >= cfg.maxPerSession) return false;
    if (Number(pStore("ever", 0)) >= cfg.maxPerVisitor) return false;

    var visits = Number(pStore("visits", 0));
    if (cfg.firstVisitOnly && visits > 1) return false;
    if (cfg.returningVisitorOnly && visits <= 1) return false;

    var dismissed = Number(pStore("dismissed", 0));
    if (dismissed && Date.now() - dismissed < cfg.cooldownHours * 3600000) return false;

    var path = location.pathname || "/";
    for (var i = 0; i < cfg.excludeUrls.length; i++) if (path.indexOf(cfg.excludeUrls[i]) === 0) return false;
    if (cfg.includeUrls.length) {
      var included = false;
      for (var j = 0; j < cfg.includeUrls.length; j++) if (path.indexOf(cfg.includeUrls[j]) === 0) included = true;
      if (!included) return false;
    }
    if (cfg.minPageViews > 1 && visits < cfg.minPageViews) return false;
    return true;
  }

  function showTeaser(cfg) {
    if (teaserShown || !teaserAllowed(cfg)) return;
    teaserShown = true;
    sSet("session", Number(sStore("session", 0)) + 1);
    pSet("ever", Number(pStore("ever", 0)) + 1);

    if (cfg.autoOpen) { openChat(); return; }

    // Design 7's pop-up: who is writing, a moment of typing, then the
    // merchant's message, which opens the chat. The legacy title and action
    // button are not drawn: Settings writes neither.
    var widget = state.widget;
    var W = WORDS[langOf(widget)];
    var online = state.availability !== "offline";
    teaserEl = document.createElement("div");
    teaserEl.className = "pop";
    teaserEl.setAttribute("data-act", "popup");
    teaserEl.setAttribute("dir", langOf(widget) === "he" ? "rtl" : "ltr");
    var card = document.createElement("div");
    card.className = "pop-c";
    var head = document.createElement("div");
    head.className = "pop-h";
    var av = document.createElement("span");
    av.className = "pav";
    av.setAttribute("aria-hidden", "true");
    av.textContent = brandInitial(widget);
    if (online) {
      var dot = document.createElement("span");
      dot.className = "pav-on";
      av.appendChild(dot);
    }
    var names = document.createElement("span");
    names.className = "pop-n";
    var nm = document.createElement("bdi");
    nm.className = "pop-nm";
    nm.textContent = (widget.welcome && widget.welcome.assistantName) || (widget.brand && widget.brand.name) || "";
    names.appendChild(nm);
    if (online) {
      var when = document.createElement("span");
      when.className = "pop-t";
      when.textContent = W.replies;
      names.appendChild(when);
    }
    var dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "pop-x";
    dismiss.setAttribute("aria-label", W.close);
    dismiss.setAttribute("data-act", "popup-close");
    dismiss.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    dismiss.addEventListener("click", function () {
      // A dismissal is a decision, and it is remembered for the cooldown.
      pSet("dismissed", Date.now());
      hideTeaser();
    });
    head.appendChild(av);
    head.appendChild(names);
    head.appendChild(dismiss);
    card.appendChild(head);
    var typing = document.createElement("div");
    typing.className = "pop-ty";
    typing.setAttribute("aria-hidden", "true");
    typing.innerHTML = "<i></i><i></i><i></i>";
    card.appendChild(typing);
    teaserEl.appendChild(card);
    teaserEl.setAttribute("role", "status");
    shadow.appendChild(teaserEl);
    var shown = teaserEl;
    var still = false;
    try { still = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}
    setTimeout(function () {
      if (teaserEl !== shown) return;
      if (typing.parentNode) typing.parentNode.removeChild(typing);
      var msg = document.createElement("button");
      msg.type = "button";
      msg.className = "pop-m";
      msg.setAttribute("data-act", "popup-open");
      var text = document.createElement("bdi");
      text.textContent = cfg.message;
      msg.appendChild(text);
      msg.addEventListener("click", function () { hideTeaser(); openChat(); });
      card.appendChild(msg);
      teaserTyped = true;
      paintBadge();
    }, still ? 0 : 1500);

    if (cfg.playSound) state.playSound("proactive");
  }

  function hideTeaser() {
    if (teaserEl && teaserEl.parentNode) teaserEl.parentNode.removeChild(teaserEl);
    teaserEl = null;
    teaserTyped = false;
    paintBadge();
  }

  function armTeaser(widget) {
    var cfg = widget && widget.ux && widget.ux.proactive;
    if (!cfg || !cfg.enabled) return;

    pSet("visits", Number(pStore("visits", 0)) + 1);
    var mobile = window.matchMedia("(max-width: 560px)").matches;
    var delay = (mobile ? cfg.mobileDelaySeconds : cfg.delaySeconds) * 1000;

    if (cfg.trigger === "scroll_depth") {
      var onScroll = function () {
        var h = document.documentElement;
        var pct = ((h.scrollTop || document.body.scrollTop) / ((h.scrollHeight || 1) - h.clientHeight)) * 100;
        if (pct >= cfg.scrollPercent) {
          window.removeEventListener("scroll", onScroll);
          showTeaser(cfg);
        }
      };
      window.addEventListener("scroll", onScroll, { passive: true });
      return;
    }
    if (cfg.trigger === "exit_intent") {
      if (mobile) return; // there is no pointer to leave the viewport
      var onLeave = function (e) {
        if (e.clientY <= 0) { document.removeEventListener("mouseout", onLeave); showTeaser(cfg); }
      };
      document.addEventListener("mouseout", onLeave);
      return;
    }
    if (cfg.trigger === "custom_event") {
      window.addEventListener(cfg.customEvent, function () { showTeaser(cfg); }, { once: true });
      return;
    }
    if (cfg.trigger === "product_page" && state.context.pageType !== "product") return;
    if (cfg.trigger === "cart_page" && state.context.pageType !== "cart") return;

    if (cfg.trigger === "page_views") {
      // Depth of visit, not time on one page. A shopper who has looked at
      // several pages is browsing; one who just landed is not.
      if (Number(pStore("visits", 0)) < cfg.minPageViews) return;
    }

    if (cfg.trigger === "repeat_product_views") {
      // The signal is comparison shopping: the same product returned to,
      // or several products looked at in one session.
      if (state.context.pageType !== "product" || !state.context.productHandle) return;
      var seen = [];
      try { seen = JSON.parse(pStore("seenProducts", "[]")) || []; } catch (e) { seen = []; }
      var handle = String(state.context.productHandle);
      var repeat = seen.indexOf(handle) !== -1;
      if (!repeat) seen.push(handle);
      // Bounded: this lives in storage on a shopper's device.
      if (seen.length > 20) seen = seen.slice(-20);
      pSet("seenProducts", JSON.stringify(seen));
      if (!repeat && seen.length < cfg.minPageViews) return;
    }

    if (cfg.trigger === "inactivity") {
      // Fires only after the shopper has gone QUIET for the delay, and
      // the clock restarts every time they do something. Someone reading
      // a page is not stuck; someone who has stopped moving might be.
      var idle = null;
      var restart = function () {
        if (idle) clearTimeout(idle);
        idle = setTimeout(function () { stopWatching(); showTeaser(cfg); }, delay);
      };
      var events = ["pointermove", "pointerdown", "keydown", "scroll", "touchstart"];
      var stopWatching = function () {
        if (idle) clearTimeout(idle);
        for (var i = 0; i < events.length; i++) window.removeEventListener(events[i], restart);
      };
      for (var k = 0; k < events.length; k++) window.addEventListener(events[k], restart, { passive: true });
      restart();
      teaserTimer = null;
      return;
    }

    // time_on_page and the page-type triggers: wait, then offer.
    teaserTimer = setTimeout(function () { showTeaser(cfg); }, delay);
  }

  // ── Sound ────────────────────────────────────────────────────
  //
  // Synthesised, not downloaded. Two short tones from an oscillator cost
  // nothing to ship, cannot fail to load, need no CSP allowance and
  // involve no third-party host - and a notification chime is a beep, so
  // there is nothing a sample file would buy us.
  //
  // Browsers refuse audio until a real gesture, so the context is created
  // lazily on the first one and every call before that is dropped rather
  // than logging an error on the merchant's storefront.
  var audioCtx = null;
  var userInteracted = false;

  function markInteracted() {
    if (userInteracted) return;
    userInteracted = true;
    // Resume a context that was created suspended (Safari, Chrome).
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(function () {});
  }
  ["pointerdown", "keydown", "touchstart"].forEach(function (evt) {
    window.addEventListener(evt, markInteracted, { once: true, passive: true, capture: true });
  });

  var TONES = {
    subtle: { outgoing: [520, 0.06], incoming_ai: [660, 0.09], incoming_human: [740, 0.09], proactive: [600, 0.10], handoff: [820, 0.10], error: [300, 0.12] },
    classic: { outgoing: [660, 0.07], incoming_ai: [880, 0.11], incoming_human: [990, 0.11], proactive: [780, 0.12], handoff: [1040, 0.12], error: [260, 0.14] },
  };

  function visitorMuted() {
    try { return window.localStorage.getItem("gotcha_sfy_muted") === "1"; } catch (e) { return false; }
  }
  state.visitorMuted = visitorMuted;
  state.setVisitorMuted = function (muted) {
    try { window.localStorage.setItem("gotcha_sfy_muted", muted ? "1" : "0"); } catch (e) {}
  };

  /**
   * Play one short tone for an event, if every rule says yes.
   *
   * Mirrors shouldPlaySound() in @chatcenter/shared, which is the source
   * of truth for the server and the settings preview. The widget ships
   * without a bundler so it cannot import it; the rules are duplicated
   * deliberately and tested on both sides.
   */
  state.playSound = function (event, opts) {
    opts = opts || {};
    var cfg = state.widget && state.widget.ux && state.widget.ux.sounds;
    if (!cfg || !cfg.enabled) return false;
    if (visitorMuted()) return false;
    if (!userInteracted) return false;
    if (opts.fromHistory) return false;
    if (event === "outgoing" && opts.sendFailed) return false;

    var per = {
      outgoing: cfg.outgoing, incoming_ai: cfg.incomingAi, incoming_human: cfg.incomingHuman,
      proactive: cfg.proactive, handoff: cfg.handoff, error: cfg.error,
    };
    if (!per[event]) return false;

    var incoming = event === "incoming_ai" || event === "incoming_human" || event === "handoff";
    if (incoming && !state.open && !cfg.playWhenClosed) return false;
    if (!document.hidden && !cfg.playWhenTabActive) return false;

    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return false;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === "suspended") audioCtx.resume().catch(function () {});
      var pack = TONES[cfg.pack] || TONES.subtle;
      var spec = pack[event] || pack.incoming_ai;
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = spec[0];
      // Never looped, always short, and eased out so it does not click.
      var vol = Math.max(0, Math.min(1, (cfg.volume || 0) / 100)) * 0.25;
      gain.gain.setValueAtTime(0, audioCtx.currentTime);
      gain.gain.linearRampToValueAtTime(vol, audioCtx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + spec[1]);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + spec[1] + 0.02);
      return true;
    } catch (e) {
      return false;
    }
  };

  function escapeAttr(v) {
    return String(v).replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  state.setUnread = function (n) {
    state.unread = n;
    paintBadge();
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
      s.src = ASSETS + "/widget/" + CHAT_BUNDLE;
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
    visitorClosed = true;
    hideTeaser();
    if (teaserTimer) { clearTimeout(teaserTimer); teaserTimer = null; }
    launcher.setAttribute("aria-expanded", "false");
    launcher.style.display = "";
    paintFace();
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
    // Open, the bubble minimises the chat (design 7's chevron).
    state.open = true;
    paintFace();
  };
  // Docked (design 7): the panel is the chat's place; the bubble and the
  // pop-up step aside until it is undocked.
  state.onDock = function (docked) {
    if (docked) hideTeaser();
    launcher.style.display = docked ? "none" : "";
  };

  launcher.addEventListener("click", function () {
    if (state.open) {
      if (app && typeof app.close === "function") app.close();
      return;
    }
    // Opening the chat answers the teaser's question; leaving it up
    // would talk over the panel the shopper just asked for.
    hideTeaser();
    if (teaserTimer) { clearTimeout(teaserTimer); teaserTimer = null; }
    openChat();
  });

  // ── Go ──────────────────────────────────────────────────────────

  /**
   * Ask Shopify who is chatting, through the App Proxy.
   *
   * This goes to the MERCHANT's own origin, not ours - same-origin, no
   * CORS, no cookies of ours involved. Shopify then calls us with a
   * signature only it can produce, which is the whole reason the answer
   * can be believed. Liquid's `customer.id` reaches us through this same
   * browser and so proves nothing.
   *
   * Everything about this is best-effort. A merchant who has not set up
   * the proxy, an older theme, a network blip: all resolve to "we do not
   * know who this is", and the widget carries on anonymously. Identity is
   * a bonus, never a prerequisite for chatting.
   */
  function fetchIdentity() {
    if (!window.fetch) return Promise.resolve(null);
    return new Promise(function (resolve) {
      // Never let this hold up the widget. A proxy that hangs must cost
      // the shopper nothing.
      var settled = false;
      var done = function (v) { if (!settled) { settled = true; resolve(v); } };
      setTimeout(function () { done(null); }, 2500);

      window
        .fetch(PROXY_PATH + "/identity", {
          method: "GET",
          credentials: "same-origin",
          headers: { accept: "application/json" },
        })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (body) {
          var data = body && body.data;
          done(data && data.identified && data.identityToken ? data.identityToken : null);
        })
        .catch(function () { done(null); });
    });
  }

  function start() {
    var existingToken = store.get("session");
    fetchIdentity().then(function (identityToken) {
    post("/api/shopify-chat/bootstrap", {
      shopDomain: cfg.shopDomain || undefined,
      publicKey: cfg.channelKey || undefined,
      context: context,
      themeId: context.themeId ? String(context.themeId) : null,
      sessionToken: existingToken || undefined,
      identityToken: identityToken || undefined,
    })
      .then(function (res) {
        var data = res.data || {};
        state.session = data.session && data.session.token;
        state.widget = data.widget;
        state.availability = data.availability || "online";
        if (!state.session || !state.widget) return;
        store.set("session", state.session);

        // The WhatsApp kind: WhatsApp's panel, shared with the code snippet
        // (gotcha-site.js) - no chat on the storefront.
        if (state.widget.ux && state.widget.ux.kind === "whatsapp") {
          mountWhatsapp(state.widget);
          return;
        }

        paintLauncher(state.widget);
        shadow.appendChild(launcherStyle);
        shadow.appendChild(launcher);
        document.body.appendChild(host);
        armTeaser(state.widget);

        // Open-on-load is a merchant preference, not an override of a
        // shopper's decision: if they already closed it on this page
        // view, it stays closed.
        var behavior = state.widget.ux && state.widget.ux.behavior;
        if (behavior && behavior.openOnLoad && !closedByVisitor()) openChat();

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
        // Every refusal - disabled channel, wrong origin, plan without
        // the feature - looks identical here on purpose. The storefront
        // simply renders no widget.
        if (err && err.status !== 403) {
          console.warn("[gotcha-chat] bootstrap failed:", err.message);
        }
      });
    });
  }

  function mountWhatsapp(widget) {
    document.body.appendChild(host);
    var s = document.createElement("script");
    s.src = ASSETS + "/widget/" + SITE_BUNDLE;
    s.async = true;
    s.crossOrigin = "anonymous";
    s.onload = function () {
      if (typeof window.__gotchaWhatsappWidget !== "function") return;
      window.__gotchaWhatsappWidget({
        host: host,
        shadow: shadow,
        widget: widget,
        lang: langOf(widget),
        initial: brandInitial(widget),
        assets: ASSETS,
        session: function (k, v) {
          if (v === undefined) return sStore(k, null);
          sSet(k, v);
          return null;
        },
        start: function (text, lang) {
          return post("/api/shopify-chat/whatsapp-start", {
            text: text || undefined,
            locale: lang,
            context: {
              pageType: context.pageType || "other",
              productHandle: context.productHandle || null,
              path: window.location.pathname,
            },
          }, state.session).then(function (res) { return res && res.data && res.data.url; });
        },
      });
    };
    document.head.appendChild(s);
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
