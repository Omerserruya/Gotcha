# Historical Import: first real customer runbook

An exact checklist for the first live Coexistence onboarding with history sync.

Read section 0 before the customer touches anything. Two of the checks there
cannot be repeated: Meta grants **one** history sync per onboarding, and it
expires **24 hours** after signup. Getting them wrong costs the customer their
history until they offboard and start again.

Throughout, `psql` means:

```bash
docker compose exec -T db psql -U postgres -d whatsapp_cc -c "<SQL>"
```

and on production, the same through the deployed database. Replace `<TENANT>`
with the tenant id.

---

## 0. Before the customer connects

**0.1 The three webhook fields are subscribed.** In the Meta App Dashboard, on
the WhatsApp product's webhook configuration, confirm all three are ticked:

- `messages`
- `smb_message_echoes`
- `history`   ← the new one; without it nothing in this feature ever fires

Missing `history` is silent. Onboarding succeeds, the channel works, and no
history ever arrives.

**0.2 The stack is running the new images.** Grep the RUNNING container, never
the exit code of the build:

```bash
docker compose exec ai sh -c "grep -rl historical-intelligence /app/dist | head -3"
docker compose exec incoming-worker sh -c "grep -rl historical-import /app/dist | head -3"
docker compose exec webhook sh -c "grep -c process-history /app/dist/routes/webhook.js"
```

Each must return something. An empty result means a stale container is serving.

**0.3 The migration is applied.**

```bash
psql "\dt historical_*"
psql "select count(*) from pg_indexes where indexname = 'messages_historical_external_id_key';"
```

Seven tables, and the index count must be `1`.

**0.4 Qdrant is reachable from the AI service.**

```bash
docker compose exec ai sh -c "wget -qO- http://qdrant:6333/collections"
```

The `historical_knowledge_candidates` collection does not exist yet. It is
created on first use; its absence now is correct.

**0.5 The worker started.**

```bash
docker compose logs ai | grep "historical-intelligence"
```

Expect `worker started` and `source-window watchdog started`.

**0.6 Baseline the tenant, so every later number can be compared.**

```sql
select
  (select count(*) from conversations where tenant_id = '<TENANT>') as conversations,
  (select count(*) from messages      where tenant_id = '<TENANT>') as messages,
  (select count(*) from contacts      where tenant_id = '<TENANT>') as contacts;
```

**0.7 If the tenant has Shopify connected, baseline it too.** This is the number
that proves nothing was created:

```
Shopify admin  →  Customers  →  note the exact total
```

Write it down. You will compare it after the import.

---

## 1. Meta onboarding

1. Settings → Channels → WhatsApp → Connect.
2. The dialog must offer **"connect your WhatsApp Business app"**. If it does
   not, stop: the dialog version or feature type is wrong and Coexistence is not
   on offer. See `project_whatsapp_multi_number`.
3. The customer taps through, and **must approve sharing chat history** when
   prompted. If they decline, the import will correctly show
   "No history was shared" and there is nothing to test.
4. They confirm the connection in their WhatsApp Business app.

---

## 2. Confirm history sync actually started

Within a few minutes of onboarding:

```sql
select id, status, source_progress, chunks_received, source_deadline_at
from historical_imports where tenant_id = '<TENANT>';
```

Expect one row, `status = SOURCE_SYNCING`, `chunks_received` climbing.

If there is **no row at all**, the webhook never delivered. Check in order:

```bash
docker compose logs webhook | grep "history chunks="
docker compose logs webhook | grep "Rejected WHATSAPP webhook"
```

A `Rejected` line means the signature failed. No line at all means Meta is not
sending, which is almost always the `history` field not being subscribed (0.1).

---

## 3. Watch progress

**The UI:** Settings → Channels → WhatsApp. The number's card shows a progress
bar and "Importing WhatsApp history". The chip above it must still read
**Connected** the whole time.

**The data:**

```sql
select phase, chunk_order, progress, message_count, thread_count, processed_at
from historical_import_chunks
where import_id = '<IMPORT_ID>' order by phase, chunk_order;
```

Chunks arriving out of order is normal and expected. Every row should get a
`processed_at` within seconds.

---

## 4. Confirm progress reached 100

```sql
select status, source_progress, source_completed_at
from historical_imports where id = '<IMPORT_ID>';
```

`source_progress = 100` and `status` moved past `SOURCE_COMPLETE`.

```bash
docker compose logs incoming-worker | grep "source complete, intelligence enqueued"
```

Exactly one line. Two would mean the handover latch failed.

---

## 5. Prove no historical message was answered

This is the check that matters most.

**5.1 No outbound message was created by the import.**

```sql
select count(*) from messages
where historical_import_id = '<IMPORT_ID>'
  and direction = 'OUTBOUND'
  and metadata->>'source' is distinct from 'historical_import';
```

Must be `0`. Every outbound row from an import is a record of what the business
said in the past, and carries that marker.

**5.2 No message was sent to a customer around the import.**

```sql
select id, direction, status, created_at from messages
where tenant_id = '<TENANT>'
  and origin = 'LIVE'
  and direction = 'OUTBOUND'
  and created_at > '<ONBOARDING_TIMESTAMP>'
order by created_at;
```

Anything here should be explainable as a real live conversation, not a reply to
history.

**5.3 No imported conversation is open or assigned.**

```sql
select status, is_handed_over, assigned_agent_id, count(*)
from conversations where historical_import_id = '<IMPORT_ID>'
group by 1,2,3;
```

Every row must be `CLOSED`, `is_handed_over = false`, `assigned_agent_id = null`.

**5.4 The inbox does not show them.** Open the Inbox. The imported
conversations must NOT appear. If they do, the live-by-default filter is not
being applied and that is a stop-ship.

---

## 6. Inspect the imported customers

```sql
select count(*) as customers,
       count(contact_id) as matched_to_gotcha_contact,
       count(source_of_truth_customer_id) as matched_to_shopify
from historical_customers where import_id = '<IMPORT_ID>';
```

Or through the API:

```
GET /api/historical-imports/<IMPORT_ID>/customers
```

Spot-check three rows against the customer's own knowledge of those people.

---

## 7. Confirm Shopify linking, and prove nothing was created

**7.1 Links exist.**

```sql
select external_id, source_of_truth_vendor, source_of_truth_customer_id
from historical_customers
where import_id = '<IMPORT_ID>' and source_of_truth_customer_id is not null
limit 10;
```

Take one of those Shopify ids and open it in the Shopify admin. It must be a
customer who already existed, with orders predating today.

**7.2 Nothing was created.** Compare against the number written down in 0.7:

```
Shopify admin  →  Customers  →  total
```

**The total must be identical.** Not "close" - identical.

**7.3 The structural proof, if anyone asks how we know.** The pipeline reaches
Shopify only through `getSourceOfTruth()`, whose interface exposes
`identifyCustomer` and has no create method of any kind. The test
`services/ai/src/__tests__/historical-identity-no-external-writes.test.ts`
asserts that and would fail the build if it changed.

```bash
docker compose exec ai sh -c "grep -c customerCreate /app/dist/services/historical-intelligence/*.js" || echo "0 - as expected"
```

---

## 8. Inspect the extracted customer memory

Pick a customer with a long history:

```sql
select customer_external_id, summary, jsonb_pretty(facts)
from customer_historical_memory
where tenant_id = '<TENANT>' order by message_count desc nulls last limit 3;
```

Read the facts and check the one thing that matters: **is anything transient
written as permanent?**

- Good: "previously experienced a delayed shipment", "has bought size M twice"
- Bad: "is waiting for a package", "wants a refund for order 4471"

A single "is waiting for" is a prompt bug worth reporting before rollout.

Also check it reaches the agent:

```
GET /api/historical-imports/customers/<HISTORICAL_CUSTOMER_ID>/memory
```

---

## 9. Review the knowledge candidates

Open **AI Studio → Knowledge → `?tab=discovered`**, or follow
"View what GOTCHA learned" from the channel card.

Check:

- The counts on each card match the evidence when you expand it.
- Nothing contains an order number, a phone number, an address, or a single
  customer's name. If it does, stop and report it: that is customer data leaking
  into a knowledge base.
- Nothing is a greeting or a one-off order status.

```sql
select topic, question, occurrence_count, customer_count, confidence, conflict
from knowledge_candidates
where import_id = '<IMPORT_ID>' and status = 'PENDING'
order by conflict desc, confidence desc;
```

---

## 10. Test a conflict

Find one:

```sql
select id, question, jsonb_pretty(variants) from knowledge_candidates
where import_id = '<IMPORT_ID>' and conflict = true limit 1;
```

In the UI it must:

- show every variant with its own count,
- refuse to approve until you pick or write an answer,
- be excluded from "Approve all high consistency".

Verify the refusal directly:

```bash
curl -X POST .../api/historical-imports/candidates/<ID>/approve \
  -H "Authorization: Bearer <TOKEN>" -H "content-type: application/json" -d '{}'
# expect 400 conflict_requires_answer
```

If the customer has no conflicts, that is a good sign about their business, not
a failed test. Note it and move on.

---

## 11. Approve one candidate into the knowledge base

1. Pick a clearly correct, non-conflicted suggestion. Approve it.
2. Confirm the document exists and is retrievable:

```sql
select id, title, source_type, status, metadata from knowledge_documents
where tenant_id = '<TENANT>' and source_type = 'historical_conversations'
order by created_at desc limit 3;
```

`status` must reach `ready` (embedding finished). `metadata.origin` must be
`historical_import`.

3. Confirm the audit trail:

```sql
select action, actor_id, metadata from audit_logs
where tenant_id = '<TENANT>' and action = 'knowledge.historical_approved'
order by created_at desc limit 3;
```

4. **Ask the AI the question.** Open a test conversation and ask it. The answer
   should now come back grounded in the approved document. This is the only
   check that proves the whole chain.

5. Reject a different candidate and confirm no document appears for it.

---

## 12. Verify the analytics

```sql
select jsonb_pretty(summary), jsonb_pretty(top_topics)
from historical_imports where id = '<IMPORT_ID>';
```

Cross-check three numbers against reality:

- `importedMessages` against `select count(*) from messages where historical_import_id = '<IMPORT_ID>'`
- `importedCustomers` against `select count(*) from historical_customers where import_id = '<IMPORT_ID>'`
- the topic shares against the customer's own intuition. Ask them: "does that
  look like your week?" If they say no, the topic labels need work.

There is deliberately no "X% could be automated" anywhere. If you see one,
something has been added that should not have been.

---

## 13. Verify the completion email

```sql
select completion_email_sent_at, status, completed_at
from historical_imports where id = '<IMPORT_ID>';
```

```bash
docker compose logs ai | grep -i "historical-import" | grep -i email
docker compose logs notifications | grep historical_import_ready
```

Then check the inbox of the tenant admin. The numbers in the email must equal
the numbers on the page. The link must land on the review queue.

**Prove it only sends once.** Re-enqueue the finalize stage and confirm no
second email:

```sql
select count(*) from historical_import_events
where import_id = '<IMPORT_ID>' and step = 'EMAIL';
```

One `SUCCESS`; any retry adds a `SKIPPED`, never a second send.

---

## 14. Debugging reference

**The event log is the first place to look.** It records every stage with counts
and never contains message text:

```sql
select created_at, step, outcome, message, duration_ms, jsonb_pretty(detail)
from historical_import_events
where import_id = '<IMPORT_ID>' order by created_at;
```

Or `GET /api/historical-imports/<IMPORT_ID>/events`.

**Useful log greps:**

| Question | Command |
|---|---|
| Did Meta deliver? | `docker compose logs webhook \| grep "history chunks="` |
| Was it rejected? | `docker compose logs webhook \| grep "Rejected WHATSAPP"` |
| Ingest progress | `docker compose logs incoming-worker \| grep "\[historical-import\]"` |
| Stage progress | `docker compose logs ai \| grep "\[historical-intelligence\]"` |
| Watchdog | `docker compose logs ai \| grep "expired at"` |

**Queue depth:**

```bash
docker compose exec redis redis-cli --scan --pattern "bull:historical-intelligence:*" | head
docker compose exec redis redis-cli llen "bull:incoming-messages:wait"
```

**Stuck import.** If `status` has not moved for more than fifteen minutes and
the queue is empty, re-enqueue the stage it stopped on. Stages are idempotent:
customer learning resumes from `learning_status = 'PENDING'`, extraction resumes
from its own event count, and clustering and analytics recompute from rows.

**A failed import keeps its partial results.** Messages, customers and memory
from completed stages survive; only the failed stage is missing. Do not delete
the import to "start clean" - Meta will not send the history again.

---

## 15. What cannot be retried

Say this to the customer before they start, and again if anything fails:

> WhatsApp shares history only once, within 24 hours of connecting, and covers
> the previous 180 days. Importing again means disconnecting this number and
> connecting it a second time.

The UI says this on a failed import. It is worth saying out loud too.
