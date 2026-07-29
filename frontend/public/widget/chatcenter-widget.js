/**
 * GOTCHA website chat — the script a tenant pastes onto their own site.
 *
 * The filename and the `window.__chatcenter` contract are load-bearing:
 * snippets are already pasted on customer sites and on gotcha.co.il
 * itself, and none of them can be edited from here. Everything below is
 * free to change; those two are not.
 *
 * This used to be a self-contained widget — its own markup, its own CSS,
 * its own idea of what a chat looks like. It had drifted a long way from
 * the storefront widget, so a tenant configuring both learned two editors
 * and got two products. It now loads the SAME bundle the Shopify
 * storefront runs, and adapts this channel's API to it.
 *
 * Two jobs, then:
 *
 *   1. Ask the server whether this widget still exists, BEFORE drawing
 *      anything. The old script painted its launcher unconditionally and
 *      only called the server when a visitor opened it — so a deleted
 *      channel left a button on a customer's site that opened onto
 *      silence. Asking first means a deleted widget simply is not there.
 *
 *   2. Translate. The bundle speaks the storefront's API shape; this
 *      channel speaks /init, /message, /messages/:id. The adapter is the
 *      right place for that difference, because it keeps the bundle free
 *      of any knowledge about which channel it is serving.
 */
(function () {
  "use strict";

  var cfg = window.__chatcenter || {};
  var API = String(cfg.apiUrl || "").replace(/\/+$/, "");
  var WIDGET_ID = String(cfg.widgetId || "");

  if (!WIDGET_ID) return;
  if (window.__gotchaWebchatLoaded) return;
  window.__gotchaWebchatLoaded = true;

  var API_PATH = "/api/embedded-chat";
  var STORAGE_PREFIX = "cc_" + WIDGET_ID.slice(-12);

  // ── First-party storage only. No cookies, so nothing here is affected
  //    by third-party cookie blocking or a visitor's tracking settings.
  var store = {
    get: function (k) {
      try { return window.localStorage.getItem(STORAGE_PREFIX + "_" + k); } catch (e) { return null; }
    },
    set: function (k, v) {
      try { window.localStorage.setItem(STORAGE_PREFIX + "_" + k, v); } catch (e) {}
    },
    del: function (k) {
      try { window.localStorage.removeItem(STORAGE_PREFIX + "_" + k); } catch (e) {}
    },
  };

  function request(path, options) {
    return fetch(API + path, options).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) {
        if (!res.ok) {
          var err = new Error(json.error || "request_failed");
          err.status = res.status;
          throw err;
        }
        return json;
      });
    });
  }

  function post(path, body) {
    return request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      credentials: "omit",
    });
  }

  // ── The adapter ──────────────────────────────────────────────
  //
  // The bundle asks for the storefront's endpoints. This maps them onto
  // the ones this channel actually has. Anything the website widget has
  // no equivalent for resolves quietly rather than erroring: a missing
  // analytics endpoint must never break a conversation.

  function visitorId() {
    var existing = store.get("visitor");
    if (existing) return existing;
    var minted = "v_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    store.set("visitor", minted);
    return minted;
  }

  function normalizeMessages(raw) {
    return (raw || []).map(function (m) {
      return {
        id: m.id,
        direction: m.direction,
        body: m.body,
        messageType: m.messageType || "text",
        author: m.author || m.senderDisplayName || null,
        authorKind: m.direction === "INBOUND" ? "visitor" : m.authorKind || "ai",
        createdAt: m.createdAt || m.timestamp || new Date().toISOString(),
        commerce: null,
      };
    });
  }

  function loadMessages(conversationId) {
    return request(API_PATH + "/messages/" + encodeURIComponent(conversationId), {
      credentials: "omit",
    })
      .then(function (res) {
        var d = res.data || res;
        return normalizeMessages(d.messages || d);
      })
      .catch(function () { return []; });
  }

  function adapterPost(fullPath, body) {
    var path = fullPath.indexOf(API_PATH) === 0 ? fullPath.slice(API_PATH.length) : fullPath;

    if (path === "/conversation") {
      // The bundle's "open or resume"; this channel calls it /init.
      return post(API_PATH + "/init", {
        widgetId: WIDGET_ID,
        visitorId: visitorId(),
        sessionId: store.get("conversation") || undefined,
        pageUrl: window.location.href,
      }).then(function (res) {
        var d = (res && res.data) || {};
        if (!d.sessionId) throw new Error("unavailable");
        store.set("conversation", d.sessionId);
        // The bundle treats `session` as "we are ready to talk"; on this
        // channel the conversation id IS that token.
        store.set("session", d.sessionId);
        return loadMessages(d.sessionId).then(function (messages) {
          return {
            data: {
              conversationId: d.sessionId,
              status: "OPEN",
              isHandedOver: false,
              messages: messages,
            },
          };
        });
      });
    }

    if (path === "/message") {
      return post(API_PATH + "/message", {
        sessionId: store.get("conversation"),
        visitorId: visitorId(),
        body: body && body.body,
      });
    }

    // /events, /handoff, /lead and the cart endpoints have no equivalent
    // here. Resolving empty keeps the bundle's optional paths working
    // without inventing server behaviour that does not exist.
    return Promise.resolve({ data: {} });
  }

  function adapterGet(fullPath) {
    var path = fullPath.indexOf(API_PATH) === 0 ? fullPath.slice(API_PATH.length) : fullPath;
    var conversationId = store.get("conversation");
    if (path.indexOf("/messages") !== 0 || !conversationId) {
      return Promise.resolve({ data: { messages: [] } });
    }
    return loadMessages(conversationId).then(function (messages) {
      return { data: { conversationId: conversationId, isHandedOver: false, messages: messages } };
    });
  }

  // ── Boot ─────────────────────────────────────────────────────

  var host = null;
  var shadow = null;
  var app = null;

  function loadBundle() {
    // The bundle's filename is content-hashed, so it is read from the
    // manifest rather than hard-coded — a hard-coded name is how a stale
    // widget once stayed in browsers for hours.
    return request("/widget/widget-manifest.json", { credentials: "omit" })
      .then(function (manifest) {
        return new Promise(function (resolve, reject) {
          if (window.__gotchaShopifyChatApp) return resolve();
          var s = document.createElement("script");
          s.src = API + "/widget/" + manifest.chat;
          s.async = true;
          s.onload = resolve;
          s.onerror = function () { reject(new Error("bundle_failed")); };
          document.head.appendChild(s);
        });
      });
  }

  function mount(bootstrap) {
    host = document.createElement("div");
    host.id = "gotcha-chat-root";
    host.style.cssText = "position:fixed;z-index:2147483000;bottom:0;right:0;";
    document.body.appendChild(host);
    shadow = host.attachShadow({ mode: "open" });

    app = window.__gotchaShopifyChatApp({
      api: API,
      assets: API,
      apiPath: API_PATH,
      context: { pageType: "page", productHandle: null, locale: document.documentElement.lang || "en" },
      availability: bootstrap.availability || "online",
      store: store,
      post: adapterPost,
      get: adapterGet,
      shadow: shadow,
      setUnread: function () {},
      onOpened: function () {},
      onClosed: function () {},
      widget: bootstrap.widget,
    });

    paintLauncher(bootstrap.widget);
  }

  /**
   * The launcher, drawn from the same config the storefront launcher uses
   * so the two are the same control with the same settings behind them.
   */
  function paintLauncher(widget) {
    var L = (widget.ux && widget.ux.launcher) || {};
    var appearance = widget.appearance || {};
    var mobile = window.matchMedia("(max-width: 560px)").matches;
    var size = mobile ? Math.max(40, (L.size || 48) - 4) : L.size || 48;
    var side = (mobile ? L.mobilePosition : L.position) === "left" ? "left" : "right";
    var offSide = L.offsetSide == null ? 18 : L.offsetSide;
    var offBottom = (mobile ? L.mobileOffsetBottom : L.offsetBottom) || 18;
    var radius = L.shape === "rounded" ? 16 : Math.round(size / 2);
    var showLabel = !!(L.showLabel && L.label);
    var SHADOWS = [
      "none",
      "0 1px 4px rgba(15,23,42,.10)",
      "0 4px 16px rgba(15,23,42,.16),0 1px 3px rgba(15,23,42,.10)",
      "0 10px 30px rgba(15,23,42,.24),0 3px 8px rgba(15,23,42,.14)",
    ];

    host.style.setProperty(side, offSide + "px");
    host.style.setProperty("bottom", offBottom + "px");
    host.style.setProperty(side === "left" ? "right" : "left", "auto");

    var style = document.createElement("style");
    style.textContent = [
      ".ldr{min-width:" + size + "px;width:" + (showLabel ? "auto" : size + "px") + ";height:" + size + "px;",
      "  padding:" + (showLabel ? "0 " + Math.round(size / 4.5) + "px" : "0") + ";border-radius:" + radius + "px;",
      "  cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;border:0;",
      "  background:" + (L.backgroundColor || appearance.primaryColor || "#7c3aed") + ";",
      "  color:" + (L.iconColor || appearance.contrastColor || "#fff") + ";",
      "  box-shadow:" + (SHADOWS[L.shadow == null ? 2 : L.shadow] || SHADOWS[2]) + ";",
      "  font:600 13px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;letter-spacing:-.005em;",
      "  transition:transform .18s ease, box-shadow .18s ease;}",
      ".ldr:hover{transform:translateY(-1px);box-shadow:" + SHADOWS[3] + ";}",
      ".ldr:focus-visible{outline:3px solid " + (L.backgroundColor || "#7c3aed") + ";outline-offset:3px;}",
      ".ldr svg{width:" + Math.round(size * 0.42) + "px;height:" + Math.round(size * 0.42) + "px;",
      "  fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;flex:none;}",
      "@media (prefers-reduced-motion: reduce){.ldr{transition:none}}",
    ].join("\n");

    var button = document.createElement("button");
    button.className = "ldr";
    button.type = "button";
    button.setAttribute("data-act", "launcher");
    button.setAttribute("aria-label", (widget.welcome && widget.welcome.assistantName) || "Chat");
    button.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3c5 0 9 3.36 9 7.5S17 18 12 18a10.7 10.7 0 0 1-3-.42L5 19l1.2-3.2A7.9 7.9 0 0 1 3 10.5C3 6.36 7 3 12 3z"/></svg>' +
      (showLabel ? "<span>" + String(L.label).replace(/[<>]/g, "") + "</span>" : "");
    button.addEventListener("click", function () { if (app) app.open(); });

    shadow.appendChild(style);
    shadow.appendChild(button);
  }

  function start() {
    // Ask BEFORE drawing. A widget that no longer exists draws nothing at
    // all, rather than a button that opens onto silence.
    post(API_PATH + "/bootstrap", { widgetId: WIDGET_ID })
      .then(function (res) {
        var data = (res && res.data) || {};
        if (!data.widget) return;
        return loadBundle().then(function () {
          if (typeof window.__gotchaShopifyChatApp !== "function") return;
          mount(data);
        });
      })
      .catch(function (err) {
        // A removed widget is not an error: the server answers 200 with an
        // empty body and the branch above simply returns. This is for the
        // genuinely exceptional — the network is down, or we are broken —
        // and even then it stays a warning on someone else's website.
        if (err && err.status !== 404) {
          console.warn("[gotcha-chat] unavailable:", err.message);
        }
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
