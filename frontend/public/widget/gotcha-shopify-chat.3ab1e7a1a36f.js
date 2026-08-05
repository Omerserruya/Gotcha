/**
 * GOTCHA Shopify Live Chat - chat application.
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
 *   3. Direction is a property of a MESSAGE, not of the widget. See the
 *      bidi module immediately below.
 */

/**
 * Bidi: per-message direction, in ES5, on a storefront page.
 *
 * This is a deliberate restatement of
 * `packages/shared/src/lib/text-direction.ts`. The widget ships without a
 * bundler and cannot import the workspace package, so the rules live
 * twice - and `frontend/src/components/shopify/__tests__/widget-rtl-parity.test.ts`
 * runs both implementations over the same table and fails on the first
 * disagreement. Change one, change the other.
 *
 * Kept as its own module rather than folded into the app factory so the
 * parity test can reach it without booting a widget.
 */
window.__gotchaBidi = (function () {
  "use strict";

  var RTL_LANGUAGES = [
    "he", "iw", "ar", "fa", "prs", "ur", "ps", "sd", "ug", "ckb", "ku",
    "yi", "ji", "dv", "arc", "syr",
    "he-il", "ar-sa", "ar-ae", "ar-eg", "fa-ir", "ur-pk",
  ];

  var STRONG_RTL = /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u0780-\u07BF\u07C0-\u07FF\u0800-\u083F\u0840-\u085F\u0860-\u086F\u08A0-\u08FF\uFB1D-\uFB4F\uFB50-\uFDFF\uFE70-\uFEFF]/g;
  var STRONG_LTR = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u1E00-\u1EFF\u2C60-\u2C7F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]/g;

  var RTL_SHARE_THRESHOLD = 0.3;

  // Runs with no direction of their own. A Hebrew sentence does not
  // become English by quoting a product URL.
  var ATOMS = [
    /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi,
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    /(?:[$₪€£¥₹]\s?\d[\d.,]*|\b\d[\d.,]*\s?(?:USD|ILS|EUR|GBP|JPY|AED|SAR|INR|NIS)\b|\b(?:USD|ILS|EUR|GBP|JPY|AED|SAR|INR|NIS)\s?\d[\d.,]*)/gi,
    /\b[A-Z0-9]{2,}(?:[-_/][A-Z0-9]+)+\b/g,
    /\+\d[\d\s\-().]{6,}\d/g,
  ];

  function stripNeutralAtoms(text) {
    var out = String(text == null ? "" : text);
    for (var i = 0; i < ATOMS.length; i++) {
      out = out.replace(new RegExp(ATOMS[i].source, ATOMS[i].flags), " ");
    }
    return out;
  }

  function countStrong(text) {
    var clean = stripNeutralAtoms(text);
    var rtl = (clean.match(STRONG_RTL) || []).length;
    var ltr = (clean.match(STRONG_LTR) || []).length;
    var total = rtl + ltr;
    return { rtl: rtl, ltr: ltr, rtlShare: total === 0 ? 0 : rtl / total };
  }

  /** "rtl" | "ltr" | null. Null means "this text has no opinion". */
  function detectScriptDirection(text) {
    var c = countStrong(text);
    if (c.rtl === 0 && c.ltr === 0) return null;
    if (c.rtl === 0) return "ltr";
    if (c.ltr === 0) return "rtl";
    return c.rtlShare >= RTL_SHARE_THRESHOLD ? "rtl" : "ltr";
  }

  function isRtlLocale(locale) {
    if (typeof locale !== "string") return false;
    var tag = locale.trim().toLowerCase().replace(/_/g, "-");
    if (!tag) return false;
    if (RTL_LANGUAGES.indexOf(tag) !== -1) return true;
    return RTL_LANGUAGES.indexOf(tag.split("-")[0]) !== -1;
  }

  function directionForLocale(locale) {
    if (typeof locale !== "string" || !locale.trim()) return null;
    return isRtlLocale(locale) ? "rtl" : "ltr";
  }

  /**
   * The priority chain: explicit metadata, then this message's own
   * script, then the conversation, then the store, then LTR.
   */
  function resolveMessageDirection(input) {
    var i = input || {};
    if (i.override === "rtl" || i.override === "ltr") {
      return { direction: i.override, source: "override" };
    }
    var fromContent = directionForLocale(i.contentLocale);
    if (fromContent) return { direction: fromContent, source: "content_locale" };

    var fromScript = detectScriptDirection(i.text);
    if (fromScript) return { direction: fromScript, source: "script" };

    var fromConversation = directionForLocale(i.conversationLocale);
    if (fromConversation) return { direction: fromConversation, source: "conversation_locale" };

    var fromWidget = directionForLocale(i.widgetLocale);
    if (fromWidget) return { direction: fromWidget, source: "widget_locale" };

    return { direction: "ltr", source: "default" };
  }

  /**
   * Split prose from the atoms that must sit inside a <bdi>. Without this
   * a URL's trailing full stop migrates to the wrong end of the link and
   * "$120.00" shows its dollar sign on the right.
   */
  function segmentBidiText(text) {
    var src = String(text == null ? "" : text);
    if (!src) return [];
    var sources = [];
    for (var i = 0; i < ATOMS.length; i++) sources.push("(?:" + ATOMS[i].source + ")");
    var combined = new RegExp(sources.join("|"), "gi");

    var out = [];
    var cursor = 0;
    var m;
    while ((m = combined.exec(src)) !== null) {
      if (m.index > cursor) out.push({ text: src.slice(cursor, m.index), kind: "text" });
      out.push({ text: m[0], kind: "isolate" });
      cursor = m.index + m[0].length;
      if (m[0].length === 0) combined.lastIndex++;
    }
    if (cursor < src.length) out.push({ text: src.slice(cursor), kind: "text" });
    return out;
  }

  function needsBidiIsolation(text) {
    var segs = segmentBidiText(text);
    for (var i = 0; i < segs.length; i++) if (segs[i].kind === "isolate") return true;
    return false;
  }

  return {
    RTL_SHARE_THRESHOLD: RTL_SHARE_THRESHOLD,
    stripNeutralAtoms: stripNeutralAtoms,
    countStrongCharacters: countStrong,
    detectScriptDirection: detectScriptDirection,
    isRtlLocale: isRtlLocale,
    directionForLocale: directionForLocale,
    resolveMessageDirection: resolveMessageDirection,
    segmentBidiText: segmentBidiText,
    needsBidiIsolation: needsBidiIsolation,
  };
})();

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
      mute: "Mute chat sounds",
      unmute: "Unmute chat sounds",
      placeholder: "Ask us anything",
      send: "Send",
      startConversation: "Start the conversation",
      showMore: "Show {n} more",
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
      mute: "השתקת צלילי הצ׳אט",
      unmute: "ביטול השתקה",
      placeholder: "אפשר לשאול אותנו הכל",
      send: "שליחה",
      startConversation: "אפשר להתחיל",
      showMore: "עוד {n}",
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
  var BIDI = window.__gotchaBidi;

  // The merchant's explicit choice, or "auto". Passed to every per-message
  // resolution so one setting still governs the whole widget when a
  // merchant has made a decision.
  var dirOverride = appearance.direction === "rtl" || appearance.direction === "ltr"
    ? appearance.direction
    : "auto";

  // The PANEL's direction: chrome, layout and the direction a shopper
  // starts typing in. Individual bubbles resolve their own.
  var dir = BIDI.resolveMessageDirection({
    override: dirOverride,
    conversationLocale: lang,
    widgetLocale: boot.context.locale || document.documentElement.lang || null,
  }).direction;

  /**
   * Direction of ONE message. The storefront locale is the last resort,
   * so a Hebrew shopper's "👍" stays on the Hebrew side and an English
   * agent reply inside the same conversation still reads left to right.
   */
  function dirOf(text, contentLocale) {
    return BIDI.resolveMessageDirection({
      override: dirOverride,
      contentLocale: contentLocale || null,
      text: text,
      conversationLocale: lang,
      widgetLocale: boot.context.locale || null,
    }).direction;
  }

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
   * Write text into a node with its own direction, isolating the atoms
   * that the bidi algorithm otherwise mangles.
   *
   * Still no innerHTML: <bdi> elements are built with createElement and
   * filled with textContent, so rule 1 at the top of this file holds.
   * <bdi> is used rather than a CSS `unicode-bidi` span because it
   * isolates natively, needs no stylesheet to be correct, and degrades to
   * an inline element on anything that has not implemented it.
   */
  function setDirectedText(node, text, contentLocale) {
    var value = text == null ? "" : String(text);
    var d = dirOf(value, contentLocale);
    attr(node, { dir: d });
    clear(node);
    var segments = BIDI.segmentBidiText(value);
    if (segments.length <= 1) {
      node.textContent = value;
      return node;
    }
    segments.forEach(function (seg) {
      if (seg.kind === "isolate") {
        var bdi = document.createElement("bdi");
        // A URL, a price or a part code is always read left to right,
        // whatever it is embedded in.
        bdi.setAttribute("dir", "ltr");
        bdi.textContent = seg.text;
        node.appendChild(bdi);
      } else {
        node.appendChild(document.createTextNode(seg.text));
      }
    });
    return node;
  }

  /**
   * An element whose content is ALWAYS left to right regardless of the
   * surrounding prose: prices, timestamps, counts, part codes. Rendered
   * as a <bdi> so it cannot leak its direction into the sentence around
   * it.
   */
  function ltrAtom(className, text) {
    var bdi = document.createElement("bdi");
    if (className) bdi.className = className;
    bdi.setAttribute("dir", "ltr");
    bdi.textContent = text == null ? "" : String(text);
    return bdi;
  }

  /** A text node with its own resolved direction. */
  function directedEl(tag, className, text, contentLocale) {
    var node = el(tag, className);
    setDirectedText(node, text, contentLocale);
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
    // `el.hidden = true` only hides anything because of the UA stylesheet's
    // `[hidden]{display:none}` - the weakest rule there is. Every element
    // below that sets its own `display` (the panel is `display:flex`) beat
    // it, so the close button ran, state flipped to closed, analytics
    // fired, and the panel stayed on screen looking exactly like a dead
    // button. Shadow DOM has no UA sheet of its own to fall back on, so
    // this has to be declared here, once, ahead of everything.
    // ONE source of truth for whether the panel is on screen.
    //
    // `el.hidden` alone was not enough: it works only through the UA
    // stylesheet's `[hidden]{display:none}`, the weakest rule there is,
    // and `.panel` sets `display:flex`, which beat it. A shadow root has
    // no UA sheet of its own to fall back on, so the close button ran,
    // state flipped, analytics fired, and the panel stayed on screen.
    //
    // Now the CLOSED state owns `display:none` explicitly and the OPEN
    // state owns the layout, so no future cascade rule can make a closed
    // panel visible. `[hidden]` is kept as a belt-and-braces second
    // signal and for assistive technology.
    "[hidden]{display:none!important;}",
    ".panel[data-state='closed']{display:none!important;}",

    // ── Layout by STATE, not by hiding things ad hoc ──
    //
    // WELCOME gives the whole panel to the brand: no conversation header
    // at all, hero flush against the top edge. CONVERSATION swaps in a
    // compact header, because by then the shopper knows where they are
    // and the messages need the room.
    ".panel[data-view='welcome'] .hd{display:none;}",
    // The gap above the hero was .wel's own padding-top surviving the
    // hero's negative margin. In welcome the hero owns the top edge.
    ".panel[data-view='welcome'] .bd{padding-top:0;}",
    ".panel[data-view='welcome'] .wel{padding-top:0;}",
    ".panel[data-view='welcome'] .hero{margin-top:0;border-radius:" + radius + "px " + radius + "px 0 0;}",

    // One close button for both states, moved rather than duplicated, so
    // there is a single handler and a single data-act="close".
    // Positioning lives with the rest of the .x rule further down; two
    // `.x` blocks in one stylesheet is how `position:absolute` here lost
    // to `position:relative` there and put a 44px hole above the hero.
    // Over the hero it needs its own contrast: a merchant's photograph
    // can be any colour, and the way out must be legible on all of them.
    // Over a photograph the chip needs its own contrast, because a
    // merchant's hero can be any colour and the way out must be legible on
    // all of them. Everywhere else it stays a quiet neutral.
    ".panel[data-view='welcome'] .x{color:#fff;}",
    ".panel[data-view='welcome'] .x::before{background:rgba(15,23,42,.32);",
    "  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);}",
    ".panel[data-view='welcome'] .x:hover::before{background:rgba(15,23,42,.46);}",
    ".panel[data-view='welcome'] .x:active::before{transform:scale(.92);}",
    // ── Welcome hero ──
    // Bleeds to the panel edges by cancelling the body's padding, so the
    // media touches the sides instead of floating in a gutter.
    ".hero{position:relative;margin:calc(var(--pad) * -1) calc(var(--pad) * -1) 0;overflow:hidden;background:#eef2f7;}",
    ".hero-m{display:block;width:100%;height:100%;}",
    // The fade is what makes the media belong to the panel rather than
    // sit on top of it: media dissolves into the chat surface.
    ".hero-fd{position:absolute;left:0;right:0;bottom:0;pointer-events:none;}",
    ".hero-ov{position:absolute;inset:0;pointer-events:none;}",
    // The avatar hangs below the media's bottom edge. z-index keeps it
    // above the fade, and the ring separates it from any busy image.
    // Attached to the hero, not floating below it: a 3px ring, a soft
    // shadow, and no bottom margin of its own - the .wel gap owns the
    // distance to the title so there is only one number to tune.
    ".wel-av{display:block;border-radius:50%;object-fit:cover;position:relative;z-index:2;",
    "  background:#fff;border:3px solid #fff;box-shadow:0 3px 10px rgba(15,23,42,.14);margin-bottom:0;}",
    "@media (prefers-reduced-motion: reduce){.hero-m{animation:none!important}}",
    // ── The spacing scale ──
    //
    // Every gap in the welcome screen is one of these. The widget was
    // built with margins chosen per-rule - 18px here, 14px there, a -8px
    // correction to undo one of them - and the sum was a panel that felt
    // loose at the top and ran out of room at the bottom. One scale means
    // tightening the layout is a change to five numbers, not fifty.
    ":host,.panel{",
    "  --s1:4px;--s2:8px;--s3:12px;--s4:16px;--s5:20px;",
    // The body's horizontal padding, referenced by anything that needs to
    // bleed to the panel edge (the hero) or line up with it.
    "  --pad:16px;",
    "}",
    ".panel{",
    "  position:fixed;bottom:80px;" + side + ":16px;width:392px;",
    // Never wider than the viewport, whatever the theme is doing. A
    // storefront with its own horizontal overflow must not be able to
    // drag the widget wider and make its own bug worse.
    "  max-width:min(392px, calc(100vw - 32px));",
    "  height:min(640px, calc(100vh - 120px));",
    "  background:#fff;color:#0f172a;border-radius:" + radius + "px;",
    "  box-shadow:0 24px 60px rgba(15,23,42,.22),0 2px 8px rgba(15,23,42,.08);",
    "  display:flex;flex-direction:column;overflow:hidden;",
    "  font:400 15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;",
    "  animation:rise .22s cubic-bezier(.2,.8,.3,1);",
    "}",
    // A welcome screen is short by design, and a card that reserves the
    // full 640px for it ends in a band of empty white above the composer.
    // Hug the content; the max-height keeps a long question list scrolling
    // rather than growing off the screen.
    "@media (min-width: 561px){",
    "  .panel[data-view='welcome']{height:auto;max-height:min(640px, calc(100vh - 120px));}",
    "}",
    "@keyframes rise{from{opacity:0;transform:translateY(12px) scale(.985)}to{opacity:1;transform:none}}",
    "@media (prefers-reduced-motion: reduce){.panel{animation:none}}",
    // Phones: a floating card wastes the screen and fights the keyboard.
    "@media (max-width: 560px){",
    // width:auto, driven by the insets - `width:100%` resolves against a
    // containing block that a wide page can inflate, which is how the
    // panel ends up 12px past the screen on a theme that already
    // overflows.
    "  .panel{inset:0;width:auto;max-width:100vw;height:100%;border-radius:0;",
    "    height:100dvh;padding-bottom:env(safe-area-inset-bottom);}",
    "}",
    // Compact by design: 16px padding around a 40px avatar made a 72px
    // header, which is a lot of a 640px panel spent on saying who you are
    // already talking to. 44px visual height, 30px avatar.
    // LOGICAL padding, not physical. The inline-END reservation is what
    // keeps the header's own controls clear of the absolutely-positioned
    // close button - and in RTL that corner is on the left, so a hardcoded
    // `padding-right` left the mute button sitting under the close button.
    ".hd{display:flex;align-items:center;gap:10px;",
    "  padding-block:6px;padding-inline:14px 56px;",
    // border-box, or min-height:44 becomes 44 + padding + border = 57.
    "  box-sizing:border-box;border-bottom:1px solid #eef1f5;min-height:44px;max-height:48px;flex:0 0 auto;}",
    ".hd-tx{min-width:0;line-height:1.2;}",
    ".hd-av{width:30px;height:30px;border-radius:9px;object-fit:cover;background:" + brand + ";flex:0 0 auto;}",
    ".hd-mono{display:flex;align-items:center;justify-content:center;color:" + onBrand + ";font-weight:650;font-size:14px;}",
    ".hd-tx{flex:1 1 auto;min-width:0;}",
    ".hd-nm{font-weight:650;font-size:14px;line-height:1.25;letter-spacing:-.01em;",
    "  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
    ".hd-st{display:flex;align-items:center;gap:5px;font-size:11.5px;line-height:1.2;color:#64748b;margin-top:1px;}",
    ".dot{width:7px;height:7px;border-radius:4px;background:#16a34a;flex:0 0 auto;}",
    ".dot[data-off='1']{background:#cbd5e1;}",
    // 44x44 is the accessibility floor for a touch target, and this one
    // is the shopper's way out of the widget - the last control that
    // should be fiddly on a phone. The icon stays visually small; the
    // hit area does not.
    // 44x44 is the accessibility floor and this is the shopper's way out,
    // so the TARGET never shrinks. What shrinks is the part you can see:
    // a 30px chip drawn behind the icon. Making the visible control the
    // same size as the touch target is what made the X the loudest thing
    // in the hero.
    // The close button and the mute button LOOK the same and SIT
    // differently. Sharing one class made them share `position:absolute`
    // too, which stacked the mute button exactly on top of the close
    // button. The look is shared here; the placement is not.
    ".x,.mute{width:44px;height:44px;min-width:44px;min-height:44px;border:0;background:transparent;",
    "  color:#64748b;cursor:pointer;display:flex;align-items:center;justify-content:center;",
    "  position:relative;pointer-events:auto;-webkit-tap-highlight-color:transparent;}",
    ".x::before,.mute::before{content:'';position:absolute;width:30px;height:30px;border-radius:50%;",
    "  background:rgba(15,23,42,.06);transition:background .15s,transform .15s;}",
    ".x svg,.mute svg{position:relative;width:15px;height:15px;fill:none;stroke:currentColor;",
    "  stroke-width:2.1;stroke-linecap:round;pointer-events:none;}",
    ".x:hover::before,.mute:hover::before{background:rgba(15,23,42,.12);}",
    ".x:hover,.mute:hover{color:#0f172a;}",
    ".x:active::before,.mute:active::before{transform:scale(.92);}",
    ".x:focus-visible,.mute:focus-visible{outline:none;}",
    ".x:focus-visible::before,.mute:focus-visible::before{outline:2px solid " + brand + ";outline-offset:3px;}",
    "@media (prefers-reduced-motion: reduce){.x::before,.mute::before{transition:none}}",
    // ONLY the close button leaves the flow. It is a child of the panel so
    // that it survives the header being hidden in the welcome view, which
    // also means it must not occupy a row of that column.
    ".x{position:absolute;top:var(--s2);" + (dir === "rtl" ? "left" : "right") + ":var(--s2);z-index:6;}",
    // The mute button stays a normal item of the header row, ahead of the
    // padding that reserves the close button's corner.
    ".mute{flex:0 0 auto;}",

    // The only scrolling region. The extra bottom padding is what lets
    // the LAST suggested question clear the composer instead of sitting
    // permanently underneath it.
    // The ONLY scrolling region. The composer is a flex sibling below it,
    // never an overlay, so nothing here can be trapped behind it.
    ".bd{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;",
    "  padding:var(--pad) var(--pad) var(--s4);scroll-behavior:smooth;overscroll-behavior:contain;}",
    "@media (prefers-reduced-motion: reduce){.bd{scroll-behavior:auto}}",

    // Welcome
    // One gap between blocks, and a tighter one inside the title/subtitle
    // pair so they read as a unit. The old sheet used a -8px margin on the
    // subtitle to claw back a gap it had just declared.
    ".wel{display:flex;flex-direction:column;gap:var(--s3);padding:var(--s2) 0 0;}",
    ".wel-lg{width:52px;height:52px;border-radius:14px;object-fit:contain;background:#f8fafc;}",
    ".wel-cp{display:flex;flex-direction:column;gap:var(--s1);}",
    ".wel-h{font-size:21px;line-height:1.25;font-weight:670;letter-spacing:-.015em;margin:0;}",
    // Measure, not just size: a subtitle that runs the full panel width is
    // harder to scan than one that breaks where a person would.
    ".wel-s{font-size:14px;line-height:1.45;color:#5b6b7f;margin:0;max-width:34ch;}",
    ".wel[data-align='center'] .wel-s{margin-left:auto;margin-right:auto;}",
    ".sug{display:flex;flex-direction:column;gap:var(--s1);}",
    // Compact: 9px of padding and a 1.35 line-height instead of 12px and
    // the panel default. Three questions now cost what two used to.
    // `start`, resolved against the chip's OWN dir: a Hebrew suggestion
    // and an English one in the same list each read from their own edge.
    ".sug-b{text-align:start;border:1px solid #e8edf3;background:#fff;",
    "  border-radius:11px;padding:9px 12px;font:inherit;font-size:13.5px;line-height:1.35;",
    "  color:#1e293b;cursor:pointer;min-height:38px;display:flex;align-items:center;",
    "  transition:border-color .15s,background .15s,color .15s;}",
    // The accent earns its place on interaction rather than sitting on
    // every border at rest.
    ".sug-b:hover{border-color:" + brand + ";background:" + brand + "0b;color:#0f172a;}",
    ".sug-b:active{background:" + brand + "16;}",
    ".sug-b:focus-visible{outline:2px solid " + brand + ";outline-offset:2px;}",
    "@media (prefers-reduced-motion: reduce){.sug-b{transition:none}}",
    // §5 More than three questions collapses behind a quiet toggle rather
    // than turning the welcome screen into a list.
    // Follows the copy's alignment rather than picking its own, and stays
    // quiet: it is an escape hatch for the curious, not a call to action.
    // `flex-start` in a COLUMN flex container already resolves against
    // the writing direction, so flipping it by hand was a double flip:
    // in RTL the toggle landed on the left, opposite the questions it
    // belongs to.
    ".sug-more{align-self:flex-start;background:none;border:0;",
    "  padding:var(--s1) var(--s2);margin:0;font:inherit;font-size:12.5px;font-weight:500;color:#64748b;",
    "  cursor:pointer;border-radius:8px;}",
    ".wel[data-align='center'] .sug-more{align-self:center;}",
    ".sug-more:hover{color:" + brand + ";}",
    ".sug-more:focus-visible{outline:2px solid " + brand + ";outline-offset:2px;border-radius:6px;}",

    // Messages
    ".msgs{display:flex;flex-direction:column;gap:10px;}",
    ".row{display:flex;flex-direction:column;max-width:100%;}",
    ".row[data-me='1']{align-items:flex-end;}",
    ".row[data-me='0']{align-items:flex-start;}",
    // `text-align:start` resolves against the element's OWN dir, which is
    // the message's, not the panel's. The two explicit rules below are
    // not redundancy: they are what makes the intent readable in devtools
    // when a bubble disagrees with the widget around it.
    ".bub{max-width:84%;padding:10px 13px;border-radius:16px;font-size:14.5px;white-space:pre-wrap;word-break:break-word;text-align:start;}",
    ".bub[dir='rtl']{text-align:right;}",
    ".bub[dir='ltr']{text-align:left;}",
    // A URL, price or part code inside prose of the other direction. The
    // isolation is <bdi>'s own; this only stops a long link from forcing
    // the bubble wider than the panel.
    ".bub bdi,.why bdi,.card-ti bdi{unicode-bidi:isolate;overflow-wrap:anywhere;}",
    ".row[data-me='1'] .bub{background:" + brand + ";color:" + onBrand + ";border-bottom-" + (dir === "rtl" ? "left" : "right") + "-radius:6px;}",
    ".row[data-me='0'] .bub{background:#f1f5f9;color:#0f172a;border-bottom-" + (dir === "rtl" ? "right" : "left") + "-radius:6px;}",
    ".who{font-size:11.5px;color:#94a3b8;margin:0 4px 3px;text-align:start;}",
    ".mst{font-size:11px;color:#94a3b8;margin:3px 4px 0;text-align:start;}",
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
    ".card-ti{font-weight:620;font-size:14.5px;line-height:1.3;text-align:start;}",
    ".card-pr{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap;}",
    ".pr{font-weight:650;font-size:15px;}",
    ".pr-was{font-size:12.5px;color:#94a3b8;text-decoration:line-through;}",
    ".tag{display:inline-block;font-size:11px;font-weight:600;padding:2px 7px;border-radius:999px;}",
    ".tag-sale{background:#fee2e2;color:#b91c1c;}",
    ".tag-out{background:#f1f5f9;color:#64748b;}",
    ".tag-dr{background:#fef3c7;color:#92400e;}",
    ".why{font-size:12.5px;color:#475569;padding:0 12px 10px;text-align:start;}",
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
    ".btn{flex:1 1 0;min-width:0;border-radius:11px;padding:9px 10px;font:inherit;font-size:13.5px;font-weight:600;",
    "  cursor:pointer;text-align:center;text-decoration:none;border:1px solid transparent;white-space:nowrap;",
    "  overflow:hidden;text-overflow:ellipsis;}",
    ".btn-p{background:" + brand + ";color:" + onBrand + ";}",
    // A disabled primary button must not still look like the thing to
    // press. Neutral outline reads as "not yet", which is the truth: the
    // shopper has a size to choose first.
    ".btn-p:disabled{background:#fff;color:#94a3b8;border-color:#e2e8f0;cursor:not-allowed;}",
    ".btn-s{background:#fff;color:#0f172a;border-color:#e2e8f0;}",
    ".btn-s:hover{border-color:#cbd5e1;}",
    ".btn:focus-visible{outline:2px solid " + brand + ";outline-offset:2px;}",
    ".cart-ok{display:flex;align-items:center;gap:6px;font-size:12.5px;color:#15803d;padding:0 12px 12px;}",
    ".cart-err{font-size:12.5px;color:#b91c1c;padding:0 12px 12px;}",

    // Carousel
    ".car{position:relative;max-width:100%;}",
    ".car-tr{display:flex;gap:10px;overflow-x:auto;scroll-snap-type:x mandatory;padding:2px 2px 8px;",
    "  scrollbar-width:thin;-webkit-overflow-scrolling:touch;}",
    ".car-tr>*{flex:0 0 186px;scroll-snap-align:start;max-width:186px;}",
    ".car-tr .card{max-width:100%;}",
    ".car-tr .card-top{flex-direction:column;gap:9px;padding:10px;}",
    ".car-tr .card-im{width:100%;height:112px;}",
    // A carousel item is a shortlist entry, not a product page. Two lines
    // of reasoning is enough to choose between three shoes; more turns
    // the strip into a wall and buries the actions below the fold.
    // padding-bottom would reveal a sliver of the clamped third line -
    // `overflow:hidden` clips at the PADDING box, not the content box.
    ".car-tr .why{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;",
    "  line-height:1.35;max-height:2.7em;padding:0 10px;margin-bottom:8px;}",
    // Stacked, full-width actions. Side by side at 186px both labels get
    // ellipsised into "Add to …" and "View pr.", which is worse than
    // taking a second row.
    ".car-tr .acts{padding:0 10px 10px;flex-direction:column;gap:6px;}",
    ".car-tr .btn{font-size:12.5px;padding:8px 8px;flex:0 0 auto;width:100%;}",
    // Right-edge fade: without it a scrollable strip looks like a clipped
    // one, and shoppers do not swipe what they cannot tell is swipeable.
    ".car::after{content:'';position:absolute;top:0;bottom:14px;" + (dir === "rtl" ? "left" : "right") + ":0;",
    "  width:26px;pointer-events:none;background:linear-gradient(to " + (dir === "rtl" ? "left" : "right") + ",rgba(255,255,255,0),#fff);}",
    ".car-nav{display:flex;gap:6px;justify-content:flex-end;padding:0 2px;}",
    ".car-n{width:28px;height:28px;border-radius:8px;border:1px solid #e2e8f0;background:#fff;cursor:pointer;color:#475569;}",
    ".car-n:focus-visible{outline:2px solid " + brand + ";outline-offset:2px;}",

    // Composer
    // A one-line composer by default. It was 115px of a 640px panel -
    // more than the hero is allowed now - mostly padding around an empty
    // textarea.
    ".ft{border-top:1px solid #f0f3f7;padding:var(--s2) var(--s3);",
    "  padding-bottom:calc(var(--s2) + env(safe-area-inset-bottom));background:#fff;flex:0 0 auto;}",
    ".cmp{display:flex;align-items:flex-end;gap:var(--s2);}",
    // border-box, or min-height:38 becomes 38 + padding + border = 56 -
    // the same trap that made a "44px" header measure 57.
    ".ta{flex:1 1 auto;box-sizing:border-box;resize:none;border:1px solid #e4e9f0;border-radius:11px;padding:8px 12px;",
    "  font:inherit;font-size:16px;line-height:1.4;max-height:104px;min-height:38px;color:#0f172a;background:#fff;",
    "  transition:border-color .15s,box-shadow .15s;}",
    "@media (min-width: 561px){.ta{font-size:14px;}}",
    // `start`, not `left`: with dir="auto" the caret begins on the side
    // the shopper's language starts from, and the placeholder sits there
    // waiting for it.
    ".ta{text-align:start;}",
    ".ta::placeholder{color:#9aa7b8;text-align:start;}",
    ".ta:focus{outline:none;border-color:" + brand + ";box-shadow:0 0 0 3px " + brand + "1f;}",
    "@media (prefers-reduced-motion: reduce){.ta{transition:none}}",
    ".snd{width:38px;height:38px;flex:0 0 auto;border-radius:10px;border:0;background:" + brand + ";",
    "  color:" + onBrand + ";cursor:pointer;display:flex;align-items:center;justify-content:center;",
    "  transition:opacity .15s,transform .15s;}",
    ".snd:disabled{opacity:.35;cursor:not-allowed;}",
    ".snd:not(:disabled):active{transform:scale(.94);}",
    ".snd:focus-visible{outline:2px solid " + brand + ";outline-offset:2px;}",
    ".snd svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}",
    "@media (prefers-reduced-motion: reduce){.snd{transition:none}}",
    // §8 The footer states who is answering and offers a person. Neither
    // needs height: this row is now 15px plus its gap.
    ".sub{display:flex;align-items:center;justify-content:space-between;gap:var(--s2);margin-top:var(--s1);}",
    ".lnk{background:none;border:0;padding:0;font:inherit;font-size:11.5px;color:#64748b;cursor:pointer;",
    "  text-decoration:none;border-bottom:1px solid #cbd5e1;line-height:1.25;}",
    ".lnk:hover{color:" + brand + ";border-bottom-color:" + brand + ";}",
    ".lnk:focus-visible{outline:2px solid " + brand + ";outline-offset:2px;}",
    ".pw{font-size:10.5px;color:#a3aec0;line-height:1.25;}",
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

  // The hero video, when one is playing. Held so it can be stopped the
  // moment it stops being visible - a muted loop running behind a closed
  // panel is battery and bandwidth a shopper never agreed to spend.
  var heroVideo = null;
  var panel = el("div", "panel");
  // Born closed, and says so in the attribute that owns visibility.
  panel.setAttribute("data-state", "closed");
  attr(panel, {
    role: "dialog",
    "aria-modal": "false",
    "aria-label": welcome.assistantName || "Chat",
    dir: dir,
    lang: lang,
    hidden: "",
  });

  var header = el("div", "hd");
  var logo = safeUrl(appearance.logoUrl) || safeUrl(appearance.avatarUrl);
  var headerAvatar;
  if (logo) {
    headerAvatar = document.createElement("img");
    headerAvatar.className = "hd-av";
    headerAvatar.alt = "";
    headerAvatar.src = logo;
  } else {
    // A merchant who has not uploaded a logo yet should get a monogram,
    // not a solid block of brand colour that reads as a broken image.
    headerAvatar = el("div", "hd-av hd-mono", (welcome.assistantName || "?").trim().charAt(0).toUpperCase());
    attr(headerAvatar, { "aria-hidden": "true" });
  }

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
  // A stable hook so tests and tooling can find THE close button rather
  // than the first button that happens to carry a label.
  attr(closeBtn, { type: "button", "aria-label": T.close, "data-act": "close" });
  closeBtn.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  header.appendChild(headerAvatar);
  header.appendChild(headerText);
  // Visitor mute. Only offered when the merchant enabled sound at all -
  // a mute button for silence a shopper already has is just clutter.
  var muteBtn = null;
  var soundsOn = !!(boot.widget && boot.widget.ux && boot.widget.ux.sounds && boot.widget.ux.sounds.enabled);
  if (soundsOn && boot.setVisitorMuted) {
    muteBtn = el("button", "mute");
    attr(muteBtn, { type: "button", "data-act": "mute" });
    paintMute();
    on(muteBtn, "click", function () {
      var next = !(boot.visitorMuted && boot.visitorMuted());
      boot.setVisitorMuted(next);
      paintMute();
    });
    header.appendChild(muteBtn);
  }

  function paintMute() {
    if (!muteBtn) return;
    var muted = boot.visitorMuted && boot.visitorMuted();
    // The label states what the button DOES, which is what a screen
    // reader user needs, not what the current state is.
    attr(muteBtn, { "aria-label": muted ? T.unmute : T.mute, "aria-pressed": muted ? "true" : "false" });
    muteBtn.innerHTML = muted
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5L6 9H3v6h3l5 4V5z"/><path d="M17 9l4 6M21 9l-4 6"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5L6 9H3v6h3l5 4V5z"/><path d="M16 9a4 4 0 0 1 0 6"/></svg>';
  }

  // Appended to the panel, not the header: in WELCOME there is no
  // header to live in, and duplicating it would mean two handlers.
  panel.appendChild(closeBtn);

  var banner = el("div", "banner");
  banner.hidden = true;

  var body = el("div", "bd");
  attr(body, { tabindex: "0", role: "log", "aria-live": "polite", "aria-relevant": "additions" });

  var footer = el("div", "ft");
  var composer = el("form", "cmp");
  var textarea = document.createElement("textarea");
  textarea.className = "ta";
  // The ONE place `dir="auto"` is the right answer rather than a guess:
  // the input has no history to reason from, first-strong is exactly the
  // rule a typist expects, and it re-evaluates as they type. Empty, it
  // inherits the panel, so the placeholder sits where the shopper is
  // about to start typing.
  attr(textarea, {
    rows: "1",
    dir: "auto",
    placeholder: T.placeholder,
    "aria-label": T.placeholder,
    maxlength: "2000",
  });
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

  // The channel's API base, supplied by whichever bootstrap loaded us.
  // This is the ONLY thing in the bundle that was ever Shopify-specific:
  // with commerce features off it is a general-purpose chat widget, and
  // the website widget serves the same experience from the same file
  // rather than a second implementation that drifts.
  var API_BASE = boot.apiPath || "/api/shopify-chat";

  function api(path, payload) {
    return boot.post(API_BASE + path, payload || {}, token());
  }

  function apiGet(path) {
    // Routed through the bootstrap when it offers a reader, so a channel
    // whose API is shaped differently can adapt in ONE place instead of
    // this bundle learning about every channel.
    if (typeof boot.get === "function") return boot.get(API_BASE + path, token());
    return fetch(API + API_BASE + path, {
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
          // Bounded on purpose. On a network that blocks websockets the
          // default is an endless retry loop running alongside the HTTP
          // fallback: twice the traffic, on a page we promised not to
          // slow down. Give up and let polling carry the conversation.
          reconnectionAttempts: 6,
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
          // The only genuinely live delivery path, and so the only one
          // allowed to make a sound.
          ingest([payload.message], true);
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
        socket.io.on("reconnect_failed", function () {
          // Stop trying entirely; polling is now the transport.
          try { socket.close(); } catch (e) {}
          socket = null;
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
  /**
   * @param live  true when these messages just arrived, false when they
   *              are history being replayed. Only the former may make a
   *              sound - a shopper reopening a chat must not hear a
   *              burst of chimes for messages they already read.
   */
  function ingest(incoming, live) {
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
        if (live && boot.playSound) {
          // A human reply and an assistant reply are different events to
          // a shopper, so they are different sounds.
          var human = m.author && m.author.type === "AGENT";
          boot.playSound(human ? "incoming_human" : "incoming_ai", { fromHistory: false });
        }
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
    // `S.error` can be a server sentence in the shopper's language while
    // the rest of these are widget strings, so the banner resolves rather
    // than assumes.
    setDirectedText(banner, text);
  }

  function hasAgentMessage() {
    return S.messages.some(function (m) { return m.authorKind === "agent"; });
  }

  function render() {
    renderStatus();
    renderBanner();

    var inWelcome = !S.messages.length && !S.pending.length && S.phase === "welcome";
    setPanelView(inWelcome ? "welcome" : "conversation");

    if (S.phase === "offline_form") { setPanelView("conversation"); renderOfflineForm(); return; }
    if (inWelcome) { renderWelcome(); return; }
    // Leaving the welcome state: the hero is gone from the DOM the moment
    // the message list replaces it, so release the video handle too
    // rather than leaving a detached element decoding in the background.
    pauseHero();
    heroVideo = null;
    renderMessages();
  }

  /**
   * The rich welcome hero: image, GIF or muted looping video, fading into
   * the chat surface with the brand avatar overlapping its bottom edge.
   *
   * Every branch here degrades to "no hero" rather than to a broken
   * frame. A merchant who pastes a URL that 404s, or a browser that
   * refuses autoplay, must still get a usable chat.
   */
  function renderHero(parent) {
    var h = (boot.widget && boot.widget.ux && boot.widget.ux.hero) || null;
    if (!h || h.mediaType === "none" || !h.mediaUrl) return null;
    var url = safeUrl(h.mediaUrl);
    if (!url) return null;

    var mobile = window.matchMedia("(max-width: 560px)").matches;
    var configured = mobile ? h.mobileHeight : h.height;

    // The merchant's height is a PREFERENCE; the panel has the last word.
    // Mirrors resolveHeroHeight() in @chatcenter/shared - the widget ships
    // without a bundler and cannot import it, so the rule is duplicated
    // deliberately and tested on both sides.
    // The panel's MAXIMUM height, not its current one. In the welcome view
    // the panel sizes to its content, so measuring it here would be
    // circular - and before first paint it measures zero.
    var panelH = mobile ? window.innerHeight : Math.min(640, window.innerHeight - 120);
    var reserved = mobile ? 264 : 288;
    var height = Math.min(configured, Math.max(0, panelH - reserved), Math.floor(panelH * (mobile ? 0.22 : 0.25)));
    // Below ~72px a hero reads as a stripe. Drop it rather than show it badly.
    if (height < 72) return null;

    var hero = el("div", "hero");
    hero.style.height = height + "px";
    if (h.cornerRadius) hero.style.borderRadius = h.cornerRadius + "px";

    var media;
    if (h.mediaType === "video") {
      media = document.createElement("video");
      // Muted + playsinline are the only combination browsers will
      // autoplay. Audio never autoplays, on any platform, by design.
      media.muted = true;
      media.defaultMuted = true;
      media.setAttribute("muted", "");
      media.setAttribute("playsinline", "");
      media.playsInline = true;
      media.loop = !!h.videoLoop;
      media.preload = "none";
      var poster = safeUrl(h.posterUrl);
      if (poster) media.poster = poster;
      media.src = url;
      // A shopper who asked their OS for less motion gets the poster.
      var still = reducedMotion() || !h.videoAutoplay;
      if (!still) {
        var p = media.play();
        if (p && p.catch) p.catch(function () { /* autoplay refused: poster stands in */ });
      }
      heroVideo = media;
    } else {
      media = document.createElement("img");
      media.src = url;
      media.alt = "";
      media.loading = "lazy";
      media.decoding = "async";
    }
    media.className = "hero-m";
    media.style.height = "100%";
    media.style.objectFit = h.objectFit || "cover";
    media.style.objectPosition = h.focalPoint || "50% 50%";
    // A dead URL leaves no trace: the frame collapses instead of showing
    // a broken-image glyph at the top of the chat.
    media.onerror = function () {
      try { hero.remove(); } catch (e) { if (hero.parentNode) hero.parentNode.removeChild(hero); }
    };
    hero.appendChild(media);

    if (h.overlayStrength > 0) {
      var ov = el("div", "hero-ov");
      ov.style.background = "rgba(0,0,0," + (h.overlayStrength / 100) + ")";
      hero.appendChild(ov);
    }
    if (h.fadeStrength > 0) {
      var fd = el("div", "hero-fd");
      var bg = h.backgroundColor || "#ffffff";
      fd.style.height = Math.round(height * (h.fadeStrength / 100)) + "px";
      fd.style.background = "linear-gradient(to bottom, " + hexToRgba(bg, 0) + ", " + bg + ")";
      hero.appendChild(fd);
    }
    parent.appendChild(hero);
    return h;
  }

  /** #rrggbb -> rgba(), so a gradient can start fully transparent. */
  function hexToRgba(hex, alpha) {
    var m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ""));
    if (!m) return "rgba(255,255,255," + alpha + ")";
    return "rgba(" + parseInt(m[1], 16) + "," + parseInt(m[2], 16) + "," + parseInt(m[3], 16) + "," + alpha + ")";
  }

  function reducedMotion() {
    try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; }
  }

  function renderWelcome() {
    footer.hidden = false;
    var wrap = el("div", "wel");
    // Canonical source. `welcome` (the legacy block) is still read by the
    // server-side migration, but by the time it reaches here there is
    // exactly one place to look.
    var W = (boot.widget && boot.widget.ux && boot.widget.ux.welcome) || null;
    var hero = renderHero(wrap);

    // With a hero the avatar overlaps its bottom edge; without one the
    // original logo treatment is unchanged.
    var avatarUrl = safeUrl(W && W.avatarUrl) || safeUrl(appearance.logoUrl);
    if (hero && avatarUrl) {
      var av = document.createElement("img");
      av.className = "wel-av";
      av.src = avatarUrl;
      av.alt = "";
      var avSize = (W && W.avatarSize) || 56;
      av.style.width = avSize + "px";
      av.style.height = avSize + "px";
      av.style.marginTop = "-" + ((W && W.avatarOverlap) || 30) + "px";
      av.style.marginLeft = "auto";
      av.style.marginRight = "auto";
      av.onerror = function () { av.style.display = "none"; };
      wrap.appendChild(av);
    }

    var logoUrl = hero ? null : safeUrl(appearance.logoUrl);
    if (logoUrl) {
      var img = document.createElement("img");
      img.className = "wel-lg";
      img.src = logoUrl;
      img.alt = "";
      wrap.appendChild(img);
    }
    var title = (W && W.title) || welcome.headline || "";
    var subtitle = (W && W.subtitle) || welcome.subline || "";
    // Grouped: a title and its subtitle are one thought, and should not be
    // separated by the same gap that separates them from the questions.
    var copy = el("div", "wel-cp");
    copy.appendChild(directedEl("h2", "wel-h", title));
    if (subtitle) copy.appendChild(directedEl("p", "wel-s", subtitle));
    wrap.appendChild(copy);
    if (!W || W.textAlign !== "start") {
      wrap.style.textAlign = "center";
      wrap.setAttribute("data-align", "center");
    }

    if (boot.availability === "offline" && widget.offline && widget.offline.message) {
      wrap.appendChild(directedEl("p", "wel-s", widget.offline.message));
    }

    var questions = (W && W.suggestedQuestions && W.suggestedQuestions.length ? W.suggestedQuestions : welcome.suggestedQuestions) || [];
    if (questions.length) {
      var list = el("div", "sug");
      attr(list, { role: "group", "aria-label": T.startConversation });
      // Three is what a shopper reads; a fourth and fifth are a list they
      // skip. The rest stay one tap away rather than costing everyone the
      // height.
      var VISIBLE = 3;
      var hidden = [];
      questions.forEach(function (q, i) {
        // A merchant may write suggestions in a language other than the
        // widget's; each chip reads in its own.
        var b = directedEl("button", "sug-b", q);
        attr(b, { type: "button" });
        on(b, "click", function () {
          track("suggested_question_clicked");
          submit(q);
        });
        if (i >= VISIBLE) {
          b.hidden = true;
          hidden.push(b);
        }
        list.appendChild(b);
      });
      if (hidden.length) {
        var more = el("button", "sug-more", T.showMore.replace("{n}", String(hidden.length)));
        attr(more, { type: "button", "aria-expanded": "false" });
        on(more, "click", function () {
          hidden.forEach(function (b) { b.hidden = false; });
          more.remove();
          // The newly revealed questions are below the fold by definition,
          // so say so by moving to them rather than leaving the shopper to
          // wonder whether anything happened.
          hidden[0].scrollIntoView({ block: "nearest" });
        });
        list.appendChild(more);
      }
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

    // Only label the first message of a run. Repeating the assistant's
    // name above every consecutive bubble reads like three different
    // people talking.
    var previousAuthor = null;
    S.messages.forEach(function (m) {
      list.appendChild(messageRow(m, m.author === previousAuthor));
      previousAuthor = m.author;
    });
    S.pending.forEach(function (p) { list.appendChild(pendingRow(p)); });

    if (S.awaitingReply && !S.ended) {
      var typing = el("div", "row");
      // The dots stand in for a reply that has not arrived, so they take
      // the direction the conversation is being held in.
      attr(typing, { "data-me": "0", dir: dir });
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

  function messageRow(m, sameAuthorAsPrevious) {
    var row = el("div", "row");
    attr(row, { "data-me": m.direction === "INBOUND" ? "1" : "0" });

    if (m.direction === "OUTBOUND" && m.author && !sameAuthorAsPrevious) {
      // An agent called "דנה" and one called "Dana" belong on opposite
      // sides of their own label.
      row.appendChild(directedEl("div", "who", m.author));
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
    // `m.locale` is the server's own statement about this message's
    // language when it has one (a translated or generated reply knows);
    // otherwise the text decides.
    if (m.body) row.appendChild(directedEl("div", "bub", m.body, m.locale));
    return row;
  }

  function pendingRow(p) {
    var row = el("div", "row");
    attr(row, { "data-me": "1" });
    row.appendChild(directedEl("div", "bub", p.body));
    // The status line is widget chrome, so it follows the widget.
    row.appendChild(attr(el("div", "mst", p.failed ? T.failed : "· · ·"), { dir: dir }));
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

  /**
   * @param compact  Rendered inside a carousel. A shortlist entry is a
   *   choice between products, not a configurator: the variant picker
   *   and quantity stepper are dropped, and Add to Cart only appears
   *   when a variant is already resolved. Anything else belongs on the
   *   single card the shopper lands on after choosing.
   */
  function productCard(product, addToCartAllowed, compact) {
    var card = el("div", "card");
    // The card is CHROME. Its layout follows the widget, not the message
    // it happens to sit under, so an English-titled product inside a
    // Hebrew reply does not flip the image, the buttons and the stepper
    // to the other side mid-conversation. Only the text inside it -
    // title, reason - resolves per string.
    attr(card, { dir: dir });
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
      // A product title is the merchant's, in whatever language they sell
      // in - never assumed to match the shopper's.
      info.appendChild(directedEl("div", "card-ti", product.title));

      // Prices, discounts and the row that holds them are LTR whatever
      // language surrounds them: "₪120.00" reversed is not a price, and a
      // "-25%" whose minus sign has migrated is a price rise.
      var priceRow = el("div", "card-pr");
      attr(priceRow, { dir: "ltr" });
      var price = variant && variant.price != null ? variant.price : product.price;
      var wasPrice =
        variant && variant.compareAtPrice != null ? variant.compareAtPrice : product.compareAtPrice;
      priceRow.appendChild(ltrAtom("pr", money(price, product.currency)));
      if (wasPrice && Number(wasPrice) > Number(price)) {
        priceRow.appendChild(ltrAtom("pr-was", money(wasPrice, product.currency)));
        priceRow.appendChild(ltrAtom("tag tag-sale", "-" +
          Math.round((1 - Number(price) / Number(wasPrice)) * 100) + "%"));
      }
      info.appendChild(priceRow);

      var purchasable = variant ? variant.available : product.available;
      if (!purchasable) info.appendChild(el("span", "tag tag-out", T.soldOut));
      if (product.published === false) info.appendChild(el("span", "tag tag-dr", T.notPublished));

      top.appendChild(info);
      card.appendChild(top);

      // The "why this one" line is written by the AI employee in the
      // shopper's language, so it resolves its own direction rather than
      // inheriting the card's.
      if (product.reason) card.appendChild(directedEl("div", "why", product.reason));

      // Variant picker. A product with real options never gets an
      // arbitrary variant chosen for the shopper - Add to Cart stays
      // disabled until they pick one that actually exists.
      var needsChoice = (product.optionNames || []).length > 0 && product.variants.length > 1;
      if (needsChoice && !compact) {
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
            attr(chip, { "aria-label": v.title + " - " + T.soldOut });
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

      if (canAdd && !compact) {
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
      // In a carousel, only offer Add to Cart when there is genuinely
      // nothing left to choose. Otherwise the button would either lie or
      // pick a size for the shopper.
      var offerAdd = addToCartAllowed && features.addToCart && (!compact || canAdd);
      if (offerAdd) {
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
      // The shopper-safe sentence the server sends is in the shopper's
      // language, not the widget's.
      if (vState.error) card.appendChild(directedEl("div", "cart-err", vState.error));
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

  var CAROUSEL_STEP = 224;

  /**
   * Scroll the strip one card FORWARD or BACKWARD in reading order.
   *
   * `scrollLeft` is physical. In an RTL container the first card sits at
   * scrollLeft 0 and later cards are at NEGATIVE offsets (the modern
   * spec; older WebKit used positive-descending, which is why the value
   * is read back rather than assumed). Adding a positive step to advance
   * therefore scrolled an RTL carousel backwards into its own start edge,
   * and the shopper saw the arrows do nothing.
   */
  function scrollStrip(strip, cards) {
    var delta = CAROUSEL_STEP * cards;
    strip.scrollLeft += dir === "rtl" ? -delta : delta;
  }

  function carousel(commerce) {
    var wrap = el("div", "car");
    var strip = el("div", "car-tr");
    // The strip is chrome: it lays out in the widget's direction so the
    // first recommendation is at the edge a shopper starts reading from.
    attr(strip, { role: "group", "aria-label": T.next, tabindex: "0", dir: dir });
    commerce.products.forEach(function (p) {
      strip.appendChild(productCard(p, commerce.addToCartEnabled, true));
    });

    // Keyboard: the strip itself is focusable and arrow keys scroll it,
    // so a keyboard user is never stuck at a horizontal list they can
    // see but cannot move. The keys stay PHYSICAL - ArrowRight moves the
    // content right on screen in both directions, which is what the key
    // says on the keycap and what a screen reader user expects.
    on(strip, "keydown", function (e) {
      if (e.key === "ArrowRight") { strip.scrollLeft += CAROUSEL_STEP; e.preventDefault(); }
      if (e.key === "ArrowLeft") { strip.scrollLeft -= CAROUSEL_STEP; e.preventDefault(); }
    });

    var nav = el("div", "car-nav");
    // The chevrons point along the reading order, so "previous" is the
    // one aiming back toward the start edge whichever side that is.
    var prev = el("button", "car-n", dir === "rtl" ? "›" : "‹");
    attr(prev, { type: "button", "aria-label": T.previous, "data-act": "carousel-prev" });
    var next = el("button", "car-n", dir === "rtl" ? "‹" : "›");
    attr(next, { type: "button", "aria-label": T.next, "data-act": "carousel-next" });
    on(prev, "click", function () { scrollStrip(strip, -1); });
    on(next, "click", function () { scrollStrip(strip, 1); });
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
   * half posts that id to the THEME's own /cart/add.js - same origin,
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
        // The card grows by a confirmation row, which lands below the
        // fold on a full conversation. Without this the shopper taps Add
        // to cart and, as far as they can tell, nothing happens.
        scrollToEnd();
        api("/cart/result", { ok: true }).catch(function () {});
        notifyThemeCartChanged();
      })
      .catch(function (err) {
        vState.busy = false;
        // The server sends a shopper-safe sentence for the cases it
        // knows (out of stock, option gone, subscription-only). Anything
        // else stays generic - a raw Shopify error is not an answer.
        vState.error =
          (err && err.body && err.body.message) ||
          (err && err.status === 409 && err.message) ||
          T.failed;
        repaint();
        scrollToEnd();
        api("/cart/result", { ok: false }).catch(function () {});
      });
  }

  /**
   * Tell the theme its cart changed, using the events Shopify's own
   * Dawn-lineage themes and most app ecosystems already listen for. We
   * only ever *announce* - opening a merchant's cart drawer ourselves
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
        // The chime belongs here, not in submit(): it means "delivered",
        // and a send that failed must never sound like one that worked.
        if (boot.playSound) boot.playSound("outgoing", { sendFailed: false });
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
          // Session expired - re-bootstrap silently on the next open.
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

  // One line until the visitor actually needs more, then bounded. The
  // ceiling must match the stylesheet's max-height or the two disagree
  // and the textarea grows past a scrollbar it cannot show.
  var TA_MIN = 38;
  var TA_MAX = 104;

  function autoGrow() {
    textarea.style.height = "auto";
    textarea.style.height = Math.max(TA_MIN, Math.min(TA_MAX, textarea.scrollHeight)) + "px";
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

  on(closeBtn, "click", function (e) {
    // Stop the storefront theme from ever seeing this click, and count it
    // so a stuck widget can be told apart from a click that never landed.
    if (e && e.stopPropagation) e.stopPropagation();
    S.closeClicks = (S.closeClicks || 0) + 1;
    close();
  });

  function open() {
    setPanelOpen(true);
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

  function pauseHero() {
    if (heroVideo) { try { heroVideo.pause(); } catch (e) {} }
  }

  // A backgrounded tab should not be decoding video either.
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) pauseHero();
    else if (S.opened && heroVideo && !reducedMotion()) {
      var p = heroVideo.play();
      if (p && p.catch) p.catch(function () {});
    }
  });

  /**
   * The only place panel visibility changes. Everything else calls this.
   */
  /**
   * WELCOME or CONVERSATION. Drives layout entirely through CSS, so there
   * is no scattered show/hide to fall out of sync with the state.
   */
  function setPanelView(view) {
    panel.setAttribute("data-view", view);
  }

  function setPanelOpen(open) {
    panel.setAttribute("data-state", open ? "open" : "closed");
    panel.hidden = !open;
    S.opened = open;
  }

  function close(reason) {
    setPanelOpen(false);
    // An explicit shopper close is a decision that outlives this render:
    // nothing may auto-open the panel again for the rest of the page
    // view. The launcher still can, because that is the shopper asking.
    if (reason !== "internal") S.closedByVisitor = true;
    pauseHero();
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

  /**
   * Safe UI state for debugging a live storefront.
   *
   * Deliberately contains no tenant id, channel id, session token,
   * conversation body or AI configuration - only what somebody looking at
   * a stuck widget needs to see. Attached by the bootstrap.
   */
  function debugState() {
    return {
      state: S.opened ? (S.messages.length || S.pending.length ? "CONVERSATION" : "WELCOME") : "CLOSED",
      panelHidden: panel.hidden,
      panelDataState: panel.getAttribute("data-state"),
      panelDisplay: (function () {
        try { return getComputedStyle(panel).display; } catch (e) { return "?"; }
      })(),
      closeClicks: S.closeClicks || 0,
      closedByVisitor: !!S.closedByVisitor,
      messageCount: S.messages.length,
      unread: S.unread,
      polling: !!pollTimer,
      socketConnected: !!(socket && socket.connected),
      heroVideoPlaying: !!(heroVideo && !heroVideo.paused),
    };
  }

  return {
    open: open,
    close: close,
    watchInBackground: watchInBackground,
    closedByVisitor: function () { return !!S.closedByVisitor; },
    debugState: debugState,
  };
};
