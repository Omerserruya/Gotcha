(function() {
  "use strict";

  var config = window.__chatcenter || {};
  var API_URL = config.apiUrl || "";
  var WIDGET_ID = config.widgetId || "";
  // Persistent visitor ID (survives browser close, identifies returning visitors)
  var VISITOR_ID = localStorage.getItem("cc_visitor_" + WIDGET_ID) || "";

  // Per-tab session ID (prevents cross-tab message collision)
  var SESSION_ID = sessionStorage.getItem("cc_session_" + WIDGET_ID) || "";
  if (!SESSION_ID) {
    SESSION_ID = "sess_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9);
    sessionStorage.setItem("cc_session_" + WIDGET_ID, SESSION_ID);
  }
  var POLL_INTERVAL = null;
  var LAST_MESSAGE_TIME = "";
  var IS_OPEN = false;
  var UNREAD = 0;
  var RENDERED_MSG_IDS = {};
  var PENDING_OUTGOING = 0;
  var SESSION_INITIALIZED = false;

  // Customization
  var BRAND_COLOR = config.color || "#7c3aed";
  // Auto-derive darker shade for hover by darkening the brand color
  function darkenColor(hex, amount) {
    var num = parseInt(hex.replace("#", ""), 16);
    var r = Math.max(0, (num >> 16) - amount);
    var g = Math.max(0, ((num >> 8) & 0x00FF) - amount);
    var b = Math.max(0, (num & 0x0000FF) - amount);
    return "#" + (0x1000000 + r * 0x10000 + g * 0x100 + b).toString(16).slice(1);
  }
  var BRAND_COLOR_HOVER = config.colorHover || darkenColor(BRAND_COLOR, 20);
  var ICON_URL = config.iconUrl || "";
  var TITLE = config.title || "Chat with us";
  var SUBTITLE = config.subtitle || "We typically reply instantly";
  var WELCOME = config.welcome || "Hi there! How can we help you today?";
  var POSITION = config.position || "right";

  // Notification sound (short beep using Web Audio API)
  var audioCtx = null;
  function playNotificationSound() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.frequency.value = 800;
      gain.gain.value = 0.15;
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
      osc.stop(audioCtx.currentTime + 0.3);
    } catch(e) {}
  }

  // Styles
  var posRight = POSITION !== "left";
  var STYLES = `
    #cc-widget-container * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    #cc-widget-btn {
      position: fixed; bottom: 24px; ${posRight ? "right" : "left"}: 24px; z-index: 99998;
      width: 60px; height: 60px; border-radius: 50%;
      background: ${ICON_URL ? "transparent" : "linear-gradient(135deg, " + BRAND_COLOR + ", " + BRAND_COLOR_HOVER + ")"};
      border: none; cursor: pointer;
      box-shadow: ${ICON_URL ? "0 4px 24px rgba(0,0,0,0.2)" : "0 4px 24px " + BRAND_COLOR + "66"};
      display: flex; align-items: center; justify-content: center;
      transition: transform 0.2s, box-shadow 0.2s;
      ${ICON_URL ? "padding: 0; overflow: hidden;" : ""}
    }
    #cc-widget-btn:hover { transform: scale(1.08); box-shadow: ${ICON_URL ? "0 6px 32px rgba(0,0,0,0.3)" : "0 6px 32px " + BRAND_COLOR + "80"}; }
    #cc-widget-btn svg { width: 28px; height: 28px; fill: white; }
    #cc-widget-btn img { width: 60px; height: 60px; border-radius: 50%; object-fit: cover; }
    #cc-widget-badge {
      position: absolute; top: -4px; ${posRight ? "right" : "left"}: -4px;
      background: #ef4444; color: white; font-size: 11px; font-weight: 700;
      min-width: 20px; height: 20px; border-radius: 10px;
      display: none; align-items: center; justify-content: center; padding: 0 5px;
    }
    #cc-widget-window {
      position: fixed; bottom: 96px; ${posRight ? "right" : "left"}: 24px; z-index: 99999;
      width: 380px; max-width: calc(100vw - 32px); height: 520px; max-height: calc(100vh - 120px);
      background: white; border-radius: 16px;
      box-shadow: 0 8px 48px rgba(0,0,0,0.15);
      display: none; flex-direction: column; overflow: hidden;
      animation: cc-slide-up 0.3s ease;
    }
    @keyframes cc-slide-up { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
    #cc-widget-header {
      padding: 16px 20px; background: linear-gradient(135deg, ${BRAND_COLOR}, ${BRAND_COLOR_HOVER});
      color: white; display: flex; align-items: center; gap: 12px; flex-shrink: 0;
    }
    #cc-widget-header-avatar {
      width: 36px; height: 36px; border-radius: 50%;
      background: rgba(255,255,255,0.2); display: flex; align-items: center; justify-content: center;
      font-weight: 700; font-size: 14px;
    }
    #cc-widget-header-info h4 { font-size: 14px; font-weight: 600; }
    #cc-widget-header-info p { font-size: 11px; opacity: 0.8; margin-top: 2px; }
    #cc-widget-close {
      margin-left: auto; background: rgba(255,255,255,0.15); border: none;
      width: 28px; height: 28px; border-radius: 8px; cursor: pointer;
      display: flex; align-items: center; justify-content: center; transition: background 0.2s;
    }
    #cc-widget-close:hover { background: rgba(255,255,255,0.3); }
    #cc-widget-close svg { width: 14px; height: 14px; stroke: white; fill: none; }
    #cc-widget-messages {
      flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 12px;
      background: #f9fafb;
    }
    .cc-msg { max-width: 80%; padding: 14px 18px; border-radius: 16px; font-size: 14px; line-height: 1.6; word-wrap: break-word; word-break: break-word; white-space: pre-wrap; }
    .cc-msg-in { background: white; color: #1f2937; border: 1px solid #e5e7eb; border-bottom-left-radius: 4px; align-self: flex-start; }
    .cc-msg-out { background: ${BRAND_COLOR}; color: white; border-bottom-right-radius: 4px; align-self: flex-end; }
    .cc-msg-time { font-size: 10px; opacity: 0.5; margin-top: 4px; }
    .cc-typing { align-self: flex-start; display: flex; gap: 4px; padding: 12px 16px; background: white; border: 1px solid #e5e7eb; border-radius: 16px; border-bottom-left-radius: 4px; }
    .cc-typing span { width: 6px; height: 6px; background: #9ca3af; border-radius: 50%; animation: cc-bounce 1.2s infinite; }
    .cc-typing span:nth-child(2) { animation-delay: 0.15s; }
    .cc-typing span:nth-child(3) { animation-delay: 0.3s; }
    @keyframes cc-bounce { 0%,80%,100% { transform: translateY(0); } 40% { transform: translateY(-6px); } }
    #cc-widget-input-area {
      padding: 12px 16px; border-top: 1px solid #e5e7eb; background: white;
      display: flex; align-items: flex-end; gap: 8px; flex-shrink: 0;
    }
    #cc-widget-input {
      flex: 1; border: 1px solid #e5e7eb; border-radius: 12px; padding: 10px 14px;
      font-size: 13px; resize: none; outline: none; max-height: 80px;
      font-family: inherit; transition: border-color 0.2s;
    }
    #cc-widget-input:focus { border-color: ${BRAND_COLOR}; }
    #cc-widget-send {
      width: 38px; height: 38px; border-radius: 12px; border: none;
      background: ${BRAND_COLOR}; cursor: pointer; display: flex; align-items: center; justify-content: center;
      transition: background 0.2s; flex-shrink: 0;
    }
    #cc-widget-send:hover { background: ${BRAND_COLOR_HOVER}; }
    #cc-widget-send:disabled { opacity: 0.4; cursor: default; }
    #cc-widget-send svg { width: 16px; height: 16px; fill: none; stroke: white; stroke-width: 2; }
    #cc-widget-powered {
      text-align: center; padding: 6px; font-size: 10px; color: #9ca3af;
      background: white; border-top: 1px solid #f3f4f6;
    }
    #cc-widget-powered a { color: ${BRAND_COLOR}; text-decoration: none; }
    @media (max-width: 480px) {
      #cc-widget-window { bottom: 0; right: 0; width: 100vw; height: 100vh; max-height: 100vh; border-radius: 0; }
      #cc-widget-btn { bottom: 16px; right: 16px; width: 52px; height: 52px; }
    }
  `;

  function injectStyles() {
    var style = document.createElement("style");
    style.textContent = STYLES;
    document.head.appendChild(style);
  }

  function createWidget() {
    var container = document.createElement("div");
    container.id = "cc-widget-container";
    container.innerHTML = `
      <button id="cc-widget-btn" aria-label="Open chat">
        ${ICON_URL ? '<img src="' + ICON_URL + '" alt="Chat">' : '<svg viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/></svg>'}
        <span id="cc-widget-badge">0</span>
      </button>
      <div id="cc-widget-window">
        <div id="cc-widget-header">
          <div id="cc-widget-header-avatar">C</div>
          <div id="cc-widget-header-info">
            <h4>${TITLE}</h4>
            <p>${SUBTITLE}</p>
          </div>
          <button id="cc-widget-close">
            <svg viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
        <div id="cc-widget-messages"></div>
        <div id="cc-widget-input-area">
          <textarea id="cc-widget-input" placeholder="Type a message..." rows="1"></textarea>
          <button id="cc-widget-send" disabled>
            <svg viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5"/></svg>
          </button>
        </div>
        <div id="cc-widget-powered">Powered by <a href="https://gotcha.co.il" target="_blank">GOTCHA</a></div>
      </div>
    `;
    document.body.appendChild(container);
  }

  function getEl(id) { return document.getElementById(id); }

  function toggleWidget() {
    IS_OPEN = !IS_OPEN;
    var win = getEl("cc-widget-window");
    win.style.display = IS_OPEN ? "flex" : "none";
    if (IS_OPEN) {
      UNREAD = 0;
      updateBadge();
      scrollToBottom();
      getEl("cc-widget-input").focus();
      if (!SESSION_INITIALIZED) initSession();
    }
  }

  function updateBadge() {
    var badge = getEl("cc-widget-badge");
    if (UNREAD > 0) {
      badge.textContent = UNREAD > 9 ? "9+" : UNREAD;
      badge.style.display = "flex";
    } else {
      badge.style.display = "none";
    }
  }

  function scrollToBottom() {
    var el = getEl("cc-widget-messages");
    setTimeout(function() { el.scrollTop = el.scrollHeight; }, 50);
  }

  function addMessage(text, direction, animate) {
    var el = getEl("cc-widget-messages");
    var div = document.createElement("div");
    div.className = "cc-msg " + (direction === "OUTBOUND" ? "cc-msg-in" : "cc-msg-out");
    div.textContent = text;
    if (animate) {
      div.style.opacity = "0";
      div.style.transform = "translateY(8px)";
      div.style.transition = "opacity 0.2s, transform 0.2s";
      setTimeout(function() { div.style.opacity = "1"; div.style.transform = "translateY(0)"; }, 10);
    }
    el.appendChild(div);
    scrollToBottom();
  }

  function showTyping() {
    var el = getEl("cc-widget-messages");
    var existing = el.querySelector(".cc-typing");
    if (existing) return;
    var div = document.createElement("div");
    div.className = "cc-typing";
    div.innerHTML = "<span></span><span></span><span></span>";
    el.appendChild(div);
    scrollToBottom();
  }

  function hideTyping() {
    var el = getEl("cc-widget-messages");
    var t = el.querySelector(".cc-typing");
    if (t) t.remove();
  }

  async function initSession() {
    try {
      var res = await fetch(API_URL + "/api/embedded-chat/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ widgetId: WIDGET_ID, visitorId: VISITOR_ID, sessionId: SESSION_ID, pageUrl: window.location.href }),
      });
      var data = await res.json();
      if (data.data) {
        SESSION_ID = data.data.sessionId;
        VISITOR_ID = data.data.visitorId;
        SESSION_INITIALIZED = true;
        localStorage.setItem("cc_visitor_" + WIDGET_ID, VISITOR_ID);
        sessionStorage.setItem("cc_session_" + WIDGET_ID, SESSION_ID);
        loadMessages();
        startPolling();
      }
    } catch(e) {
      console.error("[ChatCenter] Init failed:", e);
    }
  }

  async function loadMessages() {
    if (!SESSION_ID) return;
    try {
      var url = API_URL + "/api/embedded-chat/messages/" + SESSION_ID;
      if (LAST_MESSAGE_TIME) url += "?after=" + encodeURIComponent(LAST_MESSAGE_TIME);
      var res = await fetch(url);
      var data = await res.json();
      if (data.data && data.data.length > 0) {
        var newInbound = 0;
        data.data.forEach(function(msg) {
          if (RENDERED_MSG_IDS[msg.id]) return;
          RENDERED_MSG_IDS[msg.id] = true;
          LAST_MESSAGE_TIME = msg.createdAt;
          // Skip INBOUND messages we already rendered locally when sending
          if (msg.direction === "INBOUND" && PENDING_OUTGOING > 0) {
            PENDING_OUTGOING--;
            return;
          }
          addMessage(msg.body, msg.direction, true);
          if (msg.direction === "OUTBOUND" && !IS_OPEN) newInbound++;
        });
        if (newInbound > 0) {
          UNREAD += newInbound;
          updateBadge();
          playNotificationSound();
        }
        hideTyping();
      }
    } catch(e) {}
  }

  function startPolling() {
    if (POLL_INTERVAL) clearInterval(POLL_INTERVAL);
    POLL_INTERVAL = setInterval(loadMessages, 3000);
  }

  async function sendMessage() {
    var input = getEl("cc-widget-input");
    var text = input.value.trim();
    if (!text) return;
    if (!SESSION_INITIALIZED) await initSession();
    if (!SESSION_INITIALIZED) return;

    input.value = "";
    getEl("cc-widget-send").disabled = true;
    addMessage(text, "INBOUND", true);
    PENDING_OUTGOING++;
    showTyping();

    try {
      await fetch(API_URL + "/api/embedded-chat/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: SESSION_ID, visitorId: VISITOR_ID, body: text }),
      });
    } catch(e) {
      console.error("[ChatCenter] Send failed:", e);
      hideTyping();
    }
  }

  function init() {
    if (!WIDGET_ID) { console.error("[ChatCenter] Missing widgetId"); return; }
    injectStyles();
    createWidget();

    getEl("cc-widget-btn").addEventListener("click", toggleWidget);
    getEl("cc-widget-close").addEventListener("click", toggleWidget);

    var input = getEl("cc-widget-input");
    var sendBtn = getEl("cc-widget-send");

    input.addEventListener("input", function() {
      sendBtn.disabled = !input.value.trim();
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 80) + "px";
    });

    input.addEventListener("keydown", function(e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    sendBtn.addEventListener("click", sendMessage);

    // Welcome message
    addMessage(WELCOME, "OUTBOUND", false);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
