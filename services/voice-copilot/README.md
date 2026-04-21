# Voice Copilot Service

Ingests Twilio Media Streams, demultiplexes dual-channel audio (agent + customer), and dispatches structured voice transcripts to the AI assist engine for real-time copilot and analysis features.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ Twilio Media Streams (TwiML bin / webhook)                       │
└────────────────────┬─────────────────────────────────────────────┘
                     │ WSS /twilio/media-stream/:tenantId
                     ↓
┌──────────────────────────────────────────────────────────────────┐
│ voice-copilot service                                             │
│  ┌─────────────┐   ┌──────────────────┐   ┌─────────────────┐  │
│  │ WS handler  │──→│ Session (state   │───→│ STT provider    │  │
│  │ (Twilio     │   │ machine,         │   │ (stub/Google)   │  │
│  │ signature   │   │ reconnect logic) │   └─────────────────┘  │
│  └─────────────┘   └──────────────────┘          ↓              │
│                            ↑                 ┌──────────────┐   │
│                            └─────────────────│ Reorder      │   │
│                                              │ buffer       │   │
│                                              └──────┬───────┘   │
│                                                     ↓            │
│                                            ┌──────────────┐    │
│                                            │ Dispatcher   │    │
│                                            │ (batch,      │    │
│                                            │  retry,      │    │
│                                            │  idempotency)│    │
│                                            └──────┬───────┘    │
└─────────────────────────────────────────────────────────────────┘
                                                    ↓
                            ┌───────────────────────────────────┐
                            │ Redis (session store + reaper)    │
                            └───────────────────────────────────┘
                                    ↓
                 ┌──────────────────────────────────────┐
                 │ ai-service /api/ai-assist/voice      │
                 └──────────────────────────────────────┘
```

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| WSS | `/twilio/media-stream/:tenantId` | HMAC signature | Twilio Media Streams ingress (dual-channel audio demux) |
| GET | `/healthz` | None | Liveness (always 200) |
| GET | `/readyz` | None | Readiness (200 if Redis ping < 300ms, else 503) |
| GET | `/metrics` | None | Prometheus metrics (text format) |
| GET | `/api/voice-copilot/live` | Tenant admin | Active call sessions (scoped to tenant) |

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `NODE_ENV` | `development` | Node environment |
| `PORT` | `4007` | HTTP/WS listening port |
| `REDIS_URL` | `redis://redis:6379` | Redis connection string |
| `AI_SERVICE_URL` | `http://ai:4006` | AI service endpoint for voice transcript dispatch |
| `INTERNAL_SERVICE_KEY` | `chatcenter-internal-2026` | Bearer token for internal service calls |
| `STT_PROVIDER` | `stub` | Speech-to-text: `stub` (deterministic phrases) or `google` (Phase 3) |
| `STT_STUB_SEED` | `42` | Random seed for stub STT (for determinism in tests) |
| `LOG_LEVEL` | `info` | Pino log level (`fatal`, `error`, `warn`, `info`, `debug`, `trace`) |
| `SESSION_TTL_SECONDS` | `900` | Redis session key TTL |
| `RECONNECT_GRACE_MS` | `10_000` | Grace period before ending a disconnected session |
| `REAPER_INTERVAL_MS` | `60_000` | How often the reaper scans for stale sessions |
| `REAPER_STALE_THRESHOLD_MS` | `120_000` | Session considered stale if no frames in this window |
| `MAX_CONCURRENT_SESSIONS` | `50` | Maximum live call sessions per service instance |
| `DISPATCHER_BATCH_WINDOW_MS` | `100` | Coalesce transcripts for up to this duration |
| `DISPATCHER_BATCH_MAX` | `5` | Max transcripts per batch before flush |
| `TWILIO_ACCOUNT_SID` | (empty) | Twilio account SID (for Twilio signature validation) |
| `TWILIO_AUTH_TOKEN` | (empty) | Twilio auth token (for Twilio signature validation) |
| `TWILIO_API_KEY_SID` | (empty) | Standard API Key SID — used to mint browser AccessTokens |
| `TWILIO_API_KEY_SECRET` | (empty) | Standard API Key secret — keep private, never ship to browser |
| `TWILIO_TWIML_APP_SID` | (empty) | TwiML App SID; browser Device uses this to place outbound calls |
| `TWILIO_CALLER_ID` | (empty) | E.164 Twilio number to display as caller ID for outbound calls |
| `PUBLIC_BASE_URL` | `http://localhost` | Public HTTPS base that Twilio can reach (used for TwiML `<Stream>`) |

## Outbound Calling Setup (browser → Twilio → customer)

Outbound browser calls need three objects in your Twilio Console in addition to the credentials above:

1. **Phone number** — Phone Numbers → Buy a number. Copy it into `TWILIO_CALLER_ID` (E.164, e.g. `+15551234567`).
2. **API Key** — Account → API keys & tokens → Create API Key, type **Standard**. Copy SID → `TWILIO_API_KEY_SID`, Secret → `TWILIO_API_KEY_SECRET`. (Keys can be revoked individually; never reuse the master auth token for browser-minted AccessTokens.)
3. **TwiML App** — Voice → TwiML → TwiML Apps → Create. Voice Request URL = `${PUBLIC_BASE_URL}/api/voice-copilot/twiml/outbound`, method POST. Optionally set Voice Status Callback URL = `${PUBLIC_BASE_URL}/api/voice-copilot/twiml/status`. Copy the App SID → `TWILIO_TWIML_APP_SID`.

Endpoint summary for outbound:

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/voice-copilot/token` | Agent JWT | Mint short-lived Twilio AccessToken (Voice grant) for the agent's browser Device |
| POST | `/api/voice-copilot/twiml/outbound` | Twilio signature | TwiML that `<Dial>`s the `To` param + forks audio into `<Stream>` |
| POST | `/api/voice-copilot/twiml/status` | Twilio signature | Call-progress webhook (logged) |

## Running Locally

Install dependencies at repo root:
```bash
npm install
```

Start the service:
```bash
cd services/voice-copilot
npm run dev
```

Service listens on `http://localhost:4007` with stub STT by default.

## Testing

Run all tests (unit + integration):
```bash
npm run test
```

Tests include:
- **Unit tests** (15 files, 100+ cases): audio decoding, queuing, session state machine, STT provider, reorder buffer, dispatcher batching/retry, WebSocket frame parsing, routes.
- **Integration test** (e2e): full pipeline with in-memory Redis, stub STT, mocked ai-assist, assertion of message ordering and deduplication.

All 114 tests pass with deterministic seeding.

## Runbook

**Session appears to hang or doesn't progress**
- Check `/metrics` for `voice_sessions_active` gauge and `voice_audio_queue_dropped_total` counter.
- Check `/api/voice-copilot/live` (admin only) to see active sessions and their state.
- Reaper logs indicate if a session was auto-ended (check `voice.session.ended` events in logs).

**Dispatch failures or messages not reaching ai-assist**
- Check Redis DLQ: `redis-cli LLEN voice:dlq:{tenantId}` (queue of failed dispatch batches).
- Check ai-service logs for 5xx errors or timeout on `/api/ai-assist/voice` endpoint.
- Verify `INTERNAL_SERVICE_KEY` env var matches ai-service configuration.

**Twilio 401 (signature validation failed)**
- Ensure `TWILIO_AUTH_TOKEN` is set (or `TENANT_{ID}_TWILIO_AUTH_TOKEN` for per-tenant override).
- Verify X-Twilio-Signature header matches HMAC-SHA1(URL-encoded body, auth token).

**High audio drop rate**
- Increase `MAX_CONCURRENT_SESSIONS` if instances are approaching capacity.
- Check `voice_audio_queue_dropped_total` metric per session to identify bottlenecks.
- Verify ai-assist `/api/ai-assist/voice` is responding within 2s (dispatcher timeout).

## Phase 3 TODO

- [ ] **Google Cloud STT integration**: Implement `google-provider.ts` with streaming transcription (Phase 3 work packet).
- [ ] **DLQ drain worker**: Automatic or manual retry of failed dispatches from Redis DLQ.
- [ ] **Per-tenant KMS encryption**: Encrypt session state at rest in Redis (security hardening).
- [ ] **Partial transcript UI**: Render live partial transcripts in frontend (currently only finals trigger assist; partials available in dispatcher queue).
- [ ] **Conversation auto-creation**: Handle cases where inbound Twilio call references a conversation not yet created (out of scope Phase 1+2).

## Development Notes

- **Service ownership boundary (CLAUDE.md §2)**: voice-copilot interacts with ai-service exclusively via POST `/api/ai-assist/voice` public API. Redis session store is internal state, not owned by another service.
- **Idempotency**: All dispatches to ai-assist include `X-Idempotency-Key` header to ensure exactly-once semantics (Redis SET NX EX 3600).
- **Circuit breaker**: Per-tenant failure rate monitored; if ≥20 failures/min and ≥50% failure ratio, dispatcher enters OPEN state (rejects all, direct DLQ) for 30s.
- **Graceful shutdown**: SIGTERM/SIGINT drain queues, close WebSocket server, then stop HTTP server.
