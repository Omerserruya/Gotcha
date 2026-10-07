# Website widget API contract v1 (design 13g-13j) - Stage A

One embedded chat (the Web chat and Shopify live chat merged), one settings
screen, one Install step. Served by `services/ai`. Base path `/api/website-widget`.
Plan and background: `docs/product/website-widget.md`.

- One widget per workspace (until Omer decides otherwise), installed in many
  places: the code snippet, Shopify shop(s), later WooCommerce.
- Additive: the snippet (`chatcenter-widget.js`, `window.__chatcenter`), both
  public APIs (`/api/embedded-chat`, `/api/shopify-chat`) and the Shopify theme
  extension keep their names and shapes.
- Permissions: read needs `channels:manage:read`, write `channels:manage:update`
  (ADMIN has both).

---

## 1. Settings

`GET /api/website-widget` →
```jsonc
{
  "data": {
    "settings": WidgetSettings,
    "assignedEmployee": null | { "id": "...", "name": "Maya" },   // read-only: who answers this channel per the playbook (§4)
    "places": {
      "code": { "channelId": "..." } | null,                       // the web chat account (null until the first save)
      "shopify": [{ "channelId": "...", "shopDomain": "lumiere.myshopify.com" }]
    }
  }
}
```

`PUT /api/website-widget` with a partial `WidgetSettings` → `200` the same
shape as GET. The shared settings are written to **every place** at once (the
web chat account, created on the first save, and each Shopify chat account).
Shopify-only settings are not touched here (§3).

### WidgetSettings
Every field maps to a field the bundle already reads; names follow the design.
```jsonc
{
  "appearance": {
    "primaryColor": "#0e7c66",          // "Main colour" (#rrggbb)
    "contrastColor": "#ffffff",
    "logoUrl": "https://..." | null,     // "Logo" (https only)
    "cornerRadius": 20,
    "language": "auto" | "he" | "en",    // "Language"
    "direction": "auto" | "ltr" | "rtl",
    "showPoweredBy": true
  },
  "ux": {
    "welcome": {
      "title": "...", "subtitle": "...",
      "assistantName": "Noa",            // "Assistant name"
      "suggestedQuestions": ["...", "...", "..."],   // "Opening questions" (max 3 shown)
      "avatarUrl": null
      // + presentation fields (avatarSize, textAlign, accentColor, textColor...)
    },
    "launcher": { "position": "right" | "left", "mobilePosition": "...", "label": "...", "showLabel": false /* + size, colours, icon... */ },
    "hero": { "mediaType": "image" | "video" | "none", "mediaUrl": "https://..." | null /* "Cover image" */ },
    "proactive": {
      "enabled": true,                   // "Pop-up message" on/off
      "message": "Questions? We're here.",   // the pop-up's text
      "title": "...",
      "trigger": "...", "delaySeconds": 8,   // "When to show"
      "maxPerVisitor": 1                 // "once per visit" and the like
      // + the rest of the proactive rules
    },
    "sounds": { /* ... */ }, "behavior": { /* ... */ }
  },
  "handoff": { "allowHumanHandoff": true },
  "offline": { "message": "We're away right now..." }
}
```
The exact field lists are the shared `ShopifyChatUx` type (`packages/shared/src/lib/shopify-chat-ux.ts`)
and `WebchatConfig.appearance` (`webchat-widget.ts`); every value is normalised
on write (an unknown or invalid value falls back to its default, never 400s).
Text fields are plain text (no markup), URLs https only.

**Stage B (not yet):** `look: "gotcha" | "whatsapp"` and
`whatsapp: { enabled, numberId }` ("Continue on WhatsApp"). Absent in A.

---

## 2. Install

`GET /api/website-widget/install` →
```jsonc
{
  "data": {
    "code": {
      "widgetId": "widget_...",
      "snippet": "<script>window.__chatcenter={...}</script><script src=\".../widget/chatcenter-widget.js\" async></script>",
      "status": "not_seen" | "live",       // live once a page loaded it
      "firstSeenAt": "..." | null,
      "lastSeenAt": "..." | null,          // the latest page load (throttled, ~hourly)
      "lastHost": "shop.example.com" | null
    } | null,                              // null until the widget exists (first PUT)
    "shopify": [{
      "channelId": "...",
      "shopDomain": "lumiere.myshopify.com",
      "status": "active" | "not_enabled" | "uninstalled",
      "embedLive": true,                   // the theme's app embed loaded recently (heartbeat)
      "lastHeartbeatAt": "..." | null,
      "themeEditorUrl": "https://admin.shopify.com/..." | null
    }],
    "shopifyInstallUrl": "/api/connectors/shopify/install?..." | null,   // "Install on Shopify": the existing OAuth install, bound to this workspace
    "woocommerce": { "status": "use_code" }   // until the plugin (stage C): install with the code snippet
  }
}
```

---

## 3. Shopify-only settings (unchanged)

Product messages, add to cart, carousel size, privacy and offline behaviour per
shop stay on the existing `PUT /api/shopify-live-chat/channels/:id`. In the
public config, product messages and add to cart are now on by source: a
Shopify place yes, the code snippet no (stage A).

---

## 4. "Assigned AI employee"

Read-only in stage A: who answers the website channel according to the
playbook (its route for the channel), or `null` when the playbook routes it
nowhere specific. The playbook stays the one place that decides who answers;
editing it from this screen waits for Omer's decision (plan, "Decisions").

---

## 5. Errors

`403` without the permission; `404` never for GET (an absent widget is
`places.code: null`); `409 WIDGET_LIMIT` when the plan has no room for another
channel (first save only); PUT never fails on a bad value (normalised).
