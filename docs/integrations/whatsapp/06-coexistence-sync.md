# 06 - Coexistence sync: the business app and GOTCHA showing one thread

When a number runs in Coexistence, two things can send on it: the WhatsApp
Business app on the owner's phone, and GOTCHA through the Cloud API. Without
sync, each side sees half a conversation.

Meta closes that gap with webhooks. This document covers the half we ingest
today, what it costs, and what is deliberately left out.

---

## 1. What Meta offers

| Webhook field | Carries | Ingested today |
|---|---|---|
| `smb_message_echoes` | Messages the owner sent **from the WhatsApp Business app** | **Yes** |
| `history` | Up to 180 days of prior chats, in three phases, on connect | No |
| `smb_app_state_sync` | The app's contacts | No |
| `message_echoes` | Messages sent through the **Cloud API**, including our own | No, on purpose (section 5) |

The other direction needs no webhook: a message GOTCHA sends through the Cloud
API already appears in the owner's app, because it is the same number.

---

## 2. The path an echo takes

```
WhatsApp Business app (owner types)
  → Meta: entry[].changes[].field = "smb_message_echoes"
  → services/webhook  POST /api/webhook
      signature verified (fail-closed, unchanged)
      whatsAppInboundAdapter.extractOutboundEchoes()
      → incomingMessageQueue.add("process-echo", …)
  → services/incoming-worker  dispatch()
      → outbound-echo.service.processOutboundEcho()
          Message row, direction OUTBOUND
          conversation taken away from the AI
          system divider "whatsapp_app_takeover"
          message:new + conversation:updated
```

Separate job name, separate handler. An echo never touches
`processIncomingMessage`.

---

## 3. Two properties that are easy to get wrong

**The conversation key is `to`, not `from`.** An echo's `from` is our own
business number and its `to` is the customer. Keying on `from` opens a
conversation with ourselves and strands the reply outside the customer's
thread.

**An echo is OUTBOUND.** Sending it down the inbound path would make the
business a customer, hand its own message to the bot, and run language
detection and identity-link against our own copy.

Both are pinned in `packages/shared/src/__tests__/whatsapp-echo-adapter.test.ts`.

---

## 4. The takeover

A person picking up the phone and typing is the same signal as
`escalate_to_human`, so it has the same effect:

| Field | Set to | Why |
|---|---|---|
| `isHandedOver` | `true` | The one latch every AI entry point reads. `ai-bot.service` returns early on it and the incoming worker skips bot processing on it, so this is what actually stops the AI. |
| `handledBy` | `"human"` | Ownership follows the handoff. |
| `status` | `OPEN` | **Not** `WAITING`. Waiting means queued for a human to pick up; here the human already answered. Marking it `WAITING` puts an already-handled chat back in the needs-attention queue. |
| `chatbotFlowId`, `chatbotNodeId` | `null` | A parked flow cursor is a live claim on the customer's next message. Left set, the flow resumes and talks over the person who just took over. |

**No handoff message is sent to the customer.** Every other escalation path
sends one ("connecting you with a representative"). Here the representative has
already replied, and announcing the handoff after the fact reads worse than
saying nothing.

A `whatsapp_app_takeover` system divider records it on the timeline. Without it
the thread shows an outbound message from nobody and an AI that silently
stopped.

Returning the conversation to the AI uses the existing path
(`conversation.service.returnToAi`); nothing about this handoff is special.

---

## 5. Why `message_echoes` is excluded

It mirrors Cloud API sends, which includes every message GOTCHA sends. The
dedupe key is `Message.externalMessageId`, and the outbound worker writes that
only **after** the send call returns. The echo can arrive first, so ingesting
this field would post our own replies into the thread a second time.

Adding it means first giving the outbound path a pre-send idempotency key. The
field name is a single constant (`WA_ECHO_FIELD` in `whatsapp.adapter.ts`), so
the parsing side is one line once that exists.

---

## 6. Configuration required (not code)

In the Meta App Dashboard, on the app's Webhooks product, subscribe the
WhatsApp Business Account object to **`smb_message_echoes`**.

`POST /<WABA_ID>/subscribed_apps`, which onboarding already calls, subscribes
the app to the WABA. It does **not** choose fields. An unsubscribed field is
simply never delivered, with no error anywhere, so the symptom is "the feature
does nothing" rather than a failure.

Prerequisites that sit upstream of this working at all:

1. The number must be onboarded through Coexistence, which requires
   `extras.featureType = "whatsapp_business_app_onboarding"`
   (`WHATSAPP_ES_FEATURE_TYPE`). See [03-architecture.md](./03-architecture.md)
   section on flow selection.
2. Coexistence has a **24 hour** window after onboarding to sync contacts and
   history, otherwise the customer must be offboarded and reconnected.

---

## 7. Not built

- **`history`.** 180 days arrive as a bulk payload in three phases, not as
  individual messages. It needs its own importer that writes messages without
  waking bots, flows, notifications or analytics for six months of old traffic.
  Ingesting it through this path would fire the whole live pipeline retroactively.
- **`smb_app_state_sync`** (contacts). Needs a merge rule against existing
  `Contact` rows before it can be trusted to write.
- **`account_update` / `PARTNER_REMOVED`**, the signal that the customer
  disconnected Coexistence from their phone. Until it is handled, a
  disconnected number keeps its CONNECTED row.

---

## 8. Coexistence limits worth repeating

Fixed **20 messages per second**, not scalable. Group chats, calls,
disappearing messages, view-once, live location and broadcast lists are not
supported on a Coexistence number. Full list in
[01-meta-api-inventory.md](./01-meta-api-inventory.md) section 6.
