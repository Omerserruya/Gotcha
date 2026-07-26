/*
 * GOTCHA enhancement for Authentik's hosted flow pages.
 *
 * Authentik has no custom-JS hook, so this is injected into every flow page by
 * the gateway (nginx sub_filter) and served from the container's static tree.
 * It adds the one thing the hosted login was missing and CSS alone cannot do:
 * a show/hide toggle on password inputs. Authentik's UI is Lit web components
 * with OPEN shadow roots, so we walk them and enhance each password field.
 */
(function () {
  "use strict";

  var EYE =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_OFF =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-6.5 0-10-7-10-7a18.5 18.5 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c6.5 0 10 7 10 7a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="2" y1="2" x2="22" y2="22"/></svg>';

  function enhance(input) {
    if (!input || input.type !== "password") return;
    var wrapCheck = input.parentElement;
    // Re-add if a prior button was wiped by an SPA re-render (guard on presence,
    // not a one-shot flag).
    if (wrapCheck && wrapCheck.querySelector && wrapCheck.querySelector("button[data-gotcha-eye]")) return;
    input.dataset.gotchaReveal = "1";

    // The PatternFly `<input class="pf-c-form-control">` IS the control element,
    // so the button cannot go INSIDE it - anchor on the input's parent and align
    // the button to the input's own box (works even if the parent also holds a
    // label or help text).
    var wrap = input.parentElement;
    if (!wrap) return;
    try { if (getComputedStyle(wrap).position === "static") wrap.style.position = "relative"; } catch (e) {}

    var btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("data-gotcha-eye", "1");
    btn.setAttribute("aria-label", "Show password");
    btn.setAttribute("tabindex", "-1");
    // Reflect the CURRENT reveal state - if a re-render wiped a button while the
    // password was shown, the new one must not claim it is hidden.
    btn.innerHTML = input.type === "text" ? EYE_OFF : EYE;
    var top = input.offsetTop + input.offsetHeight / 2;
    // z-index must beat PatternFly's `.pf-c-input-group` focus z-index, which
    // jumps high WHEN THE INPUT IS FOCUSED - at z-index:5 the focused input
    // painted on top of the eye, so the eye "disappeared" the moment you clicked
    // into the field. 999 keeps it above the focused control.
    btn.style.cssText =
      "position:absolute;top:" + top + "px;inset-inline-end:12px;transform:translateY(-50%);" +
      "display:flex;align-items:center;justify-content:center;background:transparent;" +
      "border:0;padding:4px;margin:0;cursor:pointer;color:#8b8b9a;line-height:0;z-index:999;";
    btn.addEventListener("mouseenter", function () { btn.style.color = "#7c5cfc"; });
    btn.addEventListener("mouseleave", function () { btn.style.color = "#8b8b9a"; });
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      var showing = input.type === "text";
      input.type = showing ? "password" : "text";
      btn.innerHTML = showing ? EYE : EYE_OFF;
      btn.setAttribute("aria-label", showing ? "Show password" : "Hide password");
      input.focus();
    });

    // Give the input room so text never sits under the icon. custom.css sets the
    // field padding with `!important`, so a plain inline value loses - use
    // setProperty(..., "important") to actually reserve the space.
    try { input.style.setProperty("padding-inline-end", "44px", "important"); } catch (e) {}
    wrap.appendChild(btn);

    // Authentik's Lit field re-renders on focus/keystroke and wipes children -
    // that made the eye flicker out while typing. Watch the field's shadow root
    // and re-add the button THE INSTANT it is removed (the 500ms poll below is
    // only a coarse fallback).
    try {
      var host = input.getRootNode();
      if (host && host !== document && !host.__gotchaEyeObserved && typeof MutationObserver !== "undefined") {
        host.__gotchaEyeObserved = true;
        new MutationObserver(function () {
          host.querySelectorAll("input[type=password]").forEach(enhance);
        }).observe(host, { childList: true, subtree: true });
      }
    } catch (e) {}
  }

  // The recovery ("Forgot username or password?") link lives in a footer-band
  // item inside a shadow root, so a `<head>` <style> cannot reach it, and the
  // themed stylesheet (custom.css) is CDN-cached for up to 4h - a stale copy
  // that once hid the band's :last-child would keep the link clipped until the
  // edge cache expired. Force the band + its items visible from JS (inline
  // `important` beats any cached stylesheet !important) so the link is never
  // swallowed. No-op once the fresh CSS lands.
  function revealRecovery(root) {
    var rec = root.querySelector && root.querySelector("#recovery");
    if (!rec) return;
    var el = rec;
    while (el && el !== root) {
      if (el.classList && (el.classList.contains("pf-c-login__main-footer-band") ||
          el.classList.contains("pf-c-login__main-footer-band-item"))) {
        el.style.setProperty("display", "block", "important");
        el.style.setProperty("visibility", "visible", "important");
      }
      el = el.parentElement || el.parentNode;
    }
  }

  // The MFA challenge reuses the login flow, so its title is "Welcome back" and
  // its device labels are Authentik jargon ("Traditional authenticator", "Static
  // token") - users don't realise they're being asked for a SECOND factor. Add a
  // clear, method-agnostic banner at the top of the validation stage. Additive
  // (a GOTCHA-owned node), so it never fights Authentik's own Lit-rendered text;
  // the poll/observer re-adds it if a re-render wipes it.
  function clarifyMfa(root) {
    var stage = root.querySelector && root.querySelector("ak-stage-authenticator-validate");
    if (!stage || !stage.parentNode) return;
    var parent = stage.parentNode;
    if (parent.querySelector && parent.querySelector("[data-gotcha-mfa-note]")) return;
    var note = document.createElement("div");
    note.setAttribute("data-gotcha-mfa-note", "1");
    note.style.cssText = "margin:0 0 18px 0;";
    note.innerHTML =
      '<div style="font-size:1.15rem;font-weight:800;color:#111827;line-height:1.2;">Two-step verification</div>' +
      '<div style="font-size:13px;color:#6b7280;margin-top:4px;">For your security, confirm it&#39;s you: enter the code from your authenticator app (or a recovery code) to finish signing in.</div>';
    parent.insertBefore(note, stage);
  }

  // Replace the single numeric one-time-code field (TOTP challenge) with a
  // modern 6-slot input - one digit per box, auto-advance, backspace, paste, and
  // auto-submit on the 6th digit. Only for NUMERIC codes (TOTP), never the
  // alphanumeric recovery-code field. The real Authentik input is kept in the
  // DOM (visually hidden) and stays in sync, so the flow submits exactly as
  // before. Idempotent + re-applied by the poll/observer if a re-render wipes it.
  function enhanceOtp(input) {
    if (!input || input.name !== "code") return;
    // Only enhance a code input the user can actually SEE. Two phantom cases
    // painted six orphaned OTP boxes onto pages with no code prompt (e.g. the
    // self-service password-reset): a display:none stage input (no client
    // rects), and an off-screen 8x6 probe form parked at -2000,-1332 directly
    // under <html>. Require real layout, plausible input size, and an
    // on-viewport position. The 500ms poll re-runs this, so a genuine TOTP
    // challenge still gets enhanced the moment it becomes visible.
    if (input.getClientRects().length === 0) return;
    var vr = input.getBoundingClientRect();
    if (vr.width < 16 || vr.height < 16 || vr.right <= 0 || vr.bottom <= 0) return;
    var numeric =
      input.getAttribute("inputmode") === "numeric" ||
      /\[0-9\]/.test(input.getAttribute("pattern") || "") ||
      input.getAttribute("autocomplete") === "one-time-code";
    if (!numeric) return;
    var wrap = input.parentElement;
    if (!wrap) return;
    if (wrap.querySelector && wrap.querySelector("[data-gotcha-otp]")) return;

    var LEN = 6;
    // Hide the real input but keep it submittable.
    input.setAttribute("data-gotcha-otp-real", "1");
    input.setAttribute("tabindex", "-1");
    input.style.setProperty("position", "absolute", "important");
    input.style.setProperty("width", "1px", "important");
    input.style.setProperty("height", "1px", "important");
    input.style.setProperty("opacity", "0", "important");
    input.style.setProperty("pointer-events", "none", "important");

    var box = document.createElement("div");
    box.setAttribute("data-gotcha-otp", "1");
    box.style.cssText = "display:flex;gap:8px;direction:ltr;margin-top:4px;";
    var cells = [];

    function value() { return cells.map(function (c) { return c.value; }).join(""); }
    function sync() {
      var v = value();
      input.value = v;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      if (v.length === LEN) {
        var form = input.form || (input.closest && input.closest("form"));
        var btn = form && form.querySelector("button[type=submit]");
        if (btn) setTimeout(function () { btn.click(); }, 150);
      }
    }

    for (var i = 0; i < LEN; i++) {
      (function (idx) {
        var cell = document.createElement("input");
        cell.type = "text";
        cell.inputMode = "numeric";
        cell.maxLength = 1;
        cell.autocomplete = idx === 0 ? "one-time-code" : "off";
        cell.setAttribute("aria-label", "Digit " + (idx + 1));
        cell.style.cssText =
          "width:44px;height:52px;text-align:center;font-size:22px;font-weight:600;" +
          "border:1px solid #d1d5db;border-radius:12px;color:#111827;background:#fff;" +
          "outline:none;transition:border-color .15s,box-shadow .15s;";
        cell.addEventListener("focus", function () {
          cell.style.borderColor = "#7c5cfc";
          cell.style.boxShadow = "0 0 0 4px rgba(124,92,252,.15)";
          cell.select();
        });
        cell.addEventListener("blur", function () {
          cell.style.borderColor = "#d1d5db";
          cell.style.boxShadow = "none";
        });
        cell.addEventListener("input", function () {
          var d = (cell.value || "").replace(/\D/g, "");
          cell.value = d.slice(-1);
          if (cell.value && idx < LEN - 1) cells[idx + 1].focus();
          sync();
        });
        cell.addEventListener("keydown", function (e) {
          if (e.key === "Backspace" && !cell.value && idx > 0) {
            cells[idx - 1].focus();
            cells[idx - 1].value = "";
            sync();
            e.preventDefault();
          } else if (e.key === "ArrowLeft" && idx > 0) {
            cells[idx - 1].focus();
          } else if (e.key === "ArrowRight" && idx < LEN - 1) {
            cells[idx + 1].focus();
          }
        });
        cell.addEventListener("paste", function (e) {
          e.preventDefault();
          var t = ((e.clipboardData || window.clipboardData).getData("text") || "").replace(/\D/g, "").slice(0, LEN);
          for (var j = 0; j < t.length && idx + j < LEN; j++) cells[idx + j].value = t[j];
          cells[Math.min(idx + t.length, LEN - 1)].focus();
          sync();
        });
        cells.push(cell);
        box.appendChild(cell);
      })(i);
    }

    input.parentNode.insertBefore(box, input.nextSibling);
    setTimeout(function () { try { cells[0].focus(); } catch (e) {} }, 60);
  }

  // Live password-policy checklist on any SET-password stage (invite, reset,
  // change). Discriminator: the stage renders BOTH `password` and
  // `password_repeat` fields - the login screen has only one, so it never gets
  // a checklist. Rules mirror the server policy (gotcha-password-strength in
  // scripts/authentik/bootstrap.mjs): 12+ chars, upper, lower, digit, symbol -
  // plus a "passwords match" row. The server additionally rejects breached /
  // guessable passwords; those can only be judged on submit, so the checklist
  // going all-green is necessary, not sufficient, and the server error still
  // renders as before. Idempotent via presence guard; the poll/observer
  // re-adds it (with fresh listeners) whenever a Lit re-render wipes the stage.
  function enhancePwPolicy(root) {
    if (!root.querySelector) return;
    var pw = root.querySelector("input[name=password]");
    var rep = root.querySelector("input[name=password_repeat]");
    if (!pw || !rep) return;
    var anchor = rep.parentElement;
    if (!anchor) return;
    if (anchor.querySelector && anchor.querySelector("[data-gotcha-pwrules]")) return;

    var RULES = [
      { label: "At least 12 characters", test: function (v) { return v.length >= 12; } },
      { label: "An uppercase letter (A-Z)", test: function (v) { return /[A-Z]/.test(v); } },
      { label: "A lowercase letter (a-z)", test: function (v) { return /[a-z]/.test(v); } },
      { label: "A number (0-9)", test: function (v) { return /[0-9]/.test(v); } },
      { label: "A symbol (!@#...)", test: function (v) { return /[^A-Za-z0-9]/.test(v); } },
      { label: "Passwords match", test: function (v) { return v.length > 0 && v === rep.value; } },
    ];

    var panel = document.createElement("div");
    panel.setAttribute("data-gotcha-pwrules", "1");
    panel.style.cssText =
      "margin:10px 0 2px;padding:12px 14px;background:#f8f7fd;border:1px solid #e8e5f5;" +
      "border-radius:12px;display:grid;grid-template-columns:1fr 1fr;gap:6px 14px;";
    var rows = RULES.map(function (rule) {
      var row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:7px;font-size:12.5px;line-height:1.3;";
      var dot = document.createElement("span");
      dot.style.cssText =
        "flex:none;width:15px;height:15px;border-radius:50%;display:inline-flex;align-items:center;" +
        "justify-content:center;font-size:10px;font-weight:700;transition:background .15s,color .15s;";
      var txt = document.createElement("span");
      txt.textContent = rule.label;
      row.appendChild(dot);
      row.appendChild(txt);
      panel.appendChild(row);
      return { rule: rule, dot: dot, txt: txt };
    });

    function update() {
      var v = pw.value || "";
      rows.forEach(function (r) {
        var ok = r.rule.test(v);
        r.dot.style.background = ok ? "#16a34a" : "#e4e1f0";
        r.dot.style.color = ok ? "#fff" : "#a09bb3";
        r.dot.textContent = ok ? "✓" : "";
        r.txt.style.color = ok ? "#15803d" : "#6b7280";
      });
    }
    pw.addEventListener("input", update);
    rep.addEventListener("input", update);
    update();

    // After the repeat field, before the actions row - reads as help for the
    // pair of fields above it.
    anchor.appendChild(panel);
  }

  // ── Preboot curtain reveal (see the gateway sub_filter injection) ──
  // Flow pages are hidden behind an inline white curtain + spinner until the
  // GOTCHA theme actually paints, so the stock Authentik UI never flashes.
  // The theme is applied by Authentik injecting custom.css into each shadow
  // root - detectable as the themed background color on .pf-c-background-image.
  // The inline snippet also self-lifts after 6s, so a failed CSS load degrades
  // to the stock look instead of a blank page.
  function liftCurtainIfThemed() {
    var html = document.documentElement;
    if (!html.classList.contains("gotcha-preboot")) return true;
    var bg = null;
    (function find(root) {
      if (bg || !root.querySelectorAll) return;
      bg = root.querySelector(".pf-c-background-image");
      if (bg) return;
      root.querySelectorAll("*").forEach(function (el) {
        if (!bg && el.shadowRoot) find(el.shadowRoot);
      });
    })(document);
    // custom.css: .pf-c-background-image { background-color: #3b2880 !important }
    if (bg && getComputedStyle(bg).backgroundColor === "rgb(59, 40, 128)") {
      html.classList.remove("gotcha-preboot");
      return true;
    }
    return false;
  }

  // Under OS dark-mode, PatternFly sets its text variables (--pf-global--Color--*)
  // to near-white on the flow's NESTED shadow roots via `:host` rules. The
  // GOTCHA login is a fixed LIGHT design (white form on a purple panel), so that
  // dark text (e.g. the "Log in to continue to GOTCHA" subtitle) renders
  // white-on-white and vanishes. custom.css lives at document scope and cannot
  // reach those nested roots, so inject a small light-design correction directly
  // INTO each shadow root - a `:host` rule here beats PatternFly's on equal
  // specificity (later + !important). Idempotent per root.
  function fixDarkText(root) {
    if (!root || !root.querySelectorAll) return;
    // A `:host` <style> injected here loses to PatternFly's own dark `:host`
    // rules on cascade timing, so set the colour INLINE with !important on each
    // element - that beats any stylesheet, guaranteed, and re-applies on every
    // 500ms sweep so a stage re-render can never leave text invisible. Only the
    // white form side has real <p>/label elements (the purple panel copy is
    // CSS pseudo-elements), so this never touches the panel.
    try {
      root.querySelectorAll("p,.pf-c-form__label,.pf-c-form__helper-text,.pf-c-login__main-body,.pf-c-login__main-footer").forEach(function (el) {
        el.style.setProperty("color", "#4b5563", "important");
      });
      root.querySelectorAll(".pf-c-title,h1,h2").forEach(function (el) {
        el.style.setProperty("color", "#111827", "important");
      });
    } catch (e) {}
  }

  function scan(root) {
    if (!root || !root.querySelectorAll) return;
    fixDarkText(root);
    root.querySelectorAll("input[type=password]").forEach(enhance);
    root.querySelectorAll("input[name=code]").forEach(enhanceOtp);
    enhancePwPolicy(root);
    // Drop OTP boxes whose real input's stage has been hidden (flow moved on) -
    // without this, stage transitions can leave the six cells painted orphaned.
    root.querySelectorAll("[data-gotcha-otp]").forEach(function (box) {
      var real = box.parentElement && box.parentElement.querySelector("[data-gotcha-otp-real]");
      if (!real || real.getClientRects().length === 0) box.remove();
    });
    revealRecovery(root);
    clarifyMfa(root);
    // Recurse into open shadow roots.
    root.querySelectorAll("*").forEach(function (el) {
      if (el.shadowRoot) scan(el.shadowRoot);
    });
  }

  function run() {
    try { scan(document); } catch (e) {}
  }

  // The flow content renders inside nested shadow roots AFTER load, and a
  // document-level MutationObserver does NOT observe shadow-DOM mutations - so
  // poll on a light interval (scan is a cheap querySelectorAll sweep). The
  // presence-guard in enhance() makes repeated runs idempotent and re-adds the
  // button whenever a stage re-render wipes it.
  window.__gotchaEnhanceRan = true;
  run();
  var ticks = 0;
  var iv = setInterval(function () {
    run();
    if (++ticks > 120) clearInterval(iv); // ~60s is plenty for any flow
  }, 500);

  // Curtain lift runs on its own FAST interval: the 500ms sweep above would
  // add up to half a second of white screen after the theme is already
  // painted. Stops itself the moment the curtain is up (or was never down -
  // non-flow pages, inline 6s failsafe).
  try {
    if (!liftCurtainIfThemed()) {
      var lifts = 0;
      var liftIv = setInterval(function () {
        var done = true;
        try { done = liftCurtainIfThemed(); } catch (e) {}
        if (done || ++lifts > 80) clearInterval(liftIv); // 80×75ms ≈ the 6s failsafe
      }, 75);
    }
  } catch (e) {}
})();
