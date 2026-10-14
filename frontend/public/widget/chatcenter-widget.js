/**
 * GOTCHA website chat - the script a tenant pastes onto their own site.
 *
 * The filename and the `window.__chatcenter` contract are load-bearing:
 * snippets are already pasted on customer sites and on gotcha.co.il
 * itself, and none of them can be edited from here.
 *
 * A stub, on purpose. This file is served under a fixed name, and a CDN or
 * a browser can pin a fixed name for as long as it likes (dev's edge held
 * it as `immutable`). So it does only what can never need to change:
 *
 *   1. Ask the server whether this widget still exists, BEFORE drawing or
 *      downloading anything. A deleted widget is simply not there - no
 *      button that opens onto silence.
 *   2. Read widget-manifest.json fresh (`no-cache`) and load the two
 *      content-hashed files it names: the site UI (gotcha-site.<hash>.js:
 *      the adapter, the bubble, the pop-up) and the chat bundle the
 *      storefront runs too. New bytes are new names, so a pinned loader
 *      still gets the current widget.
 */
(function () {
  "use strict";

  var cfg = window.__chatcenter || {};
  var API = String(cfg.apiUrl || "").replace(/\/+$/, "");
  var WIDGET_ID = String(cfg.widgetId || "");

  if (!WIDGET_ID) return;
  if (window.__gotchaWebchatLoaded) return;
  window.__gotchaWebchatLoaded = true;

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

  function loadScript(name, ready) {
    return new Promise(function (resolve, reject) {
      if (ready()) return resolve();
      var s = document.createElement("script");
      s.src = API + "/widget/" + name;
      s.async = true;
      s.onload = resolve;
      s.onerror = function () { reject(new Error("bundle_failed")); };
      document.head.appendChild(s);
    });
  }

  function start() {
    request("/api/embedded-chat/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ widgetId: WIDGET_ID }),
      credentials: "omit",
    })
      .then(function (res) {
        var data = (res && res.data) || {};
        if (!data.widget) return;
        return request("/widget/widget-manifest.json", { credentials: "omit", cache: "no-cache" }).then(function (manifest) {
          if (!manifest || !manifest.site || !manifest.chat) throw new Error("manifest_incomplete");
          return Promise.all([
            loadScript(manifest.site, function () { return typeof window.__gotchaSiteMount === "function"; }),
            loadScript(manifest.chat, function () { return typeof window.__gotchaShopifyChatApp === "function"; }),
          ]).then(function () {
            if (typeof window.__gotchaSiteMount !== "function" || typeof window.__gotchaShopifyChatApp !== "function") return;
            window.__gotchaSiteMount({ api: API, widgetId: WIDGET_ID, data: data });
          });
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
