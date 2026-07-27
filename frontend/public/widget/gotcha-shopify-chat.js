/**
 * GOTCHA Shopify Live Chat — chat application.
 *
 * Loaded lazily by the bootstrap, so nothing in this file is on the
 * critical path of a storefront page.
 *
 * Two rules run through the whole file:
 *
 *   1. Nothing dynamic is ever written as HTML. Every value that came
 *      from a server, a merchant or a shopper goes in via `textContent`.
 *      Markup is built from element factories. There is no innerHTML
 *      interpolation anywhere below, which is what makes "message HTML is
 *      sanitized" true by construction rather than by a filter someone
 *      has to remember to call.
 *   2. Nothing about money or stock is believed from local state. Prices
 *      shown come from the server's snapshot; Add to Cart re-validates
 *      server-side and only then touches the theme's own cart.
 */
window.__gotchaShopifyChatApp = function (boot) {
  "use strict";

  var API = boot.api;
  var ASSETS = boot.assets;
  var shadow = boot.shadow;
  var store = boot.store;
  var widget = boot.widget;
  var appearance = widget.appearance;
  var welcome = widget.welcome;
  var features = widget.features;

  var STRINGS = {
    en: {
      online: "Online",
      offline: "Away",
      close: "Close chat",
      placeholder: "Ask us anything",
      send: "Send",
      startConversation: "Start the conversation",
      connecting: "Connecting…",
      reconnecting: "Reconnecting…",
      waitingAi: "Typing…",
      waitingAgent: "Connecting you with someone from the team…",
      agentJoined: "A team member has joined.",
      talkToHuman: "Talk to a person",
      failed: "Something went wrong. Try again.",
      retry: "Try again",
      rateLimited: "You are sending messages very quickly. Please wait a moment.",
      ended: "This conversation has ended.",
      addToCart: "Add to cart",
      adding: "Adding…",
      added: "Added to cart",
      viewProduct: "View product",
      viewCart: "View cart",
      keepShopping: "Keep shopping",
      soldOut: "Sold out",
      unavailable: "Unavailable",
      notPublished: "Not published",
      chooseOption: "Choose an option",
      quantity: "Quantity",
      poweredBy: "Powered by GOTCHA",
      name: "Name",
      email: "Email",
      message: "Message",
      submit: "Send message",
      submitted: "Thanks. We will get back to you.",
      consent: "I agree to be contacted about this enquiry.",
      previous: "Previous products",
      next: "More products",
      you: "You",
    },
    he: {
      online: "זמינים",
      offline: "לא זמינים",
      close: "סגירת הצ׳אט",
      placeholder: "אפשר לשאול אותנו הכל",
      send: "שליחה",
      startConversation: "אפשר להתחיל",
      connecting: "מתחברים…",
      reconnecting: "מתחברים מחדש…",
      waitingAi: "מקלידים…",
      waitingAgent: "מחברים אתכם לנציג…",
      agentJoined: "נציג הצטרף לשיחה.",
      talkToHuman: "לדבר עם נציג",
      failed: "משהו השתבש. אפשר לנסות שוב.",
      retry: "לנסות שוב",
      rateLimited: "ההודעות נשלחות מהר מדי. רגע אחד.",
      ended: "השיחה הסתיימה.",
      addToCart: "הוספה לסל",
      adding: "מוסיפים…",
      added: "נוסף לסל",
      viewProduct: "למוצר",
      viewCart: "לסל הקניות",
      keepShopping: "להמשיך לגלוש",
      soldOut: "אזל מהמלאי",
      unavailable: "לא זמין",
      notPublished: "לא מפורסם",
      chooseOption: "בחרו אפשרות",
      quantity: "כמות",
      poweredBy: "מופעל על ידי GOTCHA",
      name: "שם",
      email: "אימייל",
      message: "הודעה",
      submit: "שליחת הודעה",
      submitted: "תודה, נחזור אליכם.",
      consent: "אני מאשר/ת שתיצרו איתי קשר בנוגע לפנייה.",
      previous: "מוצרים קודמים",
      next: "עוד מוצרים",
      you: "את/ה",
    },
  };

  // Language: the merchant's explicit choice wins; "auto" follows the
  // storefront's own locale, because the shopper already chose that.
  var lang =
    appearance.language !== "auto"
      ? appearance.language
      : /^he/i.test(String(boot.context.locale || document.documentElement.lang || ""))
        ? "he"
        : "en";
  var T = STRINGS[lang] || STRINGS.en;
  var dir =
    appearance.direction !== "auto" ? appearance.direction : lang === "he" ? "rtl" : "ltr";

  // ── State ───────────────────────────────────────────────────────

  var S = {
    phase: "welcome", // welcome | connecting | active | offline_form | failed
    connection: "idle", // idle | connecting | live | polling | reconnecting
    messages: [],
    pending: [], // optimistic sends awaiting their server echo
    conversationId: store.get("conversation"),
    awaitingReply: false,
    handedOver: false,
    ended: false,
    rateLimited: false,
    error: null,
    opened: false,
    lastCursor: null,
    unread: 0,
  };

  var socket = null;
  var pollTimer = null;
  var els = {};
  var shownProducts = {};

  // ── DOM helpers (no innerHTML for dynamic content, ever) ────────

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }
  function attr(node, map) {
    Object.keys(map).forEach(function (k) {
      if (map[k] == null) node.removeAttribute(k);
      else node.setAttribute(k, String(map[k]));
    });
    return node;
  }
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }
  function on(node, evt, fn) {
    node.addEventListener(evt, fn);
    return node;
  }

  /**
   * Only https URLs on hosts we expect are allowed to become an href or
   * a src. A product link is server-built, but this is the last gate
   * before a URL reaches the DOM and it costs nothing.
   */
  function safeUrl(raw) {
    if (typeof raw !== "string") return null;
    try {
      var u = new URL(raw, window.location.origin);
      return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
    } catch (e) {
      return null;
    }
  }

  function money(amount, currency) {
    if (amount == null) return "";
    var n = Number(amount);
    if (!isFinite(n)) return "";
    try {
      return new Intl.NumberFormat(lang === "he" ? "he-IL" : "en-US", {
        style: "currency",
        currency: currency || "USD",
        minimumFractionDigits: n % 1 === 0 ? 0 : 2,
      }).format(n);
    } catch (e) {
      return n.toFixed(2) + " " + (currency || "");
    }
  }

  // ── Styles ──────────────────────────────────────────────────────

  var radius = Math.max(0, Math.min(28, Number(appearance.cornerRadius) || 20));
  var brand = appearance.primaryColor;
  var onBrand = appearance.contrastColor;
  var side = appearance.launcherPosition === "left" ? "left" : "right";

  var css = [
    ".panel{",
    "  position:fixed;bottom:88px;" + side + ":20px;width:392px;max-width:calc(100vw - 32px);",
    "  height:min(640px, calc(100vh - 120px));",
    "  background:#fff;color:#0f172a;border-radius:" + radius + "px;",
    "  box-shadow:0 24px 60px rgba(15,23,42,.22),0 2px 8px rgba(15,23,42,.08);",
    "  display:flex;flex-direction:column;overflow:hidden;",
    "  font:400 15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;",
    "  animation:rise .22s cubic-bezier(.2,.8,.3,1);",
    "}",
    "@keyframes rise{from{opacity:0;transform:translateY(12px) scale(.985)}to{opacity:1;transform:none}}",
    "@media (prefers-reduced-motion: reduce){.panel{animation:none}}",
    // Phones: a floating card wastes the screen and fights the keyboard.
    "@media (max-width: 560px){",
    "  .panel{inset:0;width:100%;max-width:100%;height:100%;border-radius:0;",
    "    height:100dvh;padding-bottom:env(safe-area-inset-bottom);}",
    "}",
    ".hd{display:flex;align-items:center;gap:12px;padding:16px 18px;border-bottom:1px solid #eef1f5;}",
    ".hd-av{width:40px;height:40px;border-radius:12px;object-fit:cover;background:" + brand + ";flex:0 0 auto;}",
    ".hd-tx{flex:1 1 auto;min-width:0;}",
    ".hd-nm{font-weight:650;font-size:15px;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
    ".hd-st{display:flex;align-items:center;gap:6px;font-size:12.5px;color:#64748b;margin-top:2px;}",
    ".dot{width:7px;height:7px;border-radius:4px;background:#16a34a;flex:0 0 auto;}",
    ".dot[data-off='1']{background:#cbd5e1;}",
    ".x{width:34px;height:34px;border-radius:10px;border:0;background:transparent;color:#64748b;cursor:pointer;flex:0 0 auto;}",
    ".x:hover{background:#f1f5f9;color:#0f172a;}",
    ".x:focus-visible{outline:2px solid " + brand + ";outline-offset:2px;}",
    ".x svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;}",

    ".bd{flex:1 1 auto;overflow-y:auto;overflow-x:hidden;padding:18px;scroll-behavior:smooth;overscroll-behavior:contain;}",
    "@media (prefers-reduced-motion: reduce){.bd{scroll-behavior:auto}}",

    // Welcome
    ".wel{display:flex;flex-direction:column;gap:18px;padding:10px 2px 4px;}",
    ".wel-lg{width:52px;height:52px;border-radius:14px;object-fit:contain;background:#f8fafc;}",
    ".wel-h{font-size:26px;line-height:1.2;font-weight:680;letter-spacing:-.02em;margin:0;}",
    ".wel-s{font-size:15px;color:#475569;margin:-8px 0 0;}",
    ".sug{display:flex;flex-direction:column;gap:8px;}",
    ".sug-b{text-align:" + (dir === "rtl" ? "right" : "left") + ";border:1px solid #e2e8f0;background:#fff;",
    "  border-radius:14px;padding:12px 14px;font:inherit;font-size:14.5px;color:#0f172a;cursor:pointer;",
    "  transition:border-color .15s,background .15s,transform .15s;}",
    ".sug-b:hover{border-color:" + brand + ";background:#f8fafc;}",
    ".sug-b:focus-visible{outline:2px solid " + brand + ";outline-offset:2px;}",
    "@media (prefers-reduced-motion: reduce){.sug-b{transition:none}}",

    // Messages
    ".msgs{display:flex;flex-direction:column;gap:10px;}",
    ".row{display:flex;flex-direction:column;max-width:100%;}",
    ".row[data-me='1']{align-items:flex-end;}",
    ".row[data-me='0']{align-items:flex-start;}",
    ".bub{max-width:84%;padding:10px 13px;border-radius:16px;font-size:14.5px;white-space:pre-wrap;word-break:break-word;}",
    ".row[data-me='1'] .bub{background:" + brand + ";color:" + onBrand + ";border-bottom-" + (dir === "rtl" ? "left" : "right") + "-radius:6px;}",
    ".row[data-me='0'] .bub{background:#f1f5f9;color:#0f172a;border-bottom-" + (dir === "rtl" ? "right" : "left") + "-radius:6px;}",
    ".who{font-size:11.5px;color:#94a3b8;margin:0 4px 3px;}",
    ".mst{font-size:11px;color:#94a3b8;margin:3px 4px 0;}",
    ".typ{display:inline-flex;gap:4px;align-items:center;padding:12px 14px;background:#f1f5f9;border-radius:16px;}",
    ".typ i{width:6px;height:6px;border-radius:3px;background:#94a3b8;animation:blink 1.2s infinite;}",
    ".typ i:nth-child(2){animation-delay:.2s}.typ i:nth-child(3){animation-delay:.4s}",
    "@keyframes blink{0%,60%,100%{opacity:.3}30%{opacity:1}}",
    "@media (prefers-reduced-motion: reduce){.typ i{animation:none;opacity:.6}}",
    ".note{font-size:12.5px;color:#64748b;text-align:center;padding:8px 12px;}",

    // Product cards
    ".card{border:1px solid #e6eaf0;border-radius:16px;overflow:hidden;background:#fff;max-width:86%;}",
    ".card-top{display:flex;gap:12px;padding:12px;}",
    ".card-im{width:78px;height:78px;border-radius:11px;object-fit:cover;background:#f1f5f9;flex:0 0 auto;}",
    ".card-in{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:3px;}",
    ".card-ti{font-weight:620;font-size:14.5px;line-height:1.3;}",
    ".card-pr{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap;}",
    ".pr{font-weight:650;font-size:15px;}",
    ".pr-was{font-size:12.5px;color:#94a3b8;text-decoration:line-through;}",
    ".tag{display:inline-block;font-size:11px;font-weight:600;padding:2px 7px;border-radius:999px;}",
    ".tag-sale{background:#fee2e2;color:#b91c1c;}",
    ".tag-out{background:#f1f5f9;color:#64748b;}",
    ".tag-dr{background:#fef3c7;color:#92400e;}",
    ".why{font-size:12.5px;color:#475569;padding:0 12px 10px;}",
    ".opts{padding:0 12px 10px;display:flex;flex-direction:column;gap:7px;}",
    ".opt-l{font-size:11.5px;color:#64748b;}",
    ".chips{display:flex;flex-wrap:wrap;gap:6px;}",
    ".chip{border:1px solid #e2e8f0;background:#fff;border-radius:999px;padding:5px 11px;font:inherit;font-size:12.5px;cursor:pointer;color:#0f172a;}",
    ".chip[aria-pressed='true']{border-color:" + brand + ";background:" + brand + ";color:" + onBrand + ";}",
    ".chip:disabled{opacity:.4;cursor:not-allowed;text-decoration:line-through;}",
    ".chip:focus-visible{outline:2px solid " + brand + ";outline-offset:2px;}",
    ".qty{display:flex;align-items:center;gap:8px;padding:0 12px 10px;}",
    ".qty-b{width:28px;height:28px;border-radius:8px;border:1px solid #e2e8f0;background:#fff;cursor:pointer;font:inherit;color:#0f172a;}",
    ".qty-b:disabled{opacity:.4;cursor:not-allowed;}",
    ".qty-v{min-width:22px;text-align:center;font-size:14px;font-variant-numeric:tabular-nums;}",
    ".acts{display:flex;gap:8px;padding:0 12px 12px;}",
    ".btn{flex:1 1 auto;border-radius:11px;padding:9px 12px;font:inherit;font-size:13.5px;font-weight:600;cursor:pointer;text-align:center;text-decoration:none;border:1px solid transparent;}",
    ".btn-p{background:" + brand + ";color:" + onBrand + ";}",
    ".btn-p:disabled{opacity:.45;cursor:not-allowed;}",
    ".btn-s{background:#fff;color:#0f172a;border-color:#e2e8f0;}",
    ".btn-s:hover{border-color:#cbd5e1;}",
    ".btn:focus-visible{outline:2px solid " + brand + ";outline-offset:2px;}",
    ".cart-ok{display:flex;align-items:center;gap:6px;font-size:12.5px;color:#15803d;padding:0 12px 12px;}",
    ".cart-err{font-size:12.5px;color:#b91c1c;padding:0 12px 12px;}",

    // Carousel
    ".car{position:relative;max-width:100%;}",
    ".car-tr{display:flex;gap:10px;overflow-x:auto;scroll-snap-type:x mandatory;padding:2px 2px 8px;",
    "  scrollbar-width:thin;-webkit-overflow-scrolling:touch;}",
    ".car-tr>*{flex:0 0 214px;scroll-snap-align:start;max-width:214px;}",
    ".car-tr .card{max-width:100%;}",
    ".car-tr .card-top{flex-direction:column;}",
    ".car-tr .card-im{width:100%;height:132px;}",
    ".car-nav{display:flex;gap:6px;justify-content:flex-end;padding:0 2px;}",
    ".car-n{width:28px;height:28px;border-radius:8px;border:1px solid #e2e8f0;background:#fff;cursor:pointer;color:#475569;}",
    ".car-n:focus-visible{outline:2px solid " + brand + ";outline-offset:2px;}",

    // Composer
    ".ft{border-top:1px solid #eef1f5;padding:12px 14px;padding-bottom:calc(12px + env(safe-area-inset-bottom));background:#fff;}",
    ".cmp{display:flex;align-items:flex-end;gap:8px;}",
    ".ta{flex:1 1 auto;resize:none;border:1px solid #e2e8f0;border-radius:14px;padding:10px 13px;",
    "  font:inherit;font-size:16px;line-height:1.4;max-height:120px;min-height:42px;color:#0f172a;background:#fff;}",
    "@media (min-width: 561px){.ta{font-size:14.5px;}}",
    ".ta:focus{outline:none;border-color:" + brand + ";box-shadow:0 0 0 3px " + brand + "22;}",
    ".snd{width:42px;height:42px;flex:0 0 auto;border-radius:12px;border:0;background:" + brand + ";color:" + onBrand + ";cursor:pointer;}",
    ".snd:disabled{opacity:.4;cursor:not-allowed;}",
    ".snd:focus-visible{outline:2px solid " + brand + ";outline-offset:2px;}",
    ".snd svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}",
    ".sub{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px;}",
    ".lnk{background:none;border:0;padding:0;font:inherit;font-size:12px;color:#64748b;cursor:pointer;text-decoration:underline;}",
    ".lnk:focus-visible{outline:2px solid " + brand + ";outline-offset:2px;}",
    ".pw{font-size:11px;color:#94a3b8;}",
    ".banner{font-size:12.5px;padding:8px 14px;text-align:center;}",
    ".banner[data-kind='warn']{background:#fef3c7;color:#92400e;}",
    ".banner[data-kind='err']{background:#fee2e2;color:#b91c1c;}",
    ".banner[data-kind='info']{background:#f1f5f9;color:#475569;}",

    // Offline form
    ".form{display:flex;flex-direction:column;gap:10px;padding:4px 2px;}",
    ".fl{font-size:12.5px;color:#475569;}",
    ".fi{border:1px solid #e2e8f0;border-radius:12px;padding:10px 12px;font:inherit;font-size:16px;color:#0f172a;}",
    "@media (min-width: 561px){.fi{font-size:14.5px;}}",
    ".fi:focus{outline:none;border-color:" + brand + ";box-shadow:0 0 0 3px " + brand + "22;}",
    ".cbx{display:flex;gap:8px;align-items:flex-start;font-size:12.5px;color:#475569;}",

    ".sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;}",

    // Respect a shopper's contrast + forced-colors preferences.
    "@media (prefers-contrast: more){",
    "  .bub,.card,.chip,.ta,.fi,.sug-b{border:1px solid #0f172a;}",
    "  .hd-st,.who,.mst,.pw,.note{color:#334155;}",
    "}",
    "@media (forced-colors: active){",
    "  .panel,.card,.bub{border:1px solid CanvasText;}",
    "  .btn-p,.snd{border:1px solid ButtonText;}",
    "}",
  ].join("\n");

  var styleNode = document.createElement("style");
  styleNode.textContent = css;
  shadow.appendChild(styleNode);

  // ── Panel shell ─────────────────────────────────────────────────

  var panel = el("div", "panel");
  attr(panel, {
    role: "dialog",
    "aria-modal": "false",
    "aria-label": welcome.assistantName || "Chat",
    dir: dir,
    lang: lang,
    hidden: "",
  });

  var header = el("div", "hd");
  var headerAvatar = document.createElement("img");
  headerAvatar.className = "hd-av";
  headerAvatar.alt = "";
  var logo = safeUrl(appearance.logoUrl) || safeUrl(appearance.avatarUrl);
  if (logo) headerAvatar.src = logo;
  else headerAvatar.style.background = brand;

  var headerText = el("div", "hd-tx");
  var headerName = el("div", "hd-nm", welcome.assistantName || "");
  var headerStatus = el("div", "hd-st");
  var statusDot = el("span", "dot");
  var statusText = el("span", null, "");
  headerStatus.appendChild(statusDot);
  headerStatus.appendChild(statusText);
  headerText.appendChild(headerName);
  headerText.appendChild(headerStatus);

  var closeBtn = el("button", "x");
  attr(closeBtn, { type: "button", "aria-label": T.close });
  closeBtn.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  header.appendChild(headerAvatar);
  header.appendChild(headerText);
  header.appendChild(closeBtn);

  var banner = el("div", "banner");
  banner.hidden = true;

  var body = el("div", "bd");
  attr(body, { tabindex: "0", role: "log", "aria-live": "polite", "aria-relevant": "additions" });

  var footer = el("div", "ft");
  var composer = el("form", "cmp");
  var textarea = document.createElement("textarea");
  textarea.className = "ta";
  attr(textarea, { rows: "1", placeholder: T.placeholder, "aria-label": T.placeholder, maxlength: "2000" });
  var sendBtn = el("button", "snd");
  attr(sendBtn, { type: "submit", "aria-label": T.send, disabled: "" });
  sendBtn.innerHTML =
    dir === "rtl"
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12H4M10 6l-6 6 6 6"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16M14 6l6 6-6 6"/></svg>';
  composer.appendChild(textarea);
  composer.appendChild(sendBtn);

  var subRow = el("div", "sub");
  var humanBtn = el("button", "lnk", T.talkToHuman);
  attr(humanBtn, { type: "button" });
  if (!features.humanHandoff) humanBtn.hidden = true;
  var poweredBy = el("span", "pw", appearance.showPoweredBy ? T.poweredBy : "");
  subRow.appendChild(humanBtn);
  subRow.appendChild(poweredBy);

  footer.appendChild(composer);
  footer.appendChild(subRow);

  panel.appendChild(header);
  panel.appendChild(banner);
  panel.appendChild(body);
  panel.appendChild(footer);
  shadow.appendChild(panel);

  els = { panel: panel, body: body, footer: footer, textarea: textarea, sendBtn: sendBtn };

  // ── Networking ──────────────────────────────────────────────────

  function token() {
    return store.get("session");
  }

  function api(path, payload) {
    return boot.post("/api/shopify-chat" + path, payload || {}, token());
  }

  function apiGet(path) {
    return fetch(API + "/api/shopify-chat" + path, {
      headers: { "X-Visitor-Token": token() || "" },
      credentials: "omit",
      mode: "cors",
    }).then(function (res) {
      return res.json().then(function (json) {
        if (!res.ok) {
          var err = new Error(json.error || "request_failed");
          err.status = res.status;
          throw err;
        }
        return json;
      });
    });
  }

  function track(name, extra) {
    var e = { name: name };
    if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
    e.pageType = boot.context.pageType || null;
    api("/events", { events: [e] }).catch(function () {});
  }

  // ── Realtime ────────────────────────────────────────────────────
  //
  // socket.io when we can get it, adaptive polling when we cannot. The
  // fallback exists because a shopper on a locked-down network should
  // still get their answer, just a few seconds later.

  var ioPromise = null;
  function loadIO() {
    if (window.io) return Promise.resolve(window.io);
    if (ioPromise) return ioPromise;
    ioPromise = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = ASSETS + "/widget/vendor/socket.io.min.js";
      s.async = true;
      s.crossOrigin = "anonymous";
      s.onload = function () {
        window.io ? resolve(window.io) : reject(new Error("io_missing"));
      };
      s.onerror = function () { reject(new Error("io_failed")); };
      document.head.appendChild(s);
    });
    return ioPromise;
  }

  function connectRealtime() {
    if (!S.conversationId) return;
    if (socket && socket.connected) return;
    setConnection("connecting");
    loadIO()
      .then(function (io) {
        socket = io(API, {
          path: "/socket.io",
          transports: ["websocket", "polling"],
          auth: { visitorToken: token(), conversationId: S.conversationId },
          reconnectionDelay: 800,
          reconnectionDelayMax: 8000,
        });
        socket.on("connect", function () {
          setConnection("live");
          stopPolling();
          // A socket that reconnects after a gap has missed messages.
          // Catching up on connect is what makes "reconnect restores the
          // conversation" true rather than aspirational.
          catchUp();
        });
        socket.on("visitor:message", function (payload) {
          if (!payload || payload.conversationId !== S.conversationId) return;
          ingest([payload.message]);
        });
        socket.on("visitor:conversation", function (payload) {
          if (!payload || payload.conversationId !== S.conversationId) return;
          if (payload.isHandedOver) S.handedOver = true;
          if (payload.status === "CLOSED") S.ended = true;
          render();
        });
        socket.on("disconnect", function () {
          setConnection("reconnecting");
          startPolling(6000);
        });
        socket.on("connect_error", function () {
          setConnection("polling");
          startPolling(5000);
        });
      })
      .catch(function () {
        setConnection("polling");
        startPolling(5000);
      });
  }

  function setConnection(next) {
    if (S.connection === next) return;
    S.connection = next;
    renderBanner();
  }

  function startPolling(intervalMs) {
    stopPolling();
    pollTimer = setInterval(catchUp, intervalMs);
  }
  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function catchUp() {
    if (!token()) return Promise.resolve();
    var q = S.lastCursor ? "?after=" + encodeURIComponent(S.lastCursor) : "";
    return apiGet("/messages" + q)
      .then(function (res) {
        var data = res.data || {};
        if (data.conversationId) {
          S.conversationId = data.conversationId;
          store.set("conversation", data.conversationId);
        }
        if (data.isHandedOver) S.handedOver = true;
        if (data.status === "CLOSED") S.ended = true;
        ingest(data.messages || []);
      })
      .catch(function (err) {
        if (err && err.status === 429) {
          S.rateLimited = true;
          renderBanner();
        }
      });
  }

  /**
   * Fold server messages into local state.
   *
   * Dedupes on id, and resolves optimistic sends: when the shopper's own
   * message comes back from the server, the local placeholder is removed
   * rather than leaving the message on screen twice.
   */
  function ingest(incoming) {
    if (!incoming || !incoming.length) return;
    var known = {};
    S.messages.forEach(function (m) { known[m.id] = true; });
    var added = 0;
    incoming.forEach(function (m) {
      if (!m || known[m.id]) return;
      known[m.id] = true;
      if (m.direction === "INBOUND") {
        var idx = -1;
        for (var i = 0; i < S.pending.length; i++) {
          if (S.pending[i].body.trim() === String(m.body || "").trim()) { idx = i; break; }
        }
        if (idx >= 0) S.pending.splice(idx, 1);
      } else {
        S.awaitingReply = false;
        if (!S.opened) S.unread++;
      }
      S.messages.push(m);
      S.lastCursor = m.createdAt;
      added++;
    });
    if (!added) return;
    S.messages.sort(function (a, b) {
      return new Date(a.createdAt) - new Date(b.createdAt);
    });
    if (!S.opened && boot.setUnread) boot.setUnread(S.unread);
    render();
  }

  // ── Rendering ───────────────────────────────────────────────────

  function renderStatus() {
    var offline = boot.availability === "offline";
    statusDot.setAttribute("data-off", offline ? "1" : "0");
    statusText.textContent = offline ? T.offline : T.online;
  }

  function renderBanner() {
    var kind = null;
    var text = "";
    if (S.rateLimited) { kind = "warn"; text = T.rateLimited; }
    else if (S.ended) { kind = "info"; text = T.ended; }
    else if (S.error) { kind = "err"; text = S.error; }
    else if (S.connection === "reconnecting") { kind = "warn"; text = T.reconnecting; }
    else if (S.handedOver && !hasAgentMessage()) { kind = "info"; text = T.waitingAgent; }

    if (!kind) { banner.hidden = true; return; }
    banner.hidden = false;
    banner.setAttribute("data-kind", kind);
    banner.textContent = text;
  }

  function hasAgentMessage() {
    return S.messages.some(function (m) { return m.authorKind === "agent"; });
  }

  function render() {
    renderStatus();
    renderBanner();

    if (S.phase === "offline_form") { renderOfflineForm(); return; }
    if (!S.messages.length && !S.pending.length && S.phase === "welcome") { renderWelcome(); return; }
    renderMessages();
  }

  function renderWelcome() {
    footer.hidden = false;
    var wrap = el("div", "wel");
    var logoUrl = safeUrl(appearance.logoUrl);
    if (logoUrl) {
      var img = document.createElement("img");
      img.className = "wel-lg";
      img.src = logoUrl;
      img.alt = "";
      wrap.appendChild(img);
    }
    wrap.appendChild(el("h2", "wel-h", welcome.headline || ""));
    if (welcome.subline) wrap.appendChild(el("p", "wel-s", welcome.subline));

    if (boot.availability === "offline" && widget.offline && widget.offline.message) {
      var note = el("p", "wel-s", widget.offline.message);
      wrap.appendChild(note);
    }

    var questions = welcome.suggestedQuestions || [];
    if (questions.length) {
      var list = el("div", "sug");
      attr(list, { role: "group", "aria-label": T.startConversation });
      questions.forEach(function (q) {
        var b = el("button", "sug-b", q);
        attr(b, { type: "button" });
        on(b, "click", function () {
          track("suggested_question_clicked");
          submit(q);
        });
        list.appendChild(b);
      });
      wrap.appendChild(list);
    }

    if (boot.availability === "offline" && widget.offline && widget.offline.behavior === "form") {
      var toForm = el("button", "btn btn-p", T.submit);
      attr(toForm, { type: "button" });
      on(toForm, "click", function () { S.phase = "offline_form"; render(); });
      wrap.appendChild(toForm);
      footer.hidden = true;
    }

    clear(body).appendChild(wrap);
  }

  function renderMessages() {
    footer.hidden = false;
    var list = el("div", "msgs");

    S.messages.forEach(function (m) { list.appendChild(messageRow(m)); });
    S.pending.forEach(function (p) { list.appendChild(pendingRow(p)); });

    if (S.awaitingReply && !S.ended) {
      var typing = el("div", "row");
      attr(typing, { "data-me": "0" });
      var t = el("div", "typ");
      attr(t, { "aria-label": T.waitingAi });
      t.appendChild(el("i"));
      t.appendChild(el("i"));
      t.appendChild(el("i"));
      typing.appendChild(t);
      list.appendChild(typing);
    }

    clear(body).appendChild(list);
    scrollToEnd();
  }

  function messageRow(m) {
    var row = el("div", "row");
    attr(row, { "data-me": m.direction === "INBOUND" ? "1" : "0" });

    if (m.direction === "OUTBOUND" && m.author) {
      row.appendChild(el("div", "who", m.author));
    }
    if (m.commerce && m.commerce.products && m.commerce.products.length) {
      row.appendChild(
        m.commerce.products.length > 1
          ? carousel(m.commerce)
          : productCard(m.commerce.products[0], m.commerce.addToCartEnabled),
      );
      // Re-renders are frequent (every new message repaints the list);
      // the impression is the message, not the paint.
      if (!shownProducts[m.id]) {
        shownProducts[m.id] = true;
        track("product_shown", { productId: m.commerce.products[0].productId });
      }
      return row;
    }
    if (m.body) row.appendChild(el("div", "bub", m.body));
    return row;
  }

  function pendingRow(p) {
    var row = el("div", "row");
    attr(row, { "data-me": "1" });
    row.appendChild(el("div", "bub", p.body));
    row.appendChild(el("div", "mst", p.failed ? T.failed : "· · ·"));
    if (p.failed) {
      var retry = el("button", "lnk", T.retry);
      attr(retry, { type: "button" });
      on(retry, "click", function () {
        p.failed = false;
        render();
        deliver(p);
      });
      row.appendChild(retry);
    }
    return row;
  }

  // ── Product card ────────────────────────────────────────────────

  function productCard(product, addToCartAllowed) {
    var card = el("div", "card");
    var vState = {
      variantId: product.selectedVariantId || autoVariant(product),
      quantity: 1,
      busy: false,
      done: false,
      error: null,
    };

    function paint() {
      clear(card);
      var variant = findVariant(product, vState.variantId);

      var top = el("div", "card-top");
      var imgUrl = safeUrl(product.imageUrl);
      if (imgUrl) {
        var img = document.createElement("img");
        img.className = "card-im";
        img.src = imgUrl;
        img.alt = "";
        // Attributes, not properties: a browser that does not implement
        // the `loading` IDL still honours the attribute, and it is what
        // a merchant's own auditing tools will look for.
        img.setAttribute("loading", "lazy");
        img.setAttribute("decoding", "async");
        on(img, "error", function () { img.remove(); });
        top.appendChild(img);
      } else {
        top.appendChild(el("div", "card-im"));
      }

      var info = el("div", "card-in");
      info.appendChild(el("div", "card-ti", product.title));

      var priceRow = el("div", "card-pr");
      var price = variant && variant.price != null ? variant.price : product.price;
      var wasPrice =
        variant && variant.compareAtPrice != null ? variant.compareAtPrice : product.compareAtPrice;
      priceRow.appendChild(el("span", "pr", money(price, product.currency)));
      if (wasPrice && Number(wasPrice) > Number(price)) {
        priceRow.appendChild(el("span", "pr-was", money(wasPrice, product.currency)));
        priceRow.appendChild(el("span", "tag tag-sale", "-" +
          Math.round((1 - Number(price) / Number(wasPrice)) * 100) + "%"));
      }
      info.appendChild(priceRow);

      var purchasable = variant ? variant.available : product.available;
      if (!purchasable) info.appendChild(el("span", "tag tag-out", T.soldOut));
      if (product.published === false) info.appendChild(el("span", "tag tag-dr", T.notPublished));

      top.appendChild(info);
      card.appendChild(top);

      if (product.reason) card.appendChild(el("div", "why", product.reason));

      // Variant picker. A product with real options never gets an
      // arbitrary variant chosen for the shopper — Add to Cart stays
      // disabled until they pick one that actually exists.
      var needsChoice = (product.optionNames || []).length > 0 && product.variants.length > 1;
      if (needsChoice) {
        var opts = el("div", "opts");
        opts.appendChild(el("div", "opt-l", T.chooseOption));
        var chips = el("div", "chips");
        attr(chips, { role: "group", "aria-label": T.chooseOption });
        product.variants.forEach(function (v) {
          var chip = el("button", "chip", v.title);
          attr(chip, {
            type: "button",
            "aria-pressed": v.variantId === vState.variantId ? "true" : "false",
          });
          if (!v.available) {
            chip.disabled = true;
            attr(chip, { "aria-label": v.title + " — " + T.soldOut });
          }
          on(chip, "click", function () {
            vState.variantId = v.variantId;
            vState.error = null;
            vState.done = false;
            track("variant_selected", { productId: product.productId });
            paint();
          });
          chips.appendChild(chip);
        });
        opts.appendChild(chips);
        card.appendChild(opts);
      }

      var canAdd =
        addToCartAllowed &&
        features.addToCart &&
        !!variant &&
        variant.available &&
        !variant.requiresSellingPlan &&
        product.published !== false;

      if (canAdd) {
        var qtyRow = el("div", "qty");
        var minus = el("button", "qty-b", "−");
        attr(minus, { type: "button", "aria-label": T.quantity + " −" });
        minus.disabled = vState.quantity <= 1;
        var qtyVal = el("span", "qty-v", String(vState.quantity));
        attr(qtyVal, { "aria-live": "polite", "aria-label": T.quantity + " " + vState.quantity });
        var plus = el("button", "qty-b", "+");
        attr(plus, { type: "button", "aria-label": T.quantity + " +" });
        plus.disabled = vState.quantity >= 10;
        on(minus, "click", function () { vState.quantity = Math.max(1, vState.quantity - 1); paint(); });
        on(plus, "click", function () { vState.quantity = Math.min(10, vState.quantity + 1); paint(); });
        qtyRow.appendChild(minus);
        qtyRow.appendChild(qtyVal);
        qtyRow.appendChild(plus);
        card.appendChild(qtyRow);
      }

      var acts = el("div", "acts");
      if (addToCartAllowed && features.addToCart) {
        var add = el("button", "btn btn-p", vState.busy ? T.adding : T.addToCart);
        attr(add, { type: "button" });
        add.disabled = !canAdd || vState.busy;
        on(add, "click", function () { addToCart(product, vState, paint); });
        acts.appendChild(add);
      }
      var view = el("a", "btn btn-s", T.viewProduct);
      var href = safeUrl(product.productUrl);
      if (href) {
        attr(view, { href: href, target: "_top", rel: "noopener" });
        on(view, "click", function () { track("product_clicked", { productId: product.productId }); });
      }
      acts.appendChild(view);
      card.appendChild(acts);

      if (vState.done) {
        var ok = el("div", "cart-ok");
        ok.appendChild(el("span", null, "✓ " + T.added));
        card.appendChild(ok);
        var after = el("div", "acts");
        var cart = el("a", "btn btn-s", T.viewCart);
        attr(cart, { href: "/cart", target: "_top" });
        after.appendChild(cart);
        var keep = el("button", "btn btn-s", T.keepShopping);
        attr(keep, { type: "button" });
        on(keep, "click", function () { vState.done = false; paint(); });
        after.appendChild(keep);
        card.appendChild(after);
      }
      if (vState.error) card.appendChild(el("div", "cart-err", vState.error));
    }

    paint();
    return card;
  }

  function autoVariant(product) {
    // Only auto-select when there is genuinely nothing to choose: a
    // single-variant product. Otherwise the shopper picks.
    if (!product.variants || product.variants.length !== 1) return null;
    return product.variants[0].variantId;
  }

  function findVariant(product, variantId) {
    if (!variantId) return null;
    for (var i = 0; i < (product.variants || []).length; i++) {
      if (product.variants[i].variantId === variantId) return product.variants[i];
    }
    return null;
  }

  function carousel(commerce) {
    var wrap = el("div", "car");
    var strip = el("div", "car-tr");
    attr(strip, { role: "group", "aria-label": T.next, tabindex: "0" });
    commerce.products.forEach(function (p) {
      strip.appendChild(productCard(p, commerce.addToCartEnabled));
    });

    // Keyboard: the strip itself is focusable and arrow keys scroll it,
    // so a keyboard user is never stuck at a horizontal list they can
    // see but cannot move.
    on(strip, "keydown", function (e) {
      var step = 224;
      if (e.key === "ArrowRight") { strip.scrollLeft += step; e.preventDefault(); }
      if (e.key === "ArrowLeft") { strip.scrollLeft -= step; e.preventDefault(); }
    });

    var nav = el("div", "car-nav");
    var prev = el("button", "car-n", "‹");
    attr(prev, { type: "button", "aria-label": T.previous });
    var next = el("button", "car-n", "›");
    attr(next, { type: "button", "aria-label": T.next });
    on(prev, "click", function () { strip.scrollLeft -= 224; });
    on(next, "click", function () { strip.scrollLeft += 224; });
    nav.appendChild(prev);
    nav.appendChild(next);

    wrap.appendChild(strip);
    wrap.appendChild(nav);
    return wrap;
  }

  /**
   * Add to Cart, in two halves.
   *
   * The server half re-resolves the product and variant from Shopify and
   * answers with a variant id it is willing to stand behind. The browser
   * half posts that id to the THEME's own /cart/add.js — same origin,
   * the merchant's own cart, no Admin credential anywhere near the page,
   * and no order created from chat.
   */
  function addToCart(product, vState, repaint) {
    vState.busy = true;
    vState.error = null;
    repaint();
    track("add_to_cart_attempted", { productId: product.productId });

    api("/cart/validate", {
      productId: product.productId,
      variantId: vState.variantId,
      quantity: vState.quantity,
    })
      .then(function (res) {
        var v = res.data;
        return fetch("/cart/add.js", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ items: [{ id: Number(v.variantId), quantity: v.quantity }] }),
          credentials: "same-origin",
        }).then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (j) {
            if (!r.ok) throw new Error(j.description || j.message || T.failed);
            return j;
          });
        });
      })
      .then(function () {
        vState.busy = false;
        vState.done = true;
        repaint();
        api("/cart/result", { ok: true }).catch(function () {});
        notifyThemeCartChanged();
      })
      .catch(function (err) {
        vState.busy = false;
        // The server sends a shopper-safe sentence for the cases it
        // knows (out of stock, option gone, subscription-only). Anything
        // else stays generic — a raw Shopify error is not an answer.
        vState.error =
          (err && err.body && err.body.message) ||
          (err && err.status === 409 && err.message) ||
          T.failed;
        repaint();
        api("/cart/result", { ok: false }).catch(function () {});
      });
  }

  /**
   * Tell the theme its cart changed, using the events Shopify's own
   * Dawn-lineage themes and most app ecosystems already listen for. We
   * only ever *announce* — opening a merchant's cart drawer ourselves
   * would mean guessing at their markup and breaking themes we have
   * never seen.
   */
  function notifyThemeCartChanged() {
    try {
      document.dispatchEvent(new CustomEvent("cart:refresh", { bubbles: true }));
      document.dispatchEvent(new CustomEvent("cart:build", { bubbles: true }));
      if (window.Shopify && window.Shopify.onCartUpdate) {
        fetch("/cart.js", { credentials: "same-origin" })
          .then(function (r) { return r.json(); })
          .then(function (cart) { window.Shopify.onCartUpdate(cart); })
          .catch(function () {});
      }
    } catch (e) {}
  }

  // ── Offline lead form ───────────────────────────────────────────

  function renderOfflineForm() {
    footer.hidden = true;
    var offline = widget.offline || {};
    var form = el("form", "form");
    var fields = offline.formFields || ["name", "email", "message"];
    var inputs = {};

    if (offline.message) form.appendChild(el("p", "wel-s", offline.message));

    fields.forEach(function (f) {
      var label = el("label", "fl", T[f] || f);
      var input =
        f === "message" ? document.createElement("textarea") : document.createElement("input");
      input.className = "fi";
      if (f === "email") input.type = "email";
      if (f === "message") input.rows = 4;
      var id = "gotcha-f-" + f;
      input.id = id;
      label.setAttribute("for", id);
      inputs[f] = input;
      form.appendChild(label);
      form.appendChild(input);
    });

    var consentBox = null;
    if (offline.consentRequired) {
      var wrap = el("label", "cbx");
      consentBox = document.createElement("input");
      consentBox.type = "checkbox";
      wrap.appendChild(consentBox);
      wrap.appendChild(el("span", null, offline.consentText || T.consent));
      form.appendChild(wrap);
    }

    var submitBtn = el("button", "btn btn-p", T.submit);
    attr(submitBtn, { type: "submit" });
    form.appendChild(submitBtn);

    var errLine = el("div", "cart-err", "");
    errLine.hidden = true;
    form.appendChild(errLine);

    on(form, "submit", function (e) {
      e.preventDefault();
      if (consentBox && !consentBox.checked) {
        errLine.hidden = false;
        errLine.textContent = offline.consentText || T.consent;
        return;
      }
      submitBtn.disabled = true;
      ensureConversation()
        .then(function () {
          return api("/lead", {
            name: inputs.name ? inputs.name.value : "",
            email: inputs.email ? inputs.email.value : "",
            message: inputs.message ? inputs.message.value : "",
            consent: consentBox ? consentBox.checked : true,
          });
        })
        .then(function () {
          clear(body).appendChild(el("p", "note", T.submitted));
        })
        .catch(function () {
          submitBtn.disabled = false;
          errLine.hidden = false;
          errLine.textContent = T.failed;
        });
    });

    clear(body).appendChild(form);
  }

  // ── Sending ─────────────────────────────────────────────────────

  function clientId() {
    var bytes = new Uint8Array(9);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    return Array.prototype.map
      .call(bytes, function (b) { return ("0" + b.toString(16)).slice(-2); })
      .join("");
  }

  function ensureConversation() {
    if (S.conversationId) return Promise.resolve(S.conversationId);
    return api("/conversation", {}).then(function (res) {
      var data = res.data || {};
      S.conversationId = data.conversationId;
      if (S.conversationId) store.set("conversation", S.conversationId);
      S.handedOver = !!data.isHandedOver;
      S.ended = data.status === "CLOSED";
      ingest(data.messages || []);
      connectRealtime();
      return S.conversationId;
    });
  }

  function submit(text) {
    var body = String(text || "").trim();
    if (!body || S.ended) return;
    var entry = { clientId: clientId(), body: body, failed: false };
    S.pending.push(entry);
    S.phase = "active";
    S.awaitingReply = true;
    S.rateLimited = false;
    textarea.value = "";
    autoGrow();
    render();
    if (!S.messages.length && S.pending.length === 1) track("conversation_started");
    deliver(entry);
  }

  function deliver(entry) {
    ensureConversation()
      .then(function () {
        return api("/message", {
          body: entry.body,
          clientId: entry.clientId,
          context: boot.context,
        });
      })
      .then(function () {
        // Nudge once shortly after: the bot's reply arrives over the
        // socket, but a slow model plus a dropped frame should not leave
        // the shopper staring at a typing indicator forever.
        setTimeout(catchUp, 1500);
        setTimeout(catchUp, 6000);
      })
      .catch(function (err) {
        S.awaitingReply = false;
        if (err && err.status === 429) {
          S.rateLimited = true;
          entry.failed = true;
        } else if (err && err.status === 401) {
          // Session expired — re-bootstrap silently on the next open.
          store.del("session");
          store.del("conversation");
          entry.failed = true;
        } else {
          entry.failed = true;
        }
        render();
      });
  }

  // ── Composer behaviour ──────────────────────────────────────────

  function autoGrow() {
    textarea.style.height = "auto";
    textarea.style.height = Math.min(120, textarea.scrollHeight) + "px";
    sendBtn.disabled = !textarea.value.trim();
  }

  on(textarea, "input", autoGrow);
  on(textarea, "keydown", function (e) {
    // Enter sends; Shift+Enter is a newline. On touch keyboards Enter is
    // usually a newline key, so we only intercept when a real keyboard
    // is plausible.
    if (e.key === "Enter" && !e.shiftKey && !window.matchMedia("(max-width: 560px)").matches) {
      e.preventDefault();
      submit(textarea.value);
    }
  });
  on(composer, "submit", function (e) {
    e.preventDefault();
    submit(textarea.value);
  });
  on(humanBtn, "click", function () {
    ensureConversation()
      .then(function () { return api("/handoff", {}); })
      .then(function () {
        S.handedOver = true;
        render();
      })
      .catch(function () {});
  });

  function scrollToEnd() {
    requestAnimationFrame(function () {
      body.scrollTop = body.scrollHeight;
    });
  }

  // ── Mobile keyboard ─────────────────────────────────────────────
  //
  // On iOS the visual viewport shrinks under the keyboard while the
  // layout viewport does not, which is exactly how a chat input ends up
  // hidden behind the keys. Tracking visualViewport keeps the composer
  // reachable without hacks like scroll-locking the page.
  if (window.visualViewport) {
    var vv = window.visualViewport;
    var applyViewport = function () {
      if (!window.matchMedia("(max-width: 560px)").matches) {
        panel.style.height = "";
        return;
      }
      panel.style.height = vv.height + "px";
      scrollToEnd();
    };
    vv.addEventListener("resize", applyViewport);
    vv.addEventListener("scroll", applyViewport);
  }

  // ── Focus + dismissal ───────────────────────────────────────────

  function focusables() {
    return Array.prototype.filter.call(
      panel.querySelectorAll("button, a[href], textarea, input, [tabindex]:not([tabindex='-1'])"),
      function (n) { return !n.disabled && n.offsetParent !== null; },
    );
  }

  on(panel, "keydown", function (e) {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
      return;
    }
    // Focus stays inside the panel while it is open, but the shopper is
    // never trapped: Escape and the close button both return them to the
    // storefront, and the panel is not aria-modal so the page behind it
    // remains reachable by browser chrome.
    if (e.key !== "Tab") return;
    var items = focusables();
    if (!items.length) return;
    var first = items[0];
    var last = items[items.length - 1];
    var active = shadow.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  });

  on(closeBtn, "click", close);

  function open() {
    panel.hidden = false;
    S.opened = true;
    S.unread = 0;
    if (boot.setUnread) boot.setUnread(0);
    if (boot.onOpened) boot.onOpened();
    track("widget_opened");

    var restore = S.conversationId
      ? api("/conversation", {}).then(function (res) {
          var data = res.data || {};
          S.conversationId = data.conversationId || S.conversationId;
          if (S.conversationId) store.set("conversation", S.conversationId);
          S.handedOver = !!data.isHandedOver;
          S.ended = data.status === "CLOSED";
          S.phase = (data.messages || []).length ? "active" : "welcome";
          ingest(data.messages || []);
          connectRealtime();
        })
      : Promise.resolve();

    restore
      .catch(function (err) {
        if (err && err.status === 401) {
          store.del("session");
          store.del("conversation");
          S.conversationId = null;
        }
      })
      .then(function () {
        render();
        setTimeout(function () {
          var target = S.phase === "welcome" ? focusables()[0] : textarea;
          try { (target || closeBtn).focus({ preventScroll: true }); } catch (e) {}
        }, 60);
      });
  }

  function close() {
    panel.hidden = true;
    S.opened = false;
    track("widget_closed");
    // Keep the socket while a conversation is live so an agent's reply
    // still raises the badge; drop the poll timer either way.
    stopPolling();
    if (!S.conversationId && socket) {
      socket.disconnect();
      socket = null;
    }
    if (boot.onClosed) boot.onClosed();
  }

  /**
   * Returning shopper with an open conversation: connect, catch up once,
   * and let the badge do the talking. No panel, no polling loop.
   */
  function watchInBackground() {
    if (!S.conversationId) return;
    catchUp().then(function () {
      S.unread = 0;
      var lastRead = Number(store.get("lastRead") || 0);
      S.messages.forEach(function (m) {
        if (m.direction === "OUTBOUND" && new Date(m.createdAt).getTime() > lastRead) S.unread++;
      });
      if (boot.setUnread) boot.setUnread(S.unread);
      connectRealtime();
    });
  }

  window.addEventListener("beforeunload", function () {
    store.set("lastRead", String(Date.now()));
  });

  render();

  return { open: open, close: close, watchInBackground: watchInBackground };
};
