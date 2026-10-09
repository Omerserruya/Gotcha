# Questions for the backend

Written for someone with the GOTCHA backend source in front of them. Every
question below is unanswerable from the published OpenAPI document, because
that document declares **no response schemas anywhere** — it types every
success as `EnvelopeUnknown` and says so explicitly.

Answers should be shapes, not prose: a sample JSON response (with values
redacted) is worth more than a paragraph. Field names and types are what the
frontend needs.

Priority 1 blocks the Home screen. Priority 2 blocks everything after it.

---

## Priority 1 — Home

### 1. `POST /api/agent/run` — the command surface

`services/ai/src/routes/agent.ts:27`. This is the natural-language box at the
centre of Home ("Ask anything, or tell GOTCHA what to do…").

1. What is the **request body**? Field names and types.
2. What is the **response body**? A full example.
3. Is it **synchronous** (one response with the answer) or does it return a run
   id and deliver results asynchronously?
4. If asynchronous: over Socket.IO, by polling, or SSE? Which event names?
5. Can it **execute actions**, or only answer questions? If it executes, does
   the response say what it did?
6. Does it carry **conversation state** across calls, and if so keyed on what?
7. What does `POST /api/agent/clear` clear — that state?
8. Typical latency, and is there a timeout the client should respect?

### 2. `/api/action-planner/*` — the action lifecycle

`services/ai/src/routes/action-planner.ts`. Five endpoints: `plan`,
`classify`, `simulate`, `execute`, `approvals`.

9. What is the intended **call order**? Is `classify` before `plan`, or an
   alternative to it?
10. Request and response shape for **each** of the five.
11. Does `plan` return a list of steps the UI should render? What identifies a
    step, and does it carry a status?
12. What does `simulate` return that `execute` does not — is it a dry run with
    a predicted outcome?
13. How does an action become an **approval**? Does `execute` return
    "pending approval" with an id, or is `/api/action-planner/approvals` a
    separate queue?
14. How does `/api/action-planner/approvals` relate to `/api/approvals`
    (7 paths under that namespace)? Are they the same objects?
15. Is `execute` **idempotent**? If the client retries after a timeout, can an
    action run twice? Is there an idempotency key?

### 3. The Home aggregates

The design states exactly what Home needs. For each, which endpoint serves it
and what does it return?

16. **Today's counts split by handler** — total conversations, handled by AI,
    handled by humans, needing attention, pending approval.
    Is this `/api/analytics/dashboard`, `/overview`, or `/daily`? What is the
    difference between those three?
17. **Channel distribution for the day** — `/api/analytics/channel-performance`?
    Does it return per-channel counts for an arbitrary date range?
18. **`/api/analytics/queue`** — is this the risk-ranked list of conversations
    needing a person? Does each row include intent, wait time, channel and
    customer? What defines the ranking, and is the rank computed server-side?
19. **`/api/analytics/insights`** — the design shows one surfaced trend *with a
    drafted response attached* ("Shipping questions are up 43%" + Review draft
    / Dismiss). Does the response include a draft? If not, is there an endpoint
    that produces one from an insight?
20. **`/api/analytics/agents`** — per-agent open counts and current status?
    What are the possible status values?
21. **`/api/analytics/tool-usage`** — is this a time-ordered stream of
    completed AI actions? Does each entry have a timestamp and a
    human-readable description, or only tool names and counts?
22. **Time saved** — the design puts a "time saved today" figure on Home.
    Does the backend compute it? Which endpoint, and what is the formula?
23. **Monthly conversation allowance** — `/api/usage/stats`? What does it
    return: used, limit, period boundaries?
24. Do any of these accept a **date range**, or are they fixed to today?
25. Are the analytics figures **live** or precomputed on a schedule? If
    precomputed, how stale can they be?

---

## Priority 2 — cross-cutting

### 4. Realtime

The gateway is live — `/socket.io/?EIO=4&transport=polling` returns a valid
Engine.IO handshake — but it appears nowhere in the OpenAPI document.

26. **How does a browser authenticate the handshake?** The access token is in
    an HttpOnly cookie by design, so JavaScript cannot read it to put in
    `auth`. Is there a short-lived ticket endpoint? If not, what is the
    intended mechanism?
27. What is the **event catalogue**? Event names and payload shapes.
28. Are events already **scoped per tenant** server-side, or must the client
    filter? Are there rooms/namespaces, and how does a client join?
29. Which events fire for: new message, conversation assigned, delivery state
    changed, approval requested, approval resolved, AI activity?
30. Is there a **replay or catch-up** mechanism after a reconnect, or does the
    client refetch?

### 5. Auth and session

31. The spec documents `GET /api/auth/login`, `GET /api/auth/callback` and
    `POST /api/auth/logout` (`services/auth/src/routes/session-auth.ts`), but
    **all three return 404 through the dev gateway**. Are they meant to be
    exposed? If yes, what is blocking them; if no, is the frontend expected to
    be the OIDC relying party itself?
32. `POST /api/auth/me/switch-tenant` is unschematized. What is the request
    body — the field name for the target tenant?
33. `POST /api/auth/logout` is unschematized. Does it take a body at all?
34. What exactly does `GET /api/auth/me` return? Full shape.
35. What does `GET /api/auth/me/memberships` return per membership — tenant id,
    name, role, anything else?
36. Is there an **avatar** on the user object? The frontend currently renders
    initials because no avatar contract is visible.

### 6. Permissions

37. What does `GET /api/permissions/me` return? The spec says "canonical
    hierarchical permission set + effective scope AND the legacy feature
    list" — the shape of all three.
38. What does `GET /api/permissions/catalog` return? A sample.
39. **What are the actual permission strings?** Even a partial list for
    Inbox, Approvals, Customers, Outreach, Studio, Analytics and Settings.
    The frontend gates navigation on these and is currently gating on nothing
    rather than guessing.
40. Is the format always `feature:sub-feature:action`? Are wildcards ever
    returned, and does holding `inbox:conversations` imply
    `inbox:conversations:read`?

### 7. CORS, correlation, conventions

41. CORS on the dev API returns `access-control-allow-origin:
    https://dev.gotcha.co.il` regardless of the requesting origin, so a
    browser on `localhost:3000` is refused. Is that intentional? The frontend
    proxies server-side and is unblocked either way — this is a confirmation,
    not a request.
42. Is there a **correlation id** header on responses? None was observed.
    If the frontend sends `x-request-id`, will it appear in backend logs?
43. Is the `{ data: ... }` / `{ error, details }` envelope **universal**, or do
    some handlers answer bare?
44. **Pagination**: some endpoints take `limit`+`cursor`, others `page`+`limit`,
    others `limit`+`offset`. Is there a preferred convention for new work, and
    what does a paginated response return alongside the items?
45. Are **status values** (e.g. `WAITING_FOR_CUSTOMER`, `REQUIRES_APPROVAL`)
    returned as stable codes rather than display strings? The frontend
    translates codes and must not receive pre-translated text.

---

## Not a question — an ops request

To develop against dev, the frontend needs an **Authentik OAuth2/OIDC client**:

- **Confidential** client (the provider's discovery document does not advertise
  `none` as a token endpoint auth method)
- Redirect URI: `http://localhost:3000/api/auth/callback` — exact string, no
  trailing slash, not `127.0.0.1`
- Scopes: `openid`, `profile`, `email`, **`offline_access`** (without the last
  there is no refresh token and sessions die at every token expiry)

Needed: the **client id** and **client secret**. Adding the redirect URI to an
existing provider works too — Authentik accepts several per client.
