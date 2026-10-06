# Automations API contract v1 (design 6: 09c, 09d, 09e)

Status: contract for Frontend, written before the dispatcher is finished. Shapes here are what the
backend will return; anything still being built is marked **(building)**. Owner: backend
(Rebrand-gaps-Backend). Plan: `docs/product/ai-studio-skills-automations.md` §3.3.

Base path: **`/api/automations`** (chatbot service, through the gateway; `/t/:tenant/api/automations`
works too). Auth: the normal session. Reads: any signed-in member of the tenant (as `/api/chatbot-flows`);
writes need `ai:workflows:update` (or ADMIN); activate/pause need `ai:workflows:publish` (or ADMIN).
`/api/chatbot-flows` answers 409 for an automation: edit and activate it only here.

An automation **is** a `ChatbotFlow` that has a structured trigger. Flows without a trigger (the old
sub-flows that the main playbook routes into) are not listed here and keep working as before.

---

## 1. The automation object

```jsonc
{
  "id": "cm...",
  "name": "A call is missed",
  "description": null,                      // free text (the old free-text "trigger" lives here)
  "trigger": {
    "type": "message_received",             // see §3
    "config": { "channels": ["WHATSAPP"], "keywords": ["catalogue"], "match": "contains" }
  },
  "status": "live",                         // "draft" | "live" | "paused"
  "isActive": true,                         // = status === "live"
  "activatedAt": "2026-10-06T10:00:00Z", "activatedBy": { "id": "u1", "name": "Omer" },
  "pausedAt": null, "pausedBy": null,       // set when status is "paused": "paused 12 Aug" + who
  "nodes": [ /* §4 */ ],
  "edges": [ /* §4 */ ],
  "path": [                                 // the row's chip chain (09c), main path from the trigger
    { "nodeId": "t", "type": "automation_trigger", "label": "Call missed" },
    { "nodeId": "n1", "type": "opening_hours", "label": "Open now?" },
    { "nodeId": "n2", "type": "send_buttons", "label": "WhatsApp with buttons" }
  ],
  "stats": { "runsThisWeek": 86, "lastRunAt": "2026-10-06T09:58:00Z", "lastRunStatus": "completed" },
  "updatedAt": "2026-10-06T09:00:00Z",      // send it back as expectedUpdatedAt (409 on a stale save)
  "createdAt": "2026-10-01T09:00:00Z"
}
```

`path`: the trigger, then for each node the FIRST outgoing edge (branch nodes follow their first
branch), stopping at a terminal node or after 6 chips. A node's `label` is `data.label` when the
author set one, otherwise the catalogue name.

## 2. Routes

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/api/automations` | `?status=live\|paused\|draft` | `{ data: Automation[] }` newest first (no `nodes`/`edges` in the list, `path` instead) |
| GET | `/api/automations/catalog` | `?channel=WHATSAPP&after=<nodeId>&automationId=<id>&locale=he` | §5 |
| GET | `/api/automations/:id` | | `{ data: Automation }` |
| POST | `/api/automations` | `{ name, description?, trigger: {type, config}, nodes?, edges? }` | 201 `{ data }`, always **draft** |
| PUT | `/api/automations/:id` | `{ name?, description?, trigger?, nodes?, edges?, expectedUpdatedAt? }` | `{ data }`. A live automation is validated on save: errors → 422 and nothing is stored |
| POST | `/api/automations/:id/validate` | `{ nodes?, edges?, trigger? }` (unsaved canvas) | `{ errors: Issue[], warnings: Issue[] }` |
| POST | `/api/automations/:id/activate` | | `{ data }` live, or 422 `{ error: "validation_failed", errors, warnings }` |
| POST | `/api/automations/:id/pause` | | `{ data }` paused, with `pausedAt/pausedBy` |
| DELETE | `/api/automations/:id` | | `{ success: true }` (its runs are deleted with it) |
| GET | `/api/automations/:id/runs` | `?limit=20&cursor=<runId>&status=` | `{ data: Run[], nextCursor }` |
| GET | `/api/automations/runs/:runId` | | `{ data: Run & { steps: RunStep[] } }` |
| GET | `/api/automations/:id/node-stats` | `?days=7` | `{ data: { [nodeId]: { reached, failed, branches: { [handle]: n } } } }` ("Sent 86 times · 61 tapped a button") |

`Issue = { severity: "error"|"warning", code, nodeId?, message }`. Codes include `no_trigger`, `trigger_node`,
`no_steps`, `trigger_no_event_source`, `trigger_not_connected`, `missing_config`, `too_many_buttons`,
`too_many_options`, `title_too_long`, `duplicate_button`, `channel_not_supported`, `no_customer_on_path`,
`node_unavailable`, `unknown_node`, `unknown_branch`, `no_output`, `cycle`, `broken_edge`, `invalid_delay`.
POST /activate returns `{ data, warnings }`. The same validator gates every way
an automation can go live (activate, and a save while live). `isActive` is not accepted on POST/PUT.

Templates (09c "Start from a template") and versioned draft/publish + the test run (09d "Test",
"Publish changes") are **Phase 3**. Until then "Publish changes" = PUT then (if not live) activate.

### Run and steps (run log)

```jsonc
Run = {
  "id", "automationId", "triggerType",
  "status": "running" | "waiting" | "completed" | "failed" | "skipped",
  "conversationId": "cm..." | null,          // null for schedule / webhook runs without a customer
  "contact": { "id", "name" } | null,
  "startedAt", "endedAt": null | "...",
  "error": null | "send_failed: ...",
  "answeredInbound": true                    // this run was the responder for the message that fired it
}
RunStep = { "nodeId", "nodeType", "status": "ok" | "failed" | "skipped" | "waiting",
            "branch": "yes" | "btn:call_me" | "timeout" | null, "output": { ... } | null, "at" }
```

A run in a conversation the viewer may not see (department rules) is not listed, and
`runs/:runId` is 404 for it.

---

## 3. Triggers (`trigger.type`)

| type | config | fires when | available |
|---|---|---|---|
| `message_received` | `{ channels?: Channel[], keywords?: string[], match?: "contains"\|"exact"\|"any_word" }` | every inbound message (not only the first) on those channels; with keywords, only when one matches | yes |
| `new_customer` | `{ channels?: Channel[] }` | the first message ever from a customer | yes |
| `tag_added` | `{ tags: string[] }` | one of the tags is added to the customer | yes **(building)** |
| `schedule` | `{ at: "09:00", days?: ["sun".."sat"], timezone?: "Asia/Jerusalem" }` | at that time; there is no customer on this path (Send nodes unavailable) | yes **(building)** |
| `webhook` | `{}` | a POST to the automation's webhook URL; the body is `{{body.*}}`. The URL and secret come from the existing `/api/webhook-triggers` (create one with `workflowId` = the automation id) | yes |
| `call_missed` / `call_answered` | `{ lines?: string[] }` | voice call events | only with a connected voice line **(building)** |
| `order_event`, `cart_abandoned`, `form_submitted`, `story_mention` | | | **no**: `reason: "no_event_source"` (drawn dimmed) |

Rules that hold for every trigger:
- **One run per event**: the same event never runs the same automation twice (webhook retries,
  duplicate deliveries).
- **No loops**: a message or tag caused by an automation does not trigger automations, and one
  conversation runs at most 5 automation runs per minute.
- **One responder per inbound**: matching automations run first. If one of them sent something,
  is waiting for a reply, or handed the conversation on, the AI employee does not also answer that
  message. Otherwise the AI answers as today. Automations never run while a person owns the
  conversation.

## 4. Graph

`nodes: [{ id, type, position: {x, y}, data: {...} }]`, `edges: [{ id, source, target, sourceHandle? }]`.
Exactly one `automation_trigger` node (the entry; its settings are `trigger` on the automation). A
branch node's outgoing edges carry the branch in `sourceHandle`. No cycles.

Variables in text: `{{first_name}}`, `{{business_name}}`, `{{opening_hours}}`, `{{var.<name>}}`,
`{{body.<path>}}` (webhook). The catalogue lists the variables per path (§5); render them as chips.

| type | group | data | outputs (`sourceHandle`) |
|---|---|---|---|
| `automation_trigger` | trigger | `{ label? }` | `next` |
| `condition_group` | logic | existing condition shape (`conditions`, `logic: "and"\|"or"`) | `true`, `false` |
| `opening_hours` | logic | `{}` (tenant business hours) | `open`, `closed` |
| `wait` | logic | `{ durationMs }` | `next` |
| `wait_for_reply` | logic | `{ timeoutMs }` | `btn:<buttonId>` per button/list option of the node before it, `reply` (any other message), `timeout` |
| `split_channel` | logic | `{}` | one per channel (`WHATSAPP`, `INSTAGRAM`, `WEBCHAT`, `EMAIL`, ...), `other` |
| `language` | logic | `{ languages: ["he","en","ar"] }` | one per listed language, `other` |
| `segment` | logic | `{}` | `new`, `returning`, `vip` (customer tagged `vip`) |
| `ab_split` | logic | `{ percentA: 50 }` | `a`, `b` |
| `send_message_text` | send | `{ text }` | `next` |
| `send_message_file` | send | `{ url, fileName?, caption? }` | `next` |
| `send_buttons` | send | `{ text, buttons: [{ id, title }] }` (max 3; title max 20) | `next` |
| `send_list` | send | `{ text, buttonText, options: [{ id, title, description? }] }` (max 10, WhatsApp) | `next` |
| `send_message_template` | send | existing template shape | `next` |
| `assign` | do | `{ to: "team"\|"person", departmentId?, userId? }` | `next` |
| `hand_to_ai` | do | `{ aiAgentId }` | none (ends the automation's ownership) |
| `run_skill` | do | `{ skillId, aiAgentId }` | none (ends ownership; the employee runs that skill) |
| `add_tag` | do | `{ tag }` | `next` |
| `update_customer` | do | existing shape | `next` |
| `create_task` | do | `{ title, body?, dueInMinutes? }` (a task in the connected CRM) | `next` |
| `notify_team` | do | `{ message, userIds?: string[], departmentId? }` (in-app) | `next` |
| `close_conversation` | do | `{ message? }` | none |
| `http_request` | do | existing shape | `next` |

A failed Send ends the run as `failed` with the reason, and the conversation goes to the team
queue if no one owns it.

## 5. Catalogue (09e "Add a step")

`GET /api/automations/catalog?channel=WHATSAPP&after=<nodeId>&automationId=<id>`

```jsonc
{
  "data": {
    "context": { "channel": "WHATSAPP" | null, "firstStep": false, "hasCustomer": true,
                 "afterNodeType": "wait_for_reply" },
    "groups": [
      { "key": "trigger" | "logic" | "send" | "do", "label": "Triggers",
        "note": "first step only",              // triggers only
        "items": [{
          "type": "send_buttons",               // a node type, or "trigger:<triggerType>" in the trigger group
          "label": "Buttons", "description": "Up to 3, each a branch",
          "channels": ["WHATSAPP", "INSTAGRAM", "WEBCHAT"],   // [] = works anywhere
          "outputs": ["next"],                  // or "dynamic" for per-button / per-channel branches
          "limits": { "maxButtons": 3, "titleMax": 20 },
          "synonyms": ["buttons", "quick reply", "options"],
          "available": true,
          "reason": null                         // when false: "first_step_only" | "channel_not_supported"
                                                 //   | "no_customer_on_path" | "needs_24h_window"
                                                 //   | "no_event_source" | "not_connected" | "coming_later"
        }]
      }
    ],
    "variables": ["first_name", "business_name", "opening_hours"]
  }
}
```

- `channel` is the path's channel when the caller knows it (the trigger's single channel, or the
  branch of a `split_channel`). Without it, channel-specific nodes are available with their
  `channels` list shown.
- Location, Rating request, SMS and Add row to Sheets are listed with `available: false,
  reason: "coming_later"`.
- Search is client-side over `label`, `description` and `synonyms`.
