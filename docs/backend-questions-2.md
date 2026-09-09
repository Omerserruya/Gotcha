# Questions for the backend — round 2

Scope: the three Home surfaces still unbuilt — **"Your team right now"**
(part of screen 01), **screen 01b "a quiet day"**, and **screen 01c
Notifications**.

Everything answerable from the OpenAPI document has been left out. What
remains is genuinely unanswerable without the source.

As before: a redacted sample response beats a description.

---

## A. "Your team right now"

The design shows, per agent: initials, name, `4 open · replies in 3m`, a
green / amber / grey status dot, and for one agent `Wholesale · away until
11:00`. Header reads `3 online`. It closes with an observation and an action —
*"Shira is carrying twice the queue — **rebalance**"*.

`/api/analytics/agents` returns
`{ agentId, name, email, activeConversations, claimedToday, avgResponseTimeMs }`
— confirmed, and with **no status field**. So:

1. **`GET /api/agents/login-status`** — what does it return? Is it presence
   per agent (online / away / offline), and can it be joined to
   `/api/analytics/agents` on `agentId`?
2. Is there an **"away until"** timestamp anywhere, or a manual away state? The
   design shows `away until 11:00` as a specific time, not a boolean.
3. Is the agent's **department** ("Wholesale") available on either payload, or
   does it need `/api/departments`?
4. `3 online` — countable from login-status, or is there a separate figure?
5. **`GET /api/agent-scores`** — what is this? Is any of it the
   "replies in 3m" figure, or is that `avgResponseTimeMs` from analytics?
6. **rebalance** — is there an endpoint that reassigns or redistributes a
   queue between agents? Or should that link into Inbox with a filter rather
   than act in place?

---

## B. Screen 01b — "a quiet day"

Not an empty state. It is a **different screen** that appears when nothing is
waiting: the greeting changes to "Quiet morning", the suggestions change to
"While it is quiet", and the queue is replaced by four proactive cards under
*"Worth an hour, while it is quiet"*.

7. **What makes it quiet?** Is there a backend signal, or is the frontend meant
   to derive it — and if derived, from what? Zero conversations needing a
   person, or something wider?
8. **"Last handover 3 hours ago."** Is there a handover / takeover concept with
   a timestamp — AI handing a conversation to a human, or a shift change?
   Which endpoint?

The four cards each need a different source and each carries an action:

9. *"Four questions it could not answer this week — Answer them"*
   Is this **`/api/analytics/top-questions`**? Does it distinguish questions
   the AI **failed** to answer from merely frequent ones? What is the shape?
10. *"Two sources still disagree about the minimum order — Resolve it"*
    Knowledge conflict detection. Does it exist? Is
    **`/api/intelligence-reviews`** this surface — the `approve` / `reject`
    endpoints suggest a review queue. What does it return?
11. *"640 customers have gone quiet since spring — GOTCHA has drafted
    something to send them — Read the draft"*
    A dormant-customer segment plus a generated draft. Is
    **`/api/audiences/resolve`** able to express "no contact since X"? What
    produces the draft — `/api/ai-assist/compose`?
12. *"22 people asked for navy towels this week. You do not stock them."*
    Demand for unstocked products. Does anything detect this?
13. For each of the four: is the **action** an endpoint, or a navigation?

---

## C. Screen 01c — Notifications

Described as *"six a day, every one of them a decision or a failure"* — signal,
not a feed of every message.

14. **`GET /api/notifications`** — full shape. Per notification: type, title,
    body, timestamp, read state, and **what it links to** (conversation id,
    approval id, integration id)?
15. **What types exist?** The brief names: approval required, Shopify
    disconnected, AI stopped, action failed, campaign completed, complaint
    spike. Which are actually emitted, and is the type a stable enum?
16. **`GET /api/notifications/unread-count`** — shape. A bare number, or per
    category?
17. **`POST /api/notifications/{id}/mark-read`** and
    **`/mark-all-read`** — request bodies and responses.
18. Is `/api/notifications` **paginated**, and by which of the three
    conventions?
19. **Are notifications pushed over Socket.IO**, or is polling the only option?
    Nothing in the confirmed event catalogue looks like a notification event.
20. **`/api/notification-preferences`** — shape, and what the `{id}` addresses.
    The brief describes per-channel preferences (in-app, email, WhatsApp,
    approvals).

---

## Still outstanding from round 1

Repeated because they block more than one screen:

- **`SESSION_COOKIE_CREATE=true` on dev** — removes the OIDC relying-party
  layer from the frontend entirely and unblocks a real login.
- **A realtime ticket endpoint** — Socket.IO cannot be authenticated from a
  browser while the token is in an HttpOnly cookie.
- **The five missing Home contracts** — ranked queue rows, activity stream with
  timestamps, time saved, monthly allowance, insight drafts.
