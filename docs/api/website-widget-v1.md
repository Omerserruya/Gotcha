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
      "code": { "channelId": "..." } | null,                       // the web chat account (null until it is created, §1)
      "shopify": [{ "channelId": "...", "shopDomain": "lumiere.myshopify.com" }]
    }
  }
}
```

`PUT /api/website-widget` with a partial `WidgetSettings` → `200` the same
shape as GET. The shared settings are written to **every place** at once (the
web chat account and each Shopify chat account). Shopify-only settings are not
touched here (§3).

PUT never creates a place. The web chat account is created by the existing,
idempotent `POST /api/channels/webchat/create` (it owns the plan's channel
limit; the Install tab's "Get the code" calls it). With no place at all (no web
chat, no Shopify chat) PUT answers `409 { "code": "WIDGET_NOT_CREATED" }`:
nothing to save to yet. A workspace with only a Shopify chat can PUT (its
shop(s) get the settings) and GET reads the settings from its first shop.

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

**Stage B (2026-10-07):** two more `ux` fields, saved like the rest:
- `ux.look`: `"gotcha"` (default) | `"whatsapp"`: the customer-side panel style.
  An unknown value falls back to `"gotcha"`.
- `ux.whatsapp`: `{ enabled: boolean, channelAccountId: string | null }`
  ("Continue on WhatsApp"). The number must be one of the workspace's
  WhatsApp channels: another id is `422 { code: "WHATSAPP_NUMBER_NOT_FOUND",
  field: "ux.whatsapp.channelAccountId" }`.

GET also returns `whatsappNumbers: [{ channelId, name, phone, available,
reason? }]` for the picker. `reason`: `"not_connected"`, or `"number_unknown"`
(connected before the number's phone was recorded; reconnecting records it).
Only an `available` number makes the button show.

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
    } | null,                              // null until the web chat account exists (§1)
    "shopify": [{
      "channelId": "...",
      "shopDomain": "lumiere.myshopify.com",
      "status": "active" | "not_enabled" | "uninstalled",
      "embedLive": true,                   // the theme's app embed loaded recently (heartbeat)
      "lastHeartbeatAt": "..." | null,
      "themeEditorUrl": "https://admin.shopify.com/..." | null
    }],
    "woocommerce": { "status": "use_code" }   // until the plugin (stage C): install with the code snippet
  }
}
```
"Install on Shopify" is the existing ShopifyConnect flow (availability, then
`start?flow=...`, then claim); this endpoint does not return a URL for it.
`lastSeenAt` / `lastHost` come from the snippet's `/bootstrap` (host from the
page's Origin, else Referer), written at most hourly. `embedLive` means a theme
heartbeat within the last 7 days.

---

## 2b. The visitor's side (public, `/api/embedded-chat`)

- `POST /bootstrap` → `widget.ux.look`; `widget.features.whatsappHandoff`
  (true only when on AND its number is available); when true,
  `widget.whatsapp: { label }` ("המשך בוואטסאפ" / "Continue on WhatsApp", by
  the widget's language). The number never reaches the page.
- `POST /whatsapp-handoff { sessionId, sessionToken, locale? }` →
  `{ data: { url, ref } }`: open `url` (wa.me with the message pre-filled:
  "היי, ממשיכים את השיחה מהאתר (REF)" / "Hi, continuing our chat from the
  website (REF)"). The same conversation keeps the same `ref` for 7 days.
  `404 { error: "unavailable" }` when the button should not be there or the
  token is not this conversation's.
- When the customer sends that message, the WhatsApp conversation is linked to
  the website one (stage B part 2: same customer, the website chat's history as
  context, the website chat closed as continued on WhatsApp).

---

## 3. Shopify-only settings (unchanged)

Product messages, add to cart, carousel size, privacy and offline behaviour per
shop stay on the existing `PUT /api/shopify-live-chat/channels/:id`. In the
public config, product messages and add to cart are now on by source: a
Shopify place yes, the code snippet no (stage A).

---

## 4. "Assigned AI employee"

Omer's decision (2026-10-08): the widget screen may set who answers, and it
writes THE PLAYBOOK (one source: the playbook stays the only place that
decides who answers; nothing is stored on the widget). `assignedEmployee` in
`GET /api/website-widget` stays as it was (web chat, read-only).

Permission for both routes: role ADMIN, the same as editing the playbook
(`PUT /api/flow-canvas`). `403` otherwise.

### 4.1 Read: `GET /api/website-widget/assignment`

```jsonc
{ "data": {
  "channels": [                         // the widget's places: the code snippet, and Shopify if any
    { "channel": "WEBCHAT",
      "employee": { "id": "...", "name": "Maya" } | null,
      "how": "always" | "conditional" | "team" | "flow" | "none",
      //   always: every conversation on this channel goes to `employee`
      //   conditional: conditions in the playbook decide (hours, a choice...): `employee` null
      //   team: the playbook sends it to a team / department, not an employee
      //   flow: the playbook sends it to a chatbot flow
      //   none: the playbook routes this channel nowhere
      "editable": true,                 // false when "conditional": change it in the playbook editor
      "dedicated": true,                // the playbook has an entry for this channel of its own
      "sharedWith": ["WHATSAPP"] }      // other channels that reach the SAME route: changing it changes them too
  ],
  "employees": [{ "id": "...", "name": "Maya", "active": true }]   // to choose from (active ones are choosable)
} }
```

### 4.2 Write: `PUT /api/website-widget/assignment`

Body: `{ "employeeId": "...", "channels"?: ["WEBCHAT", "SHOPIFY_LIVE_CHAT"], "includeShared"?: boolean }`
(`channels` omitted = every channel of the widget). For each channel:
- its path does not branch and its route serves only channels in the request:
  that route now goes to this employee (a route to a team becomes a route to
  the employee);
- its route is shared with other channels (`sharedWith`): when the playbook
  already has channel entries, a dedicated entry and route are added for this
  channel (appended, so no other channel's entry changes); when it has none
  (a single start for every channel), `409 { code: "PLAYBOOK_SHARED", channels,
  sharedWith }`, and resending with `includeShared: true` changes the shared
  route, for those channels too ("Maya answers the website and WhatsApp:
  change for both?");
- conditions decide it (`how: "conditional"`): `409 { code: "PLAYBOOK_CONDITIONAL",
  channels: [...] }`.
A 409 writes NOTHING (no channel half-changed). Why entries are never added to
a playbook with none: the playbook's rule is "the channel's own entry, else the
FIRST channel entry, else start", so a first entry for the website would carry
every other channel with it.

`422 { code: "EMPLOYEE_NOT_FOUND" }` for an id that is not an active employee of
this workspace; `422 { code: "NO_WIDGET_CHANNEL" }` when `channels` names none of
the widget's; `409 { code: "WIDGET_NOT_CREATED" }` when the widget has no
place. `200` returns the read shape (§4.1) after the write, plus
`changed: [{ channel, from: { id, name } | null, created: boolean }]` (a shared
route changed with `includeShared` lists every channel it serves). The
playbook's `updatedBy` is the caller and an audit entry
`playbook.route_updated` names the channels.

Note: the playbook editor saves the whole canvas. A playbook tab left open
from before this change would overwrite it on its next save; the screen
should say "this changes the playbook" and the editor should reload on focus.

---

## 5. Errors

`403` without the permission; `404` never for GET (an absent widget is
`places.code: null`); `409 WIDGET_NOT_CREATED` on PUT when there is no place
yet (the plan's channel limit is answered by `POST /api/channels/webchat/create`);
PUT never fails on a bad value (normalised).
