# Conversation relevance

Status: phase 1 BUILT (classifier and read-only dry run). Phase 2 DESIGN (schema, Gate 1, inbox API).
Asked by Omer on 2026-11-17. It must be generic: no per-tenant keyword lists or patterns.

## What it decides

For each conversation, one label, re-evaluated when new inbound arrives:

| category | meaning | AI reply | inbox |
|---|---|---|---|
| business | a customer or lead about what the business sells or does | yes | normal |
| reply_to_outbound | the business wrote first, the other side answers (supplier, hotel, outreach) | no, a person started it | normal, no chip |
| personal | a private chat, not about the business | no, no handoff | "not relevant" |
| notice | invoices, receipts, system notices, resets, login alerts, own-purchase shipping | no, no handoff | "not relevant" |
| marketing | newsletters, promotions, ads, cold pitches TO the business | no, no handoff | "not relevant" |
| unclear | the model is truly unsure | yes (as today) | normal |

## Phase 1 (built): `services/ai/src/services/conversation-relevance.service.ts`

1. Fast path, no model call: the reply engine's `automatedInbound` (bulk headers, sending domains,
   no-reply senders, notice footers). A list or a sending domain is marketing; everything else is a notice.
2. Otherwise ONE small call on the default model. The input: the business profile (name, industry,
   description, what the AI employee says it sells), the channel, who wrote first, the last 8 messages
   (direction and up to 300 characters each), and for email the sender and subject. The output is
   JSON `{category, confidence, reason}`, read defensively (anything unreadable is unclear with confidence 0).
3. Platform-paid: the call runs in `platformPaidScope({reason: "conversation_classify"})`, so its usage
   row gets the `_classify` feature suffix. `NOT_REPLAY` (ai budgets) and `NOT_REPLAY_USAGE` (shared:
   billing, analytics) leave it out of every tenant figure.
4. `shouldReclassify`: never over an override; otherwise only after a new inbound, and only when the
   label is older than 6h or its confidence is below 0.7.

Dry run: `npx tsx src/scripts/classify-dry-run.ts --tenant <id> --days 60 --out <file>` inside the ai
container. It writes nothing to the database. The report has counts per category and channel, a
confidence histogram, 15 samples per category, and every silencing label under 0.85 for manual review.
The report holds first lines (up to 80 characters) for the reviewer; the console prints counts only.

## Phase 2 (design; needs a migration, so Omer's word first)

### Schema: columns on `conversations`, not JSON

Columns so the inbox filters and counts can use an index:

```
relevance_category      text      null   -- business | reply_to_outbound | personal | notice | marketing | unclear
relevance_confidence    real      null
relevance_reason        text      null   -- at most 120 characters
relevance_source        text      null   -- fast | model | override
relevance_classified_at timestamptz null
relevance_overridden_by text      null   -- platform user id
relevance_overridden_at timestamptz null
@@index([tenantId, relevanceCategory])
```

Null means not classified. An override writes category, source "override", overriddenBy and overriddenAt;
the classifier never relabels it (`shouldReclassify`).

### Who writes it

The ai service classifies, because it is the only service that may call a model. It writes through the
conversation service's API (a new internal `PUT /internal/conversations/:id/relevance`), not straight to
the table. The inbox override is a public `PUT /api/conversations/:id/relevance` on the conversation
service, with the same permission as sending a message in that conversation.

### Engine Gate 1

The old exits stay first, as fast paths: automatedInbound, internalSender, human_owned:person_recent,
placeholderOnly. Then:

- A person's override is read FIRST and wins over every classifier rule, the fast paths included: "business"
  on a conversation the classifier called internal or auto_reply means the AI answers again.
- New categories (dry run review, 2026-11-17): auto_reply (another business's greeting or away message)
  joins the "not relevant" folder; internal (the tenant's own team) keeps the AI out but stays in the
  normal views with a "צוות" chip. Neither needs a migration (the column is text).

- If `shouldReclassify`, classify **in parallel** with the turn's context load, so the extra call adds
  little latency. A conversation that already has a fresh label costs nothing.
- personal, notice or marketing with confidence >= 0.7 (or overridden): no reply and no handoff.
  The trace records `gate1: relevance:<category>`.
- reply_to_outbound with confidence >= 0.7: no reply (a person started it), shown normally.
- business, unclear, or any label under 0.7: the engine replies as today. When unsure, it answers.
- A classifier error or timeout (3s) counts as unclear: the turn goes on.

Rollout flag `RELEVANCE_GATE=off|shadow|on`. Shadow labels and records the trace but never silences;
it runs on a tenant until the shadow labels match a person's review, and only then goes `on`.

### Inbox API (agreed with Frontend-Team on 2026-11-17)

- Each row on `GET /api/conversations` and `GET /api/conversations/:id` carries `relevance:
  {category, confidence, reason, source, classifiedAt, overriddenBy, overriddenAt} | null`.
- `view=irrelevant`: effective category in (personal, notice, marketing), any status.
- `hideIrrelevant=true` on any list: excludes those three. Without the param, nothing changes.
- `unread-counts` accepts the view `irrelevant` and `hideIrrelevant=true`. The home or waiting badge route
  is still to be checked.
- `PUT /api/conversations/:id/relevance {category: "business" | "personal"}` returns the relevance object.
- `conversation:updated` carries `relevance` when it changes.
