/**
 * GOTCHA website chat - the script a tenant pastes onto their own site.
 *
 * The filename and the `window.__chatcenter` contract are load-bearing:
 * snippets are already pasted on customer sites and on gotcha.co.il
 * itself, and none of them can be edited from here. Everything below is
 * free to change; those two are not.
 *
 * This used to be a self-contained widget - its own markup, its own CSS,
 * its own idea of what a chat looks like. It had drifted a long way from
 * the storefront widget, so a tenant configuring both learned two editors
 * and got two products. It now loads the SAME bundle the Shopify
 * storefront runs, and adapts this channel's API to it.
 *
 * Two jobs, then:
 *
 *   1. Ask the server whether this widget still exists, BEFORE drawing
 *      anything. The old script painted its launcher unconditionally and
 *      only called the server when a visitor opened it - so a deleted
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

  // The visitor's proof that the conversation is theirs (from /init): the
  // server answers nothing for a conversation id alone.
  function loadMessages(conversationId) {
    var token = store.get("token") || "";
    return request(API_PATH + "/messages/" + encodeURIComponent(conversationId) + "?token=" + encodeURIComponent(token), {
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
        // Resume with the visitor's session token (the conversation id alone
        // never matched, so every page load used to start a new conversation).
        sessionToken: store.get("token") || undefined,
        pageUrl: window.location.href,
      }).then(function (res) {
        var d = (res && res.data) || {};
        if (!d.sessionId) throw new Error("unavailable");
        store.set("conversation", d.sessionId);
        if (d.sessionToken) store.set("token", d.sessionToken);
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
        sessionToken: store.get("token"),
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
  var launcherButton = null;
  var launcherIcon = "";
  var launcherOpen = false;
  var startData = null;

  function setLauncherOpen(open) {
    launcherOpen = open;
    if (!launcherButton) return;
    var phone = window.matchMedia("(max-width: 560px)").matches;
    launcherButton.style.display = open && phone ? "none" : "";
    // Open, the bubble minimises the chat (design 7's chevron).
    launcherButton.innerHTML = open ? CHEVRON : launcherIcon;
    launcherButton.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) hidePopup();
    decorateLauncher();
  }

  function loadBundle() {
    // The bundle's filename is content-hashed, so it is read from the
    // manifest rather than hard-coded - a hard-coded name is how a stale
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
      setUnread: function (n) { unreadCount = Number(n) || 0; paintBadge(); },
      // An open panel turns the launcher into its close (as in the design);
      // on a phone the panel fills the screen and has its own close, so the
      // launcher steps aside instead of sitting on the composer.
      onOpened: function () { setLauncherOpen(true); },
      onClosed: function () { setLauncherOpen(false); },
      widget: bootstrap.widget,
      // The socket instead of polling: this channel's visitor proves itself
      // with the session token from /init, and its pushed messages get the
      // same shape as polled ones.
      socketAuth: function () {
        return { webchatToken: store.get("token") || "", conversationId: store.get("conversation") || "" };
      },
      normalize: normalizeMessages,
      // "Continue on WhatsApp": the link (with the code) for this visitor's
      // conversation; `text` is the WhatsApp look's message to carry over.
      whatsappHandoff: function (opts) {
        return post(API_PATH + "/whatsapp-handoff", {
          sessionId: store.get("conversation"),
          sessionToken: store.get("token"),
          locale: opts && opts.locale,
          text: opts && opts.text,
        }).then(function (res) { return (res && res.data) || {}; });
      },
    });

    paintLauncher(bootstrap.widget);
  }

  // ── Language (the bundle's rule: the merchant's choice, else the page's) ──
  function langOf(widget) {
    var chosen = widget.appearance && widget.appearance.language;
    if (chosen === "he" || chosen === "en") return chosen;
    return /^he/i.test(String(document.documentElement.lang || "")) ? "he" : "en";
  }

  var WORDS = {
    en: {
      replies: "replies right away", close: "Close", resume: "Pick up where we left off?",
      deal: "Active deal", percentOff: "{n}% off", code: "Coupon code {code}", until: "valid until {date}", nextDeal: "Next deal",
    },
    he: {
      replies: "עונה מיד", close: "סגירה", resume: "רוצים להמשיך מאיפה שעצרנו?",
      deal: "מבצע פעיל", percentOff: "{n}% הנחה", code: "קוד קופון {code}", until: "בתוקף עד {date}", nextDeal: "המבצע הבא",
    },
  };

  /**
   * The business's name as a brand: the part before a tagline separator
   * ("Urban Supply - demo" -> "Urban Supply"). Mirrors brandName() in
   * frontend-v2/src/lib/brand-mark.ts, which draws the same mark in the
   * settings preview.
   */
  function brandName(widget) {
    var raw = String((widget.brand && widget.brand.name) || (widget.welcome && widget.welcome.assistantName) || "");
    var head = raw.split(/\s[-|·:\u2013\u2014]\s|\s*[|·]\s*/)[0] || raw;
    return head.trim().replace(/[\s\-|·:,;\u2013\u2014]+$/, "");
  }

  /** The brand's initial: the bubble's and the pop-up's mark (design 7, supervisor 2026-10-14). */
  function initialOf(widget) {
    // The server's (a whole grapheme, emoji and quotes skipped); the name's first letter before it shipped.
    if (widget.brand && widget.brand.initial) return String(widget.brand.initial);
    var name = brandName(widget);
    var letter = Array.from(name).filter(function (ch) { return /[\p{L}\p{N}]/u.test(ch); })[0] || "";
    return letter.toUpperCase();
  }

  /**
   * The text colour that reads on the main colour: design 7's cream or its
   * ink, whichever contrasts more. Not the stored contrastColor - Settings
   * never writes it, so it stays #ffffff on a pale colour (dev, 2026-10-14).
   * Mirrors inkOn() in frontend-v2/src/lib/brand-mark.ts (the preview).
   */
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

  var CHEVRON = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

  var badge = null;
  var nudgeTyped = false;
  var unreadCount = 0;

  function paintBadge() {
    if (!badge) return;
    // A reply the visitor has not seen, or the pop-up waiting for them (design 7's "1").
    var n = unreadCount > 0 ? unreadCount : nudgeTyped && !launcherOpen ? 1 : 0;
    badge.textContent = n > 9 ? "9+" : n > 0 ? String(n) : "";
    badge.setAttribute("data-show", n > 0 && !launcherOpen ? "1" : "0");
  }

  /**
   * The launcher, drawn from the same config the storefront launcher uses
   * so the two are the same control with the same settings behind them.
   *
   * Design 7 ("GOTCHA Widgets on Store"): a 56px bubble in the main colour,
   * 22px from the bottom and the chosen side, carrying the brand's initial,
   * a pulsing green dot while someone answers, and a "1" when the pop-up is
   * waiting. Open, it is a chevron that minimises the chat.
   */
  function paintLauncher(widget) {
    var L = (widget.ux && widget.ux.launcher) || {};
    // The WhatsApp look: a round green launcher with the WhatsApp mark.
    var wa = !!(widget.ux && widget.ux.look === "whatsapp");
    if (wa) L = { size: 56, position: L.position, mobilePosition: L.mobilePosition, offsetSide: L.offsetSide, offsetBottom: L.offsetBottom, mobileOffsetBottom: L.mobileOffsetBottom, shape: "circle", backgroundColor: "#25D366", iconColor: "#fff", shadow: 2 };
    var appearance = widget.appearance || {};
    var mobile = window.matchMedia("(max-width: 560px)").matches;
    var side = (mobile ? L.mobilePosition : L.position) === "left" ? "left" : "right";
    var accent = appearance.primaryColor || L.backgroundColor || "#2B2622";
    var online = startData && startData.availability !== "offline";

    // Design 7's place for both looks: 22px from the side and the bottom.
    host.style.setProperty(side, "22px");
    host.style.setProperty("bottom", "22px");
    host.style.setProperty(side === "left" ? "right" : "left", "auto");

    var style = document.createElement("style");
    style.textContent = [
      ".ldr{position:relative;width:56px;height:56px;border-radius:50%;padding:0;border:0;cursor:pointer;",
      "  display:flex;align-items:center;justify-content:center;",
      // A pale main colour must not get pale text.
      "  background:" + (wa ? "#25D366" : accent) + ";color:" + (wa ? "#fff" : inkOn(accent)) + ";",
      "  box-shadow:0 1px 0 rgba(255,255,255,.12) inset,0 10px 28px rgba(43,38,34,.28);",
      "  transition:transform .2s ease;}",
      ".ldr:hover{transform:translateY(-2px);}",
      ".ldr:focus-visible{outline:3px solid " + (wa ? "#25D366" : accent) + ";outline-offset:3px;}",
      ".ldr svg{width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;flex:none;}",
      ".ldr .chev{width:22px;height:22px;}",
      ".mark{font:500 24px/1 'Cormorant Garamond',Georgia,'Times New Roman',serif;color:inherit;}",
      // The online dot: someone is answering right now.
      ".on{position:absolute;top:3px;left:3px;width:11px;height:11px;border-radius:50%;box-sizing:border-box;",
      "  background:#5FA578;border:2px solid " + accent + ";}",
      ".on::after,.pav-on::after{content:'';position:absolute;inset:-2px;border-radius:50%;",
      "  background:rgba(80,190,100,.45);animation:pulse 1.8s ease-out infinite;pointer-events:none;}",
      "@keyframes pulse{0%{transform:scale(1);opacity:.9}70%{transform:scale(2.8);opacity:0}100%{transform:scale(2.8);opacity:0}}",
      ".bdg{position:absolute;top:-3px;right:-3px;min-width:20px;height:20px;box-sizing:border-box;border-radius:10px;",
      "  padding:0 5px;background:#C4552F;color:#fff;border:2px solid #FBF8F3;",
      "  font:700 11.5px/16px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;text-align:center;display:none;}",
      ".bdg[data-show='1']{display:block;}",

      // ── The pop-up (design 7): who is writing, typing, then the message ──
      ".pop{position:fixed;bottom:90px;" + side + ":22px;width:min(330px, calc(100vw - 44px));z-index:1;",
      "  font:400 14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;",
      "  color:#2B2622;animation:pin .35s cubic-bezier(.2,.75,.2,1);}",
      ".pop-c{position:relative;background:#fff;border-radius:" + (side === "right" ? "18px 18px 6px 18px" : "18px 18px 18px 6px") + ";",
      "  box-shadow:0 0 0 1px rgba(43,38,34,.07),0 20px 44px -12px rgba(43,38,34,.28);",
      "  padding:12px 12px 14px;display:flex;flex-direction:column;gap:10px;}",
      // The tail points at the bubble.
      ".pop-c::after{content:'';position:absolute;" + side + ":20px;bottom:-7px;width:16px;height:16px;background:#fff;",
      "  transform:rotate(45deg);border-radius:" + (side === "right" ? "0 0 4px 0" : "0 0 0 4px") + ";box-shadow:1px 1px 0 rgba(43,38,34,.07);}",
      ".pop-h{display:flex;align-items:center;gap:10px;}",
      ".pav{position:relative;width:32px;height:32px;border-radius:50%;flex:none;background:" + accent + ";color:" + inkOn(accent) + ";",
      "  display:flex;align-items:center;justify-content:center;",
      "  font:500 19px/1 'Cormorant Garamond',Georgia,'Times New Roman',serif;}",
      ".pav-on{position:absolute;bottom:-1px;left:-1px;width:10px;height:10px;box-sizing:border-box;border-radius:50%;",
      "  background:#5FA578;border:2px solid #fff;}",
      ".pop-n{flex:1;min-width:0;display:flex;align-items:baseline;gap:8px;}",
      ".pop-n{flex-direction:column;align-items:flex-start;gap:1px;}",
      ".pop-nm{max-width:100%;font-size:14px;font-weight:600;color:#2B2622;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
      ".pop-t{font-size:12px;color:#8A7A6C;}",
      // The store's live coupons the merchant chose (W9d), one at a time.
      ".deal{display:flex;align-items:center;gap:10px;border-top:1px solid #EEE7DC;padding-top:10px;}",
      ".deal-b{flex:1;min-width:0;border:0;background:none;padding:0;font:inherit;text-align:start;color:#2B2622;",
      "  display:flex;flex-direction:column;gap:2px;cursor:pointer;}",
      ".deal-l{font-size:11.5px;color:#A8674F;}",
      ".deal-t{font-size:14px;font-weight:600;}",
      ".deal-s{font-size:12px;color:#8A7A6C;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;}",
      ".deal-c{display:flex;flex-direction:column;align-items:center;gap:6px;flex:none;}",
      ".deal-n{width:28px;height:28px;border-radius:8px;border:1px solid #E6DDD0;background:#fff;color:#2B2622;",
      "  display:flex;align-items:center;justify-content:center;padding:0;cursor:pointer;}",
      ".deal-n svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round;}",
      ".deal-d{display:flex;gap:4px;}",
      ".deal-d i{width:5px;height:5px;border-radius:50%;background:#DDD3C6;}",
      ".deal-d i[data-on='1']{background:#2B2622;}",
      ".deal-b:focus-visible,.deal-n:focus-visible{outline:2px solid " + accent + ";outline-offset:2px;}",
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
      "  display:flex;flex-direction:column;gap:3px;cursor:pointer;animation:pin .25s ease;}",
      ".pop-s{font-size:12.5px;color:#8A7A6C;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;}",
      "@keyframes pin{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}",
      "@media (prefers-reduced-motion: reduce){.ldr,.pop,.pop-m{transition:none;animation:none}.ldr:hover{transform:none}",
      "  .on::after,.pav-on::after{animation:none;opacity:0}.pop-ty i{animation:none;opacity:.6}}",
      "@media (forced-colors: active){.ldr{border:1px solid ButtonText;}}",
    ].join("\n");

    var button = document.createElement("button");
    button.className = "ldr";
    button.type = "button";
    button.setAttribute("data-act", "launcher");
    button.setAttribute("aria-label", (widget.welcome && widget.welcome.assistantName) || "Chat");
    button.setAttribute("aria-expanded", "false");
    if (wa) {
      button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" style="fill:currentColor;stroke:none"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.2.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.1.6a2.7 2.7 0 0 0 1.8-1.3 2.2 2.2 0 0 0 .2-1.3c-.1-.1-.3-.2-.5-.3z"/></svg>';
    } else {
      var mark = initialOf(widget);
      if (mark) {
        var span = document.createElement("span");
        span.className = "mark";
        span.setAttribute("dir", "ltr");
        span.setAttribute("aria-hidden", "true");
        span.textContent = mark;
        button.appendChild(span);
      } else {
        button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3c5 0 9 3.36 9 7.5S17 18 12 18a10.7 10.7 0 0 1-3-.42L5 19l1.2-3.2A7.9 7.9 0 0 1 3 10.5C3 6.36 7 3 12 3z"/></svg>';
      }
    }
    launcherIcon = button.innerHTML;
    button.addEventListener("click", function () {
      if (!app) return;
      if (launcherOpen && typeof app.close === "function") app.close();
      else app.open();
    });
    launcherButton = button;

    shadow.appendChild(style);
    shadow.appendChild(button);
    decorateLauncher(!wa && online);
    armPopup(widget, side, wa);
  }

  /** The dot and the badge are children of the button: re-added after every repaint of its face. */
  var showDot = false;
  function decorateLauncher(dot) {
    if (dot != null) showDot = dot;
    if (!launcherButton) return;
    if (showDot && !launcherOpen) {
      var d = document.createElement("span");
      d.className = "on";
      d.setAttribute("aria-hidden", "true");
      launcherButton.appendChild(d);
    }
    badge = document.createElement("span");
    badge.className = "bdg";
    badge.setAttribute("aria-hidden", "true");
    badge.setAttribute("dir", "ltr");
    launcherButton.appendChild(badge);
    paintBadge();
  }

  // ── The pop-up ───────────────────────────────────────────────
  //
  // The message the merchant wrote, once per visit, after the time they
  // chose. Code-snippet sites had no pop-up at all, so the setting did
  // nothing there. Design 7: who is writing and "now", a moment of typing,
  // then the message - which opens the chat. A conversation already under
  // way is offered back instead ("Pick up where we left off?" and its last
  // line). Nothing is offered once the visitor has opened the chat.

  var popup = null;
  var popupTimer = null;

  function session(k, v) {
    try {
      if (v === undefined) return window.sessionStorage.getItem(STORAGE_PREFIX + "_" + k);
      window.sessionStorage.setItem(STORAGE_PREFIX + "_" + k, v);
    } catch (e) { return null; }
    return null;
  }

  function hidePopup() {
    if (popupTimer) { clearTimeout(popupTimer); popupTimer = null; }
    if (dealTimer) { clearInterval(dealTimer); dealTimer = null; }
    if (popup && popup.parentNode) popup.parentNode.removeChild(popup);
    popup = null;
    nudgeTyped = false;
    paintBadge();
  }

  function armPopup(widget, side, wa) {
    var cfg = widget.ux && widget.ux.proactive;
    if (wa || !cfg || !cfg.enabled) return;
    var message = String(cfg.message || "").trim();
    if (!message) return;
    var max = Number(cfg.maxPerSession) || 1;
    if (Number(session("popups") || 0) >= max) return;
    var mobile = window.matchMedia("(max-width: 560px)").matches;
    var seconds = Number(mobile && cfg.mobileDelaySeconds != null ? cfg.mobileDelaySeconds : cfg.delaySeconds) || 1;
    // At least the moment the page needs to draw (design 7: never under 0.9s).
    popupTimer = setTimeout(function () { showPopup(widget, message); }, Math.max(900, seconds * 1000));
  }

  /** A coupon in words; null when it cannot be said truthfully (an amount with no currency). */
  function dealWords(p, W, lang) {
    var amount = Number(p.amount);
    if (!p.code || !isFinite(amount) || amount <= 0) return null;
    var title;
    if (p.discountType === "percent") {
      title = W.percentOff.replace("{n}", String(Math.round(amount * 100) / 100));
    } else if (p.currency) {
      try {
        var sum = new Intl.NumberFormat(lang === "he" ? "he-IL" : "en-US", { style: "currency", currency: p.currency, maximumFractionDigits: 2 }).format(amount);
        title = W.percentOff.replace("{n}%", sum);
      } catch (e) { return null; }
    } else {
      return null;
    }
    var sub = W.code.replace("{code}", String(p.code));
    var ends = p.expiresAt ? new Date(p.expiresAt) : null;
    if (ends && !isNaN(ends.getTime())) {
      var date = new Intl.DateTimeFormat(lang === "he" ? "he-IL" : "en-GB", { day: "numeric", month: "numeric" }).format(ends);
      sub += " · " + W.until.replace("{date}", date);
    }
    return { title: title, sub: sub };
  }

  var dealTimer = null;

  function dealStrip(widget, W, lang) {
    var list = (widget.promotions || []).map(function (p) { return dealWords(p, W, lang); }).filter(Boolean);
    if (!list.length) return null;
    var at = 0;
    var strip = document.createElement("div");
    strip.className = "deal";
    strip.setAttribute("data-act", "deals");
    var b = document.createElement("button");
    b.type = "button";
    b.className = "deal-b";
    var label = document.createElement("span");
    label.className = "deal-l";
    label.textContent = W.deal;
    var title = document.createElement("bdi");
    title.className = "deal-t";
    var sub = document.createElement("bdi");
    sub.className = "deal-s";
    b.appendChild(label);
    b.appendChild(title);
    b.appendChild(sub);
    b.addEventListener("click", function () { hidePopup(); if (app) app.open(); });
    strip.appendChild(b);
    var dots = null;
    function paint() {
      title.textContent = list[at].title;
      sub.textContent = list[at].sub;
      if (dots) Array.prototype.forEach.call(dots.children, function (d, i) { d.setAttribute("data-on", i === at ? "1" : "0"); });
    }
    if (list.length > 1) {
      var col = document.createElement("span");
      col.className = "deal-c";
      var next = document.createElement("button");
      next.type = "button";
      next.className = "deal-n";
      next.setAttribute("aria-label", W.nextDeal);
      next.setAttribute("data-act", "deal-next");
      // Onward in reading order: left in Hebrew, right in English.
      next.innerHTML = lang === "he"
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5"/><path d="m11 6-6 6 6 6"/></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>';
      next.addEventListener("click", function () {
        at = (at + 1) % list.length;
        paint();
        // The visitor took over; the strip stops turning by itself.
        if (dealTimer) { clearInterval(dealTimer); dealTimer = null; }
      });
      dots = document.createElement("span");
      dots.className = "deal-d";
      dots.setAttribute("aria-hidden", "true");
      list.forEach(function () { dots.appendChild(document.createElement("i")); });
      col.appendChild(next);
      col.appendChild(dots);
      strip.appendChild(col);
      var still = false;
      try { still = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}
      if (!still) dealTimer = setInterval(function () { at = (at + 1) % list.length; paint(); }, 4500);
    }
    paint();
    return strip;
  }

  function showPopup(widget, message) {
    popupTimer = null;
    if (launcherOpen || popup) return;
    session("popups", String(Number(session("popups") || 0) + 1));
    var lang = langOf(widget);
    var W = WORDS[lang];
    var resuming = !!store.get("conversation");

    popup = document.createElement("div");
    popup.className = "pop";
    popup.setAttribute("role", "status");
    popup.setAttribute("aria-live", "polite");
    popup.setAttribute("dir", lang === "he" ? "rtl" : "ltr");
    popup.setAttribute("lang", lang);
    popup.setAttribute("data-act", "popup");
    var card = document.createElement("div");
    card.className = "pop-c";

    var head = document.createElement("div");
    head.className = "pop-h";
    var av = document.createElement("span");
    av.className = "pav";
    av.setAttribute("aria-hidden", "true");
    av.textContent = initialOf(widget);
    if (startData && startData.availability !== "offline") {
      var dot = document.createElement("span");
      dot.className = "pav-on";
      av.appendChild(dot);
    }
    var names = document.createElement("span");
    names.className = "pop-n";
    var nm = document.createElement("bdi");
    nm.className = "pop-nm";
    nm.textContent = (widget.welcome && widget.welcome.assistantName) || brandName(widget);
    names.appendChild(nm);
    // "Replies right away" only while someone does.
    if (startData && startData.availability !== "offline") {
      var when = document.createElement("span");
      when.className = "pop-t";
      when.textContent = W.replies;
      names.appendChild(when);
    }
    var x = document.createElement("button");
    x.type = "button";
    x.className = "pop-x";
    x.setAttribute("aria-label", W.close);
    x.setAttribute("data-act", "popup-close");
    x.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    x.addEventListener("click", hidePopup);
    head.appendChild(av);
    head.appendChild(names);
    head.appendChild(x);
    card.appendChild(head);

    var typing = document.createElement("div");
    typing.className = "pop-ty";
    typing.setAttribute("aria-hidden", "true");
    typing.innerHTML = "<i></i><i></i><i></i>";
    card.appendChild(typing);
    popup.appendChild(card);
    shadow.appendChild(popup);

    var reveal = function (sub) {
      if (!popup) return;
      if (typing.parentNode) typing.parentNode.removeChild(typing);
      var msg = document.createElement("button");
      msg.type = "button";
      msg.className = "pop-m";
      msg.setAttribute("data-act", "popup-open");
      var text = document.createElement("bdi");
      text.textContent = resuming ? W.resume : message;
      msg.appendChild(text);
      if (sub) {
        var line = document.createElement("bdi");
        line.className = "pop-s";
        line.textContent = sub;
        msg.appendChild(line);
      }
      msg.addEventListener("click", function () {
        hidePopup();
        if (app) app.open();
      });
      card.appendChild(msg);
      // The "1" on the bubble is for a message the visitor has not read;
      // an offer to resume is not one.
      nudgeTyped = !resuming;
      paintBadge();
      var deals = dealStrip(widget, W, lang);
      if (deals) card.appendChild(deals);
    };

    var still = false;
    try { still = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}
    var typed = new Promise(function (resolve) { setTimeout(resolve, still ? 0 : 1500); });
    var last = resuming
      ? loadMessages(store.get("conversation")).then(function (messages) {
          var m = messages.filter(function (it) { return it.body; }).pop();
          return m ? String(m.body).split("\n")[0] : "";
        })
      : Promise.resolve("");
    Promise.all([typed, last]).then(function (r) { reveal(r[1]); }, function () { reveal(""); });
  }

  function start() {
    // Ask BEFORE drawing. A widget that no longer exists draws nothing at
    // all, rather than a button that opens onto silence.
    post(API_PATH + "/bootstrap", { widgetId: WIDGET_ID })
      .then(function (res) {
        var data = (res && res.data) || {};
        if (!data.widget) return;
        startData = data;
        return loadBundle().then(function () {
          if (typeof window.__gotchaShopifyChatApp !== "function") return;
          mount(data);
        });
      })
      .catch(function (err) {
        // A removed widget is not an error: the server answers 200 with an
        // empty body and the branch above simply returns. This is for the
        // genuinely exceptional - the network is down, or we are broken -
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
