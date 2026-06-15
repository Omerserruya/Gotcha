# Voice Copilot Service

Ingests Twilio Media Streams for outbound browser-to-PSTN calls, runs
per-speaker Deepgram streaming STT (Hebrew + English), and fans transcripts
out to two independent sinks: Redis Pub/Sub (live UI projection) and Postgres
(durable Message rows). The AI co-pilot subscribes to the same bus and fires
suggestions after every customer-final utterance.

## Architecture

```
 ┌─ agent browser (Twilio Voice SDK) ──────────────────────────┐
 │                                                             │
 │  device.connect(To) ─── TwiML App ──► /twiml/outbound       │
 │                                           │                 │
 │                                           ▼                 │
 │                     <Dial><Conference participantLabel=…>   │
 │                                           │                 │
 └───────────────────────────────────────────┼─────────────────┘
                                             ▼
                       ┌──────────────────────────────────────┐
                       │ Twilio Conference mixer              │
                       │   • agent leg (Voice-SDK client)     │
                       │   • customer leg (PSTN, dialed REST) │
                       └──────────────┬───────────────────────┘
                                      │ participant-join events
                                      ▼
                    /twiml/conference-status
                                      │ streams.create per leg
                                      │ (track=inbound_track,
                                      │  parameter.N = speaker/
                                      │  conversationId/tenantId)
                                      ▼
 ┌──────────────────────────────────────────────────────────────────┐
 │ voice-copilot service                                           │
 │                                                                  │
 │   WSS /twilio/media-stream/:tenantId  (one WS per participant)  │
 │      │                                                           │
 │      ▼                                                           │
 │   Session (per conversation × participant)                      │
 │      • fixedSpeaker = customParameters.speaker                  │
 │      • μ-law → Int16 PCM @ 8 kHz                                │
 │      │                                                           │
 │      ▼                                                           │
 │   StreamRouter                                                   │
 │    ├── audio branch → Deepgram (nova-3, lang per tenant)        │
 │    │                    └── transcript events (partial/final)   │
 │    └── transcript branch (fire-and-forget fan-out)               │
 │            ├─→ Redis Pub/Sub  "voice.transcript"                │
 │            └─→ Postgres Message rows  (finals only, dedup'd)    │
 └──────────────────────────────────────────────────────────────────┘
                               │
                               ├───────────────┐
                               ▼               ▼
              conversation-service     ai-service
              (Socket.IO bridge →      (voice-copilot-subscriber:
               agent browser)          on customer-final, debounced
                                       1500 ms → getSuggestions →
                                       publishes voice.copilot.suggestions
                                       → bridged back to agent UI)
```

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/voice-copilot/token` | Agent JWT | Mint short-lived Twilio AccessToken (Voice grant) for the browser Device |
| POST | `/api/voice-copilot/twiml/outbound` | Twilio signature | Returns TwiML that joins the agent into a per-call Conference; stashes metadata in Redis |
| POST | `/api/voice-copilot/twiml/conference-status` | Twilio signature | Dials the customer on the first agent `participant-join`; attaches per-participant Media Streams with speaker metadata via `parameter.N` |
| POST | `/api/voice-copilot/twiml/status` | Twilio signature | Call-progress webhook (logged) |
| WSS  | `/twilio/media-stream/:tenantId` | HMAC signature | Twilio Media Stream ingress (one stream per participant, carries speaker/conversationId via customParameters) |
| GET  | `/healthz` / `/readyz` / `/metrics` | None | Liveness / readiness / Prometheus |
| GET  | `/api/voice-copilot/live` | Tenant admin | Active sessions scoped to the tenant |

## Speaker Attribution

Because Twilio does **not** include `body.Caller` in conference status
callbacks, agent vs. customer is resolved with a two-stage check:

1. **`body.ParticipantLabel`** - set via `label: "customer"` when we dial the
   customer via `conferences.participants.create`. Authoritative when present.
2. **CallSid comparison** - the agent's parent-leg CallSid (from `/outbound`)
   is stashed in Redis with the conference metadata. On `participant-join`,
   if `body.CallSid === meta.agentCallSid`, that's the agent.

The resolved speaker is passed to the Media Stream via Twilio's native
`parameter1.name=speaker` / `parameter1.value=agent|customer` fields -
arrives as `customParameters` on the WS `start` frame. URL query strings
were being stripped between Twilio and our nginx, hence the switch.

## Conference Dialing

`conference-start` does not reliably fire with `startConferenceOnEnter=true`
when only one participant joins via TwiML. The customer is therefore dialed
on the **first `participant-join` where `speaker === "agent"`**, guarded by
a `customerDialed` flag in the Redis metadata to prevent double-dialing.

## StreamRouter

Per-session fan-out into two independent failure domains:

| Branch       | Sink                  | Delivery             | Failure behavior                 |
|--------------|-----------------------|----------------------|----------------------------------|
| audio        | Deepgram (per speaker) | sync enqueue         | pre-open buffer (drop-oldest 200) |
| transcript   | Redis Pub/Sub          | fire-and-forget      | logged, dropped (partials okay) |
| transcript   | Postgres Message row   | fire-and-forget      | retries via `externalMessageId` traceability; finals only |

Guarantees:
- **Ordering** per-speaker preserved (single-threaded event loop + per-speaker seq).
- **No shared await** between branches - slow Postgres does not stall Pub/Sub.
- **Partials may be lost** (projection only). **Finals must not be lost** -
  each final carries a stable `externalMessageId` = `voice:{callSid}:{speaker}:{seq}`.
- **In-memory dedupe**: ReorderBuffer (`emittedFinalsSeq`) + Deepgram provider
  (`lastFinalText`) prevent duplicate rows within a session.

## AI Co-pilot Integration

`ai-service` starts a `voice-copilot-subscriber` on boot that listens on the
shared event bus. Every `voice.transcript` event with
`isFinal && speaker === "customer"` calls `scheduleAssistTrigger(tenantId,
conversationId)` - debounced 1500 ms. On fire:

1. Load conversation + last 20 messages from Postgres.
2. Resolve effective copilot config (`getEffectiveCopilotConfig`).
3. Run `getSuggestions()` (existing flow).
4. Publish `voice.copilot.suggestions` to the bus → conversation-service
   bridges to `tenant:{id}` Socket.IO room → frontend renders in Stage Mode.

No HTTP coupling between voice-copilot and ai-service; the single writer
to Postgres is still voice-copilot's StreamRouter.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `NODE_ENV` | `development` | |
| `PORT` | `4007` | HTTP/WS listening port |
| `REDIS_URL` | `redis://redis:6379` | Shared Redis (session store + pub/sub + conference metadata) |
| `STT_PROVIDER` | `deepgram` | `stub` / `google` / `deepgram` |
| `DEEPGRAM_API_KEY` | (empty) | Deepgram Nova-3 streaming STT key |
| `STT_LANGUAGE` | `he-IL` | `he-IL` or `en-US` |
| `TWILIO_ACCOUNT_SID` | (empty) | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | (empty) | Twilio auth token (signature validation, REST) |
| `TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET` | (empty) | Browser-AccessToken signing key |
| `TWILIO_TWIML_APP_SID` | (empty) | TwiML App the Voice-SDK Device dials into |
| `TWILIO_CALLER_ID` | (empty) | E.164 caller-ID shown to customer |
| `PUBLIC_BASE_URL` | `http://localhost` | Public HTTPS base - Twilio callbacks + WSS |
| `LOG_LEVEL` | `info` | pino level. `debug` shows `stt opened`, `stt reconnect`, per-frame audio counters |
| `SESSION_TTL_SECONDS` | `900` | Redis session key TTL |
| `RECONNECT_GRACE_MS` | `10000` | Grace before ending a disconnected session |
| `MAX_CONCURRENT_SESSIONS` | `50` | Per-instance concurrency cap |

## Outbound Calling - Twilio Console Setup

Three objects in Twilio Console (plus the creds above):

1. **Phone number** - Phone Numbers → Buy. Put into `TWILIO_CALLER_ID` (E.164).
2. **API Key** - Account → API keys & tokens → Create (Standard). SID →
   `TWILIO_API_KEY_SID`, Secret → `TWILIO_API_KEY_SECRET`. Never reuse the
   master auth token for browser-minted AccessTokens.
3. **TwiML App** - Voice → TwiML → TwiML Apps → Create.
   - Voice Request URL: `${PUBLIC_BASE_URL}/api/voice-copilot/twiml/outbound` (POST).
   - Voice Status Callback URL: `${PUBLIC_BASE_URL}/api/voice-copilot/twiml/status` (POST, optional).
   - Copy the App SID into `TWILIO_TWIML_APP_SID`.

## Running Locally

```bash
npm install                           # from repo root
cd services/voice-copilot
npm run dev                           # listens on :4007
```

## Runbook

**No transcripts during a live call**
- Look for `stt opened` in logs. Absent → Deepgram WS auth/network problem.
- Look for `audio frames sent to deepgram framesSent=1,50,500`. Absent →
  audio isn't reaching Deepgram; check `session: first media frame` logs
  for the track value (should be `"inbound"`).
- Look for `session: skipping non-inbound track (mixed audio)`. If seen →
  Twilio is sending outbound_track frames; they're filtered to avoid echo.
- Look for `first transcript received`. If `stt opened` fires but no
  transcripts → audio is silence, language/model mismatch, or the stream
  is attached to the wrong leg.

**Two participants, two sessions per call**
- Expected: each Twilio participant-join opens a dedicated WS → one Session
  per participant, both scoped to the same `conversationId`. Each session
  holds its own Deepgram provider instance and pushes only its fixed
  speaker's audio. Wasteful but correct. Future work can share a single
  session across participants.

**Co-pilot suggestions never appear in the UI**
- Check ai-service logs: `[voice-copilot-subscriber] listening` on boot.
- On a customer final, ai-service should log the debounced trigger and
  publish `voice.copilot.suggestions`. If it fires but the UI is silent,
  confirm the conversation-service Socket.IO bridge is relaying the event
  (it does so generically for every published event on `tenant:{id}` rooms).

**Twilio 401 / 403 on conference-status**
- Signature validation trips if the request URL reconstruction doesn't
  match what Twilio signed. The handler tries both `https://` and `http://`
  with `X-Forwarded-Host` / `Host`. Check that nginx is forwarding both.

## Development Notes

- **Ordering**: per-speaker Deepgram channels preserve seq order; single
  JS event loop guarantees no interleaving per session.
- **Idempotency**: `externalMessageId` tags every persisted voice message;
  in-memory ReorderBuffer (`emittedFinalsSeq`) and Deepgram provider
  (`lastFinalText`) prevent duplicates.
- **Logging**: pino (async, level-gated). Per-frame `console.log` was
  removed - the old hot-path logging caused 10–15 s latency buildup on
  long calls.
- **Graceful shutdown**: SIGTERM/SIGINT close the STT streams (which
  flush pending interims as finals), stop the WSS, then exit.
