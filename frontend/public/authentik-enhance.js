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

  function scan(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll("input[type=password]").forEach(enhance);
    root.querySelectorAll("input[name=code]").forEach(enhanceOtp);
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
})();
