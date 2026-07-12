# Onboarding Platform Audit — Business Discovery & the Digital Twin

> **Type:** Founder-level platform due-diligence audit (Principal Product Architect + Principal UX + Principal AI Architect lens).
> **Date:** 2026-07-08 · **Branch:** `feat/customer-intelligence-phase1` (working tree, uncommitted 9-movement build included).
> **Method:** Phase-separated (Audit → Vision → Roadmap → Playbook), grounded exclusively in the current implementation. Every current-state claim carries a `file:line` citation gathered by direct code trace on 2026-07-08. Where this document evaluates philosophy, the yardstick is the canonical target: `onboarding-experience-bible.md` (12 laws, 9 movements) and `onboarding-wonder-and-confidence.md` (the Confidence Doctrine).
> **Relationship to prior docs:** `onboarding-product-review.md` diagnosed the OLD two-gate flow (2026-07-07 morning) — this audit supersedes its current-state sections; the Bible and Wonder passes remain the prescriptive canon and are NOT rewritten here. This document is the implementation source of truth for what to build next.
> **Constraint honored (audit pass):** audit only — no code was modified.

---

## ✅ Implementation Log — 2026-07-09 (P0 + P1 core shipped)

The audit above is the spec; this section records what has since been **built and type-checked** on `feat/customer-intelligence-phase1`. Auth + AI + frontend all `tsc --noEmit` clean; discovery normalizer (8) + new onboarding-logic (6) tests green.

**P0 — make the built thing true & unbreakable (DONE):**
- **T-1** Regenerated Prisma client; removed **all** `(prisma as any)` casts in the five onboarding files (JSON reads cast at the read site; queries now type-checked). Migration `20260709000000_twin_permanence` adds `progress`, `scan_phase`, `tune_transcript` (additive).
- **U-2 / resume checkpoint** `BusinessDiscovery.progress` + `PATCH /discovery` whitelist + frontend persists each movement and resumes within the review→ready band (no more silent fall-back to integrations).
- **P-3 / U-4 copy + gate** TuneScreen no longer claims "created"; confirm-gate accepts `valueProp` fallback so a visible summary never yields a dead button.
- **U-6** `gray-150` added to Tailwind (silent no-op borders fixed). Dead code removed (`LANGS`, 4 zero-consumer api methods).
- **T-2** `/discover` concurrency guard (409 on live scan) + preserves the last good report on re-scan/failure (no more destructive NULL).
- **T-3** `fetchWithTimeout` on every auth→AI/billing hop.
- **T-4 / U-7** Nudge emails localized he/en (RTL) computed from `Tenant.defaultLocale`; SMTP stub now fails **loud** (nudges settle FAILED, never a false SENT); waitlist `+500` inflation removed.
- **T-6** Audit rows for both grandfathered auth-side LLM calls (with bounded prompt/context per CLAUDE.md §5).
- **U-1 (partial)** Live `scanPhase` written at real phase boundaries (`homepage→synthesis→done/failed`) — backend ready for the event-driven ceremony.

**P1 — the living twin (core DONE):**
- **P-1 (headline) — brain transplant** `generateAgentConfig` now compiles the employee from the Digital Twin: brand→`persona.customAttributes` + `customGuardrails` + `toneConfig`; business→`identity.representationGuidelines` (the exact fields the prompt-builder renders). `hireRecommendedEmployee` applies the tuned persona as **structured fields**, not a `systemPrompt` text append.
- **P-1 — permanent home** New `/business` "Your Business" page + sidebar entry renders the twin (discovery + health + confidence chips + corrections + gap-teaching) and an in-app **Recommendations hub** over the live ledger. Shared `components/business/BusinessTwin.tsx`.
- **P-4 (partial)** MissionPanel bridges to `/business` (one "what next" destination); full ledger-replacement of its 4 milestones deferred.
- **U-2 — tune transcript** persisted (`tuneTranscript`, last 20) and rehydrated so a reload mid-tune resumes the chat.
- **store_inspection** second-wave recs written on source-of-truth connect.

**P2 partial — 2026-07-10 (experience round):** (a) **Event-driven ceremony SHIPPED** — Movement 1 split into a light domain-entry screen (no loader pre-domain) + a separate scanning page; `/discover` now writes `scanPhase` at every real boundary (`homepage→pages→synthesis→done|failed`) and persists the deterministic signals at the synthesis boundary; the frontend polls `GET /discovery` (1s) so stages appear/land only on real state, with live found-facts chips and business-typed plan hints — the 1.7s timer is deleted. (b) **Premium bilingual email templates SHIPPED** — all mail (nudge he/en RTL, setup invite, activation, waitlist, reset, invite) now composes one exported light shell `renderBrandEmail` in `notification.service.ts`; dark `#08080c` shells removed. (c) **Typeform-like flow layout** — card containers removed, wide light canvas (`max-w-4xl`), large type, top progress hairline, entrance motion tokens in `tailwind.config.ts`.

**Doctrine hardening — 2026-07-10 (same round):** the LLM emitted gaps that CONTRADICTED its own findings on a live scan (a confident "no customer-service phone" gap while a confirmed WhatsApp number existed; a "no Help Center" gap claiming missing shipping/returns articles while those policies were found). Fixed at the architecture level in `business-discovery.service.ts`: (a) new prompt law — a gap is a claimed absence and must never contradict a finding (a WhatsApp number IS a phone number); (b) deterministic `contradictedGapRule` post-filter (bilingual he/en) drops phone/email/help-center/policy gaps disproven by ground-truth signals or found policies — code has the last word, per the Confidence Doctrine (regex care: bare "מוקד" excluded, it matches inside "ממוקד"). 15 normalizer tests green. Review screen: real brand channel icons (simpleicons + inline-SVG fallback), channels as clean rows instead of card grid, found WhatsApp/phone numbers badged "Customer phone line", tool chips carry logos.

**P-5 + Movement-5 honesty — 2026-07-10 (round 4):** (a) **No more dead Connect CTAs**: `buildDesiredRecommendations` only emits `connect_system` for slugs with a real connector (`CONNECTABLE_SYSTEMS`); detected-but-unsupported tools (Yotpo, ReturnGO, GA) become `tool_detected` acknowledgments ("noticed on your site — no connection needed"); new `reconcileConnectSystemRecs` auto-completes any OPEN connect rec whose integration is already CONNECTED (runs on every GET /recommendations). Movement-5 rows now carry a REAL Connect→ button that drops into the Movement-3 flow with the system preselected. (b) **Movement-6 importers are REAL (former P2 item)**: file upload (PDF/DOCX/TXT → tenant's first KB via existing `/api/knowledge-bases/:id/documents/upload`) and Google Drive (OAuth with new `flow=onboarding` state → returns to /setup → in-wizard file picker → first sync + hourly auto-sync). Root unlock: KB + Drive-OAuth routes in services/ai switched from `requireActiveTenant()` to the existing `requireOnboardingOrActiveTenant()` — the ACTIVE-only gate was the entire reason the tiles said "later". Notion remains an honest "coming soon". Verified live on the strongful tenant: ledger regenerated (Connect Shopify OPEN; tool:yotpo/returngo/google_analytics OPEN; old Connect-X rows REPLACED), KB list/create + Drive OAuth init 200 during PENDING_ONBOARDING.

**Deferred (unchanged from roadmap):** P2 remainder (self-serve signup, funnel analytics) and P3 (SSO, CSM console, POC tenants) — larger-horizon and gated on GTM/security decisions. Setup's `LearnedScreen` was **not** refactored to consume the shared `BusinessTwin` (deliberate: avoid destabilizing the live onboarding flow without full E2E); de-duplication is the natural follow-up.

---

## Executive Summary

The 9-movement onboarding built on 2026-07-07/08 is a **genuine, largely faithful implementation of the Bible** — and the single most important product finding of this audit is that its output is then thrown away.

**What is real and good:** The Business Discovery engine implements the Confidence Doctrine honestly — deterministic signals (emails, phones, WhatsApp, platform fingerprints) are extracted in code and treated as ground truth the LLM cannot contradict; channels found deterministically enter the report as `confirmed` even if the LLM omits them (`business-discovery.service.ts:238-271`); policies can only be `found:false` if the covering page was actually read, else `null`/`unknown` (`:281-288`); weak platform matches are demoted to legacy (`:298-301`). The crawl reads past the homepage (footer links, 27 candidate policy paths, bilingual EN/HE keywords, real browser headers — `onboarding.ts:1433-1447, 1388-1401`). The flow reads as a breathing document (Law 11: wide light canvas, read-first briefing, corrections as margin notes — `setup/page.tsx:534-537, 776-787`). Law 12 is a real persistence model, not a slogan: `Recommendation` rows with dedupe keys, never-resurrect semantics, and contextual auto-completion (`recommendations.service.ts:176-215`). The Nudge Engine computes content at send time from live state and structurally cannot nag (`nudge-engine.service.ts:63-74, 219-270`). The operator gets a real console with derived-only state that "can never drift from reality" (`onboarding-state.service.ts:1-11`).

**The one-sentence verdict:**

> **GOTCHA now builds a digital twin of the customer's business — and then orphans it. The twin is displayed once, during setup, and is consumed by nothing afterwards: not by any product surface, and not by the AI employee it exists to power.**

Three facts make this the headline:

1. **No post-onboarding surface renders the twin.** Grep across the frontend: `getBusinessDiscovery`, `getBusinessHealth`, `getRecommendations`, `teachGap`, `correctDiscovery` are consumed **only** by `app/setup/page.tsx` (plus the internal console). The recommendations backlog the flow promises ("it's all saved to your list… keeps waiting for you" — `setup/page.tsx:1007, 1543`) has **no in-app home**. The brand voice, the health report, the report narrative — rendered nowhere after `/complete`.
2. **The generated employee never reads the twin.** `generateAgentConfig` queries only the shallow `BusinessProfile` (org name, industry, description, priority) and Department settings (`agent-config-generator.ts:197-210`); `businessDiscovery` appears nowhere in that file. Brand voice, vocabulary, forbidden words, ICP, personas, products, detected policies — the five domains of the moat — are never transplanted into the employee. Only the tune-chat persona survives, appended as text to `systemPrompt` (`onboarding.ts:96-107`).
3. **The funnel entry is still human-gated.** A prospect cannot self-serve into this experience: waitlist → Telegram ping → staff provisioning → magic link (unchanged from the prior review; entry paths verified at `setup/verify/page.tsx:23-27`, `login/page.tsx:60-70`, `system.ts:234-300`). The category-defining first ten seconds exist — behind a sales call.

**Overall score: 6.0/10** — an 8/10 discovery engine and an 8/10 persistence model delivering into a 2/10 post-onboarding relationship. The work ahead is not redesign; it is **completion and delivery**: give the twin a permanent home, transplant it into the employee's brain, and open the front door.

---

# PHASE 1 — CURRENT STATE AUDIT

## 1.1 Evidence base

- Direct trace of `frontend/src/app/setup/page.tsx` (1,610 lines, single file), `services/auth/src/routes/onboarding.ts` (2,493 lines), `services/ai/src/services/business-discovery.service.ts` (388), `employee-tuning.service.ts` (106), `services/auth/src/services/{onboarding-state,nudge-engine,recommendations,notification}.service.ts`, `services/ai/src/services/agent-config-generator.ts`, `packages/shared/prisma/schema.prisma` + migrations `20260707000000_business_discovery`, `20260707130000_scheduled_nudges`, `20260707160000_recommendations`.
- All line numbers refer to the 2026-07-08 working tree.

## 1.2 The funnel as implemented

### Entry (pre-product — unchanged, still the structural ceiling)

```
Landing (/) → /early-access (7-step waitlist) → [HUMAN: Telegram ping → SYSTEM_ADMIN provisions
tenant + admin via /system console (system.ts:234-300)] → magic-link email → /setup/verify → /setup
```

- Magic link verifies and redirects (`setup/verify/page.tsx:23-27`). Password login routes non-ACTIVE-tenant ADMINs to `/setup`; non-admins of a non-active tenant are hard-blocked (`login/page.tsx:60-70`).
- `AppLayout` polls onboarding status and bounces any ADMIN of a non-ACTIVE tenant back to `/setup` from every page (`AppLayout.tsx:69-80`) — an admin cannot abandon silently; note this fires an extra API round-trip on **every** page load for the lifetime of the tenant.
- `/setup` renders standalone, no app chrome (`setup/page.tsx` imports contain no layout component).

### The nine movements (as coded — one client component, one `Phase` union, no URL state; `setup/page.tsx:62-74`)

| # | Phase | What happens | API | Skip/Resume |
|---|---|---|---|---|
| 1 | `discovering` | Full-screen dark ceremony ("Investigating your business"); business-typed step labels fetched LLM-free; steps tick on a **fixed 1.7s timer**, last step holds for the real scan (`:641-699, 657-659`) | `POST /discover/plan` then `POST /discover` | Not skippable; frozen (Law: ceremony) |
| 2 | `review` | `LearnedScreen` — the executive briefing: readiness strip ("Can I help you yet?"), profile/brand/channels/other-methods/technology/knowledge sections, all collapsible, every finding with a 5-level `ConfidenceChip` (`:598-618, 728-902`) | `GET /health` on mount; `POST /discovery/correct`; `POST /teach`; confirm → `PATCH /discovery` + `POST /business-profile` | No skip; confirm requires name+summary |
| 3 | `connect` | Source of truth: primary card + quiet "I use another platform" reveal (`:1333-1386`) | OAuth redirect / Fireberry token / Airtable (3b `airtable_mapping`) + `POST /core-system` | "Not now — saved for later" (`:1382`) |
| 4 | `goal` | One question, six cards (`:1259-1287`) | `POST /goal` | No skip (Continue disabled until pick) |
| 5 | `integrations` | Recommended integrations from persisted `Recommendation` rows, dismiss per row (`:991-1030`) | `GET /recommendations?status=OPEN`; `POST /recommendations/:id/dismiss` | Continue always enabled |
| 6 | `knowledge` | "Knowledge I'd love to learn" — TeachCards (URL/paste) + KB tiles (Drive/Notion/PDF **inert, labeled "later"** `:1049-1056`) | `POST /teach` | All optional |
| 7 | `recommendation` | `MeetScreen` — pure render of `disc.recommendation` (name/role/mission/why/knows/needs); **zero API calls** (`:1119-1170`) | none | back only |
| 8 | `tune` | `TuneScreen` chat-to-tune; persona lives in **ephemeral React state**; each turn → LLM (`:1184-1256`) | `POST /employee-chat` (auth proxies to services/ai) | Continue always enabled |
| 9 | `ready` | ReadyScreen; "Put {name} to work →"; footnote: "Anything you skipped is saved as a recommendation" (`:1475-1546`) | `POST /core-system` (stashed) + `POST /complete` | No back |

- **Resume:** boot re-hydrates from `GET /status` + `GET /discovery` and derives position: no profile → review; no core+goal → connect; no goal → goal; else integrations (`:302-309`). **Movements 6–9 have no persisted milestone — a reload during knowledge/meet/tune/ready resumes at `integrations`**, and the tune transcript/persona-in-UI are lost (persona itself persists server-side per message).
- **Exit:** `POST /complete` (`onboarding.ts:764-899`) — gates on profile + admin + (core system or explicit skip); transactionally flips tenant ACTIVE; auto-creates one department; **synchronously** creates the employee (LLM-free `generateAgentConfig`), applies rename/role/tunedPersona (`hireRecommendedEmployee` `:78-119`); activation email, nudge re-arm, billing provisioning — then `router.replace("/conversations")`.
- **After landing:** the sidebar `MissionPanel` (4 generic missions, 30s polling), `FeatureGuides` coachmarks, `ChannelsOnboardingBanner`. **That is the entirety of the post-onboarding relationship surface.**

## 1.3 Backend architecture (verified)

### Discovery engine — the moat, and it is real

- **Two-service split, correctly placed:** auth does the deterministic work (crawl, signal extraction, orchestration — no LLM), services/ai does the single LLM synthesis (`ai-assist.ts:33-38`; CLAUDE.md rule respected).
- **Crawl:** homepage with full Chrome-124 headers to defeat bot filters (`onboarding.ts:1388-1401`); same-origin link discovery against bilingual keywords (`:1433-1434`); union with 27 convention paths (Shopify `/policies/*` etc., `:1436-1447`); cap 16 pages, parallel fetch; text caps home 9,000 / others 2,800.
- **Deterministic signals:** emails/phones/WhatsApp/socials/JSON-LD/contact-form/live-chat; platform **strength scoring** across 7 platform definitions (count of matching patterns → confirmed/likely/low; weak → legacy) (`:1479-1487, 1567-1631`).
- **LLM synthesis:** one call, `getDefaultModel()` (gpt-5-mini default), temp 0.2, JSON mode, 4,096 max tokens (`business-discovery.service.ts:211-222`). The system prompt encodes the two laws verbatim: confidence on every finding; "NEVER STATE ABSENCE UNLESS YOU LOOKED" (`:145-182`).
- **Anti-fabrication normalization (the best code in the feature):** ground-truth channels always confirmed regardless of LLM output; LLM-invented channels whitelisted and demoted to `low`; junk types dropped; policies tri-state; invalid roles defaulted (`:238-325`). This is the strongful.co.il false-negative bug, fixed at the architecture level.
- **Failure honesty:** LLM failure → `FAILED` row that still preserves deterministic channels as confirmed fallbacks (`onboarding.ts:1748-1765`); frontend lands on an editable review rather than a dead end (`setup/page.tsx:202-214`).

### State, nudges, recommendations

- **Derived-only state:** stages/milestones/progress/health/next-action all computed from real product signals, never a stored checkbox (`onboarding-state.service.ts:1-11, 102-159`). The legacy `TenantOnboarding.currentStep` tracker survives with internally inconsistent writes (COMPLETED at `/departments` `onboarding.ts:626-630`, then AI_CONFIG at `/generate-configs` `:728-732`) — vestigial.
- **Nudge Engine:** DB row is the source of truth (survives Redis flush); unique `(tenantId,"onboarding_next_step")` = at most one live nudge; BullMQ 5-min sweep; **content computed at send time** from the live snapshot, SKIPPED if there is nothing true to say (`nudge-engine.service.ts:1-19, 102-178, 219-270`). Design matches the Bible's Voice mechanism exactly.
- **Recommendations:** the Law-12 ledger — kinds `hire_employee`/`connect_system`/`connect_channel`/`import_knowledge`/`setup_workflow`, priorities favor already-detected systems, dedupe-keyed upsert, COMPLETED/DISMISSED never resurrected, stale → REPLACED, contextual auto-complete on connect/teach/correct (`recommendations.service.ts:42-215`; `onboarding.ts:1099-1104, 2119-2128`).
- **Console + Reset:** SYSTEM_ADMIN console (18-column table, health pills, per-row Nudge/Reset) fully backed (`system.ts:454-491`; `system/onboarding-console/page.tsx`); Reset deterministically deletes only onboarding artifacts, preserves users/integrations/KBs (`system.ts:396-452`).

### Data model (new tables)

- `BusinessDiscovery` — one row per tenant (unique tenantId), Json domains, `report` text, `primaryGoal`, status lifecycle as **string** (`schema.prisma:778-813`).
- `ScheduledNudge` — dedupe-keyed, status string, `payload` column **never written** (`:861-882`).
- `Recommendation` — dedupe-keyed, status string, `source` comment promises `store_inspection|manual` that are unimplemented; `kind` comment omits `setup_workflow` the code writes (`:815-849`).

## 1.4 What works well (do not redesign)

1. **The Confidence Doctrine is engineered, not decorative.** Deterministic ground truth + LLM demotion + tri-state policies + legacy demotion. Keep exactly as is; this is category-defining. (`business-discovery.service.ts:145-182, 238-325`)
2. **Recommendation persistence semantics.** Never-resurrect, REPLACED retirement, contextual completion. The model is right; only the delivery surface is missing.
3. **Nudge Engine design.** Send-time recompute + idempotency = structurally incapable of nagging. Keep; localize it (see debt).
4. **Derived onboarding state.** Zero drift by construction. Keep.
5. **The breathing-document frame + bilingual RTL craft.** 151 hand-built `he ?` ternaries, per-screen `dir` flips, LTR islands for identifiers (`setup/page.tsx` throughout) — Law 11 and the localization law are honored where the Bible demanded them.
6. **Reset-not-delete.** Recoverability as a product value, implemented (`system.ts:396-452`).
7. **Synchronous employee creation at `/complete`.** The employee genuinely exists when the owner lands (`onboarding.ts:857-872`) — an honest fix to the old "fire-and-forget you never see confirmed."

## 1.5 Weaknesses (all evidence-cited)

### Product debt (the expensive ones)

- **P-1 · The orphaned twin (headline).** No post-setup consumer of discovery/health/recommendations in the product; brand voice and five-domain intelligence never reach `generateAgentConfig` (`agent-config-generator.ts:197-263` reads only BusinessProfile+Department). The Bible's "permanent AI Readiness Score" and "living recommendations" have no surface. The scan risks reading, in retrospect, as the parlor trick the old review warned about.
- **P-2 · The human-gated front door.** Self-serve signup does not exist; the WOW is behind staff provisioning (`system.ts:234-300`). Structural ceiling on growth and on "first five minutes" claims.
- **P-3 · The employee handoff is thinner than the ceremony implies.** MeetScreen is a static render (no API, `setup/page.tsx:1119`); TuneScreen says "I've created them" while nothing exists until `/complete` (`:1219` vs `onboarding.ts:859-861`, page comment `:1447-1449`); `hireRecommendedEmployee` silently skips rename/tuning unless the tenant has exactly one agent (`onboarding.ts:81-82`); tunedPersona is applied as a text append to `systemPrompt` rather than structured fields (`:100-107`).
- **P-4 · Two onboarding systems still coexist.** Legacy wizard endpoints remain live (`/ai-chat` with its own grandfathered OpenAI call + scripted fallbacks `onboarding.ts:186-362`; `/generate-configs`; destructive `/departments` that deletes ALL tenant departments on re-submit `:595-599`), alongside the 4-mission MissionPanel whose missions are generic and disconnected from the Recommendation ledger (`onboarding.ts:982-1040`). One product, two sources of "what next."
- **P-5 · Knowledge tiles over-promise.** Google Drive / Notion / PDFs render as inert "later" placeholders in Movement 6 (`setup/page.tsx:1049-1056`) even though KB auto-sync for Drive exists elsewhere in the product.

### UX debt

- **U-1 · Ceremony is theater with one honest beat.** Fixed 1.7s interval; only the final step waits for reality (`:657-659`). The Bible demands "duration reflects real work; a step lands when that domain genuinely resolves."
- **U-2 · No resume for Movements 6–9** (`:302-309`) and the tune transcript is in-memory (`:1187-1190`) — a refresh mid-tune silently discards the conversation and re-lands at integrations.
- **U-3 · LearnedScreen affordance overload.** 20–40 tappable affordances on a rich discovery (CorrectMenu on every item, × on every chip, 5 TeachCards, 5 collapsibles). Read-first is achieved; calm is at risk on dense businesses.
- **U-4 · Confirm-gate mismatch.** CTA requires `summary` specifically while the render falls back to `valueProp` (`:787` vs `:896`) — text visible, button dead, no explanation.
- **U-5 · Accessibility gaps.** Custom dropdown without menu roles/Escape; collapsibles without `aria-expanded`; emoji as informational icons; div progress bars without ARIA; no `aria-live` on tune chat (`:709-726, 1597, 620-633, 1229-1237`).
- **U-6 · Identity drift at the seams.** `/setup/verify` uses an indigo/purple identity vs the violet `primary` system (`verify/page.tsx:36,67`); `/setup` bypasses the app's `t()` i18n entirely (inline tuples); `border-gray-150` is used repeatedly but **does not exist** in Tailwind or the config — those borders silently no-op (`:801, 717, 1232, 1235`; `tailwind.config.ts:8-29`).
- **U-7 · Emails are not the product reaching out.** Single inline gradient template, **English-only** despite the bilingual flow (`nudge-engine.service.ts:102-205`); waitlist emails inflate position by +500 (`notification.service.ts:492`) — a dishonesty at odds with the Confidence Doctrine.

### Technical debt

- **T-1 · Type safety is off for every new model.** `(prisma as any).businessDiscovery/scheduledNudge/recommendation` casts across five files (e.g. `onboarding.ts:816,1706`; `nudge-engine.service.ts:66`) — generated client lags schema (known dev-DB drift gotcha). One typo'd field name = silent runtime failure.
- **T-2 · Destructive re-scan + no concurrency guard.** `/discover` NULLs the entire prior report before scanning (`onboarding.ts:1706-1714`); on failure the previous good report is unrecoverable; two concurrent scans race last-writer-wins (no SCANNING check).
- **T-3 · No timeouts on the AI hop.** `callAIDiscoverBusiness` has no AbortController (`:1640-1652`) and `generateResponse` no per-request timeout — a hung LLM hangs `/discover`.
- **T-4 · Silent-success email stub.** No SMTP config → console log, yet NotificationLog says "sent" and nudges are marked SENT (`notification.service.ts:28-37`; `nudge-engine.service.ts:252-256`). In production misconfig, the Voice is mute and the system reports it is speaking.
- **T-5 · Pervasive unlogged error swallowing** on side effects (rec sync, nudge arming, tunedPersona persist, rec completion — `onboarding.ts:1812, 880, 2244, 1103` et al.). A persistently failing sync is invisible.
- **T-6 · Audit-log mandate only half met.** services/ai path logs usage+units+`ai.responded` audit (`ai.service.ts:434-480`); the two grandfathered auth-side LLM calls log usage/units but **no audit row** (`onboarding.ts:246-264, 1313-1330`); no path persists the prompt/context CLAUDE.md §5 requires.
- **T-7 · String pseudo-enums + stale schema comments + dead columns** (`schema.prisma:783, 829, 836, 867, 872`); duplicated `DiscoverySignals` type and `connectedCoreSystem` logic; twin slugifiers whose drift silently breaks gap↔rec matching (`recommendations.service.ts:37-39` vs `onboarding.ts:2084-2086`).
- **T-8 · Dead code:** `GuidedTour` never mounted; `getSetupMap`/`getBusinessProfile`/`getFirstRecommendation`/`analyzeBusinessDomain` zero consumers; `LANGS` (with Arabic) unused; `skipping` state never set; onboarding-snapshot endpoint without a frontend consumer.
- **T-9 · External CDN logos at runtime** (`worldvectorlogo`, `simpleicons`, Google favicons — `setup/page.tsx:89-94, 845`): a privacy/reliability leak into the most important screen. *(Security cross-ref: the crawl itself is an SSRF surface — no private-IP/metadata blocking; owned by the security audit as N-3.)*
- **T-10 · Only the normalizer is tested.** `business-discovery.test.ts` covers `normalizeReport` well (8 cases) but the crawl, signals, endpoints, nudges, recommendations sync, and state derivation have zero tests.

## 1.6 Scores (0–10)

| Area | Score | One-line justification |
|---|---|---|
| Discovery engine (crawl + signals + LLM + normalization) | **8.0** | Confidence Doctrine genuinely engineered; loses points for no timeout, destructive re-scan, untested LLM path |
| Recommendation persistence model | **8.0** | Right semantics, right schema; delivery surface absent |
| Nudge Engine | **7.5** | Excellent design; English-only + stub-transport false success |
| Movement flow UX (M1–M9) | **7.0** | Faithful to Laws 11/12, bilingual, read-first; theater timer, no M6–9 resume, affordance overload |
| Operator console + reset | **7.0** | Real, derived, useful; dead CSM column, desktop-only |
| Onboarding state machine / resume | **6.0** | Elegant derivation; M6–9 unresumable, legacy tracker inconsistent |
| Data model | **6.0** | Good design intent; string enums, `as any` client drift, stale comments |
| Visual craft / a11y / consistency | **6.0** | Strong two-world design; broken border token, emoji+CDN icons, a11y gaps, i18n bypass |
| Employee handoff (Meet→Tune→Deploy) | **4.0** | Deterministic creation works; static Meet, untrue copy, fragile single-agent guard, text-append tuning |
| Emails as product surface | **4.0** | One inline template, English-only, false-success transport, inflated waitlist numbers |
| Post-onboarding continuity (the relationship) | **2.0** | Twin, health, brand voice, recommendations: all invisible after `/complete` |
| Funnel entry (self-serve) | **2.0** | Human-shaped hole intact |
| **Overall** | **6.0** | A category-defining engine wired to a relationship that doesn't yet exist |

**Category-defining today:** the discovery engine's honesty architecture; recommendation persistence semantics; the ceremony-into-briefing arc.
**Ordinary today:** everything after `/complete`.

---

# PHASE 2 — VISION

*Current implementation set aside. First principles, unlimited resources. The Bible's philosophy is assumed correct (it is); this vision is about what the SYSTEM should be so the philosophy survives contact with month two.*

## 2.1 The reframe: onboarding is the first render of a permanent object

Today "onboarding" is a flow that produces side effects. The ideal: **the Digital Twin is a first-class, permanent product object — `/setup` is merely its birth.** Movement 2 (the briefing) is not a step; it is the first render of a page the customer returns to for the life of the account: **"Your Business"** — profile, brand voice, channels, technology, knowledge, gaps, readiness, and the living recommendation ledger, all with the same confidence chips and correction affordances. The onboarding wizard should eventually be indistinguishable from "visiting your business page for the first time, watched by a ceremony."

**Why:** every gap in Phase 1 traces to the twin being flow-scoped instead of product-scoped. Make the object permanent and the "living recommendations," "permanent readiness score," and "employee's voice" stop being features to build and become views over one object.

## 2.2 The brain transplant: discovery is the employee's genome

The employee generated at `/complete` must be **compiled from the twin**, not from the shallow BusinessProfile:

- Brand domain → `toneConfig`/persona (voice, tone, style, forbidden words, preferred terminology, CTA style, languages) — structured fields, not a systemPrompt text append.
- Business domain → identity block (ICP, personas, products/services, value prop, summary).
- Knowledge domain → seeded KB: taught gap answers already become KnowledgeDocuments (`onboarding.ts:2109-2116` — keep); detected FAQ/help-center URLs become queued import jobs.
- Recommendation → name/role/mission (exists today — keep).
- Corrections → standing negative constraints ("not our platform", "not a channel").

**Why:** the Bible's promise is "an employee who trained here, not a bot bolted on." Today that promise is carried by ~4 fields and a text append. The twin already contains the training; refusing to transplant it is the single largest waste of built value in the product.

## 2.3 One recommendation system, everywhere

Missions, setup-map tiles, and Recommendation rows collapse into **one ledger** (the Recommendation table wins; it already has the right semantics). The sidebar panel, the "Your Business" page, and the nudge engine all read the same ledger. A dismissed rec disappears everywhere; a completed one retires everywhere; the Employee's Voice (nudges, and later in-app) quotes the ledger's evidence. Kill `MissionPanel`'s parallel taxonomy.

## 2.4 An honest ceremony

The discovery ceremony's steps should resolve on **real events**: the backend already has natural phase boundaries (homepage fetched → links resolved → pages fetched → signals extracted → LLM synthesis → normalized). Emit staged status onto the BusinessDiscovery row (or SSE) and let checkmarks land when the phase lands, with live facts surfacing mid-scan ("Found 126 products", "Detected Shopify"). Delete the 1.7s timer. **Why:** the Bible: "a step lands its check when that domain genuinely resolves, not on a timer." The one honest beat (final hold) proves the pattern works; extend it to all beats.

## 2.5 The front door opens

Self-serve signup: email → domain suggestion → **the ceremony is the first screen of the product** — provisioning (tenant, admin, magic session) is automated behind it. The waitlist remains as an optional gating flag for GTM control, not an architectural necessity. **Why:** every reference product (Cursor, Linear, Vercel) converts intent within one sitting; the current funnel spends its WOW on people who already survived a sales call. *(This is a founder GTM decision — the vision states the target; the roadmap stages it so early-access gating can persist as a flag.)*

## 2.6 What should disappear

- **The legacy wizard endpoints** (`/ai-chat`, `/generate-configs` as user-facing, destructive `/departments`) — the 9 movements replaced them; the code should follow.
- **`BusinessProfile` as a second source of business truth** — long-term, the twin absorbs it; short-term it remains a compatibility mirror written from the twin (as today, `onboarding.ts:341-351`), never edited independently.
- **The 4-mission checklist** as a separate system (absorbed by the ledger).
- **`TenantOnboarding.currentStep`** — derived state won; retire the tracker.
- **Emoji-as-icons and CDN logo hotlinks** on the flagship screen — local assets.

## 2.7 What should remain exactly as it is

The discovery engine's normalization laws; the recommendation dedupe/never-resurrect semantics; the nudge engine's send-time recompute; reset-not-delete; the standalone no-chrome `/setup` shell; synchronous employee creation at complete; the read-first/edit-second briefing posture. **These are correct. Do not optimize them for novelty.**

---

# PHASE 3 — ROADMAP

> Sequencing law: **truth first (P0), the twin's permanence second (P1), the front door third (P2), enterprise polish last (P3).** Each phase independently shippable; nothing in P1+ depends on P2's GTM decision.

## P0 — Quick wins: make the built thing true and unbreakable (days)

**Objective:** every claim the flow makes is true; every fragile edge is guarded. No new surfaces.
**Business value:** protects the trust the ceremony buys; removes silent-failure classes before scale.
**Customer value:** honest copy, resumable flow, emails in their language.
**Scope:** copy truth (TuneScreen "created"→"prepared"); persist a resume checkpoint for M6–9; localize nudge/onboarding emails (he/en) and make the SMTP stub fail loud; `/discover` concurrency guard + preserve-last-good-report on failure; timeouts on auth→AI calls; audit rows for the two grandfathered LLM calls; regenerate the Prisma client to kill `as any`; fix `border-gray-150`; delete dead code (GuidedTour, zero-consumer api methods, `LANGS`, `skipping`); fix U-4 confirm-gate; cap/document `payload` columns.
**Risk:** low — no schema-breaking change; client regen requires image rebuild discipline (known gotcha).
**Dependencies:** none.
**Complexity:** S–M.
**Success criteria:** reload at any movement resumes to that movement; a failed re-scan leaves the prior report readable; Hebrew tenant receives Hebrew nudges; zero `(prisma as any)` in the five onboarding files.
**Verification:** manual resume matrix (9 movements × reload), forced-failure re-scan, SMTP-unset boot logs an error and marks nudges FAILED, `tsc --noEmit` clean.

## P1 — The living twin: highest ROI in the product (2–4 weeks)

**Objective:** the twin and its ledger become permanent product surfaces, and the employee is compiled from the twin.
**Business value:** converts the one-time WOW into retention machinery; differentiator no incumbent can copy without a discovery kernel; directly serves the "hire an intelligence" narrative that sells the second employee.
**Customer value:** their business's living profile; recommendations that keep working; an employee that demonstrably sounds like their brand from day one.
**Scope:**
1. **"Your Business" page** — extract LearnedScreen's sections into shared components; render discovery + health + corrections + teach at a permanent route (e.g. `/business`); sidebar entry.
2. **Recommendations hub** — in-app list over `GET /recommendations` with resolve/dismiss; unify MissionPanel onto the ledger (missions become derived views or ledger rows).
3. **The brain transplant** — `generateAgentConfig` consumes `BusinessDiscovery` (brand→toneConfig/persona, business→identity, corrections→constraints); tunedPersona moves from systemPrompt append to structured persona merge.
4. **Second-wave recommendations** — on source-of-truth connect, inspect (product/order counts already fetched by connectors) and write `source:"store_inspection"` recs (schema comment already reserves it).
5. **Tune transcript persistence** (bounded, on the discovery record) so a reload resumes the conversation.
**Risk:** medium — transplant touches prompt composition (regression risk on live bots); mitigate with prompt snapshot tests + shadow comparison on a pilot tenant.
**Dependencies:** P0's client regen.
**Complexity:** M–L.
**Success criteria:** discovery data visibly consumed on ≥2 permanent surfaces; a generated employee's tone config contains discovered brand fields; recommendations resolvable outside `/setup`; the Bible's Law 12 demonstrable post-activation.
**Verification:** E2E — onboard a real domain, complete, verify `/business` renders the twin, dismiss a rec in-app, confirm nudge content reflects it; diff generated agent config before/after transplant.

## P2 — Expansion: the open door and the honest ceremony (4–8 weeks)

**Objective:** self-serve entry (behind a GTM flag), event-driven ceremony, premium emails, deeper knowledge intake.
**Business value:** growth loop unblocked; first-ten-seconds claims become marketable.
**Customer value:** try it now; watch a real investigation; emails that feel like the product.
**Scope:** self-serve signup → automated provisioning → ceremony-first entry (waitlist gating as a flag); staged scan status + live facts in the ceremony (delete the timer); premium bilingual email templates (nudge/activation/invite); Movement-6 real importers (wire Drive via existing KB auto-sync; help-center import job); funnel analytics events per movement; mobile pass on the briefing; Arabic when `LANGS` goes live.
**Risk:** medium-high — self-serve touches auth/provisioning security (rate limits, abuse) and the SSRF fix (security audit N-3) becomes a hard prerequisite.
**Dependencies:** P1 (the twin surfaces make self-serve worth it); security audit P0 items (SSRF, webhook, secrets).
**Complexity:** L.
**Success criteria:** a stranger reaches the briefing unassisted in <3 minutes; ceremony steps land on real events; per-movement conversion measurable.
**Verification:** signup-to-briefing E2E on a fresh email; ceremony network trace shows staged statuses; analytics dashboard shows funnel.

## P3 — Enterprise (quarter+)

**Objective:** the onboarding system serves sales-led motion at scale.
**Scope:** SSO/SAML entry; console CSM assignment (replace the dead column) + filters/export; POC tenant templates (pre-seeded discovery, time-boxed) from the console; multi-admin onboarding; tenant-detail drawer consuming the orphaned snapshot endpoint; SLA-style onboarding health alerting.
**Risk:** low-medium; mostly additive.
**Dependencies:** P1 hub; entitlements audit's tenant-type work (POC/demo tenants).
**Success criteria:** an AE can provision a branded POC in <5 minutes from the console; CSM ownership visible per row.
**Verification:** console E2E; POC tenant lifecycle test (create → expire).

---

# PHASE 4 — IMPLEMENTATION PLAYBOOK (for Claude Sonnet)

> NO CODE here — deterministic guidance. Work top-to-bottom inside each phase; each numbered item is independently committable. **Global rules:** backend changes require `docker compose up -d --build <svc>` + `docker compose exec gateway nginx -s reload` (baked images; nginx IP cache). Schema changes: edit `packages/shared/prisma/schema.prisma`, create migration, `npm run db:generate`, rebuild dependent images (`--no-cache ai` when shared changes). Never touch the frozen kernel, the discovery normalization laws, or recommendation dedupe semantics.

## 4.1 Implementation order

**P0:** (1) Prisma client regen + remove `as any` casts → (2) resume checkpoint → (3) copy truth + U-4 + border token + dead code → (4) re-scan guard/preserve → (5) timeouts → (6) email localization + fail-loud stub → (7) grandfathered audit rows.
**P1:** (8) extract briefing components → (9) `/business` page → (10) recommendations hub + MissionPanel unification → (11) brain transplant → (12) tune transcript persistence → (13) second-wave recs.
**P2:** (14) staged ceremony events → (15) email templates → (16) self-serve (flagged) → (17) importers → (18) analytics.

## 4.2 Key architecture decisions (made — do not re-litigate)

- **Resume checkpoint:** add a nullable `progress` String field (movement key) to `BusinessDiscovery` — written fire-and-forget on each phase transition by the frontend via `PATCH /discovery` (extend its zod whitelist). Derived state stays authoritative for stage; `progress` only refines resume position within the review→ready band.
- **Twin permanence:** shared components live in `frontend/src/components/business/` (extracted from `setup/page.tsx` sections: readiness strip, section cards, ConfidenceChip, CorrectMenu, TeachCard); `/setup` and `/business` both consume them. Do NOT fork the markup.
- **Ledger unification:** MissionPanel reads `GET /recommendations` (grouped by kind) and keeps its own 4 milestone rows ONLY as derived "setup" recs written by `syncDiscoveryRecommendations` — one source of truth.
- **Brain transplant boundary:** `generateAgentConfig` (services/ai) reads `businessDiscovery` directly via prisma (same DB, allowed — it is services/ai's own generation concern), mapping: brand→`toneConfig` + persona fields; business→`identity`; forbidden words→`behavioral`. `hireRecommendedEmployee` (auth) stops appending prose to `systemPrompt`; it PATCHes structured persona via the existing update path. Keep prompt-builder unchanged — it already renders structured fields.
- **Ceremony events:** extend `BusinessDiscovery.status` writes with a `scanPhase` field updated between phases in `/discover` (homepage/links/pages/signals/synthesis/normalizing); frontend polls `GET /discovery` at 700ms during ceremony. No SSE infrastructure (keep it boring).
- **Email localization:** locale from `Tenant.defaultLocale`; templates as `[en, he]` pairs in the nudge/notification services (match the setup tuple pattern); stub transport returns `false` and logs `console.error` so nudges settle FAILED.

## 4.3 Files likely affected

- **Frontend:** `app/setup/page.tsx` (shrinks), `components/business/*` (new), `app/business/page.tsx` (new), `components/onboarding/MissionPanel.tsx`, `components/Sidebar.tsx`, `lib/api.ts`, `app/system/onboarding-console/page.tsx` (P3), `tailwind.config.ts` (border token).
- **Auth service:** `routes/onboarding.ts` (PATCH whitelist, scanPhase writes, timeouts, audit rows, hireRecommendedEmployee), `services/{nudge-engine,recommendations,onboarding-state,notification}.service.ts`, `routes/system.ts` (P3 CSM).
- **AI service:** `services/agent-config-generator.ts` (transplant), `services/business-discovery.service.ts` (untouched logic; optional phase callbacks), `routes/ai-assist.ts` (untouched contracts).
- **Shared:** `prisma/schema.prisma` + new migrations; regenerate client.

## 4.4 Database migrations (additive only)

1. `BusinessDiscovery.progress String?` + `scanPhase String?`.
2. `BusinessDiscovery.tuneTranscript Json?` (bounded: last 20 messages, enforced in route).
3. (P3) `assignedCsm String?` on a console-owned table or Tenant.
   No enum conversions in-flight (string statuses stay; document vocabularies in schema comments and FIX the stale ones: Recommendation.kind += `setup_workflow`; recommendation JSON comment += `tunedPersona`). No destructive migrations anywhere in this roadmap.

## 4.5 API changes

- Extend `PATCH /api/onboarding/discovery` zod: `progress` (enum of movement keys).
- `GET /api/onboarding/recommendations` — already sufficient for the hub (status filter exists); add zod validation on `status`.
- No new services. No changes to `/discover-business` or `/onboarding-employee-chat` contracts.

## 4.6 AI changes

- None to models/prompts in P0. P1 transplant changes generation INPUTS only (no new LLM calls — CLAUDE.md rule: new LLM calls only in services/ai, and none are needed). Employee-tuning prompt untouched. Discovery prompt untouched.

## 4.7 Regression risks

- **Prompt regression from transplant** (highest): generated agents' runtime prompts change because structured fields now carry brand data. Mitigate: snapshot `buildAgentPrompt` output for a fixture agent before/after; verify no `# Owner tuning` prose loss for existing tenants (migration note: leave existing systemPrompt appends in place; transplant applies to NEW generations + explicit re-generate).
- **Client regen drift:** dev DB lags schema (known); run `migrate resolve` per the drift gotcha; `select` not `include` on lagging tables until migrated.
- **MissionPanel unification** could break the sidebar for mid-onboarding tenants — derive defensively (empty ledger → hide panel, as today's 4/4 behavior).
- **Resume checkpoint** must never trap a user in an unreachable phase (guard: unknown/stale `progress` falls back to today's derivation).

## 4.8 Manual QA checklist

- [ ] Fresh tenant E2E: provision → magic link → ceremony (steps land, facts appear) → briefing (correct an item, teach a gap) → connect (each of: OAuth, Fireberry, Airtable, skip) → goal → integrations (dismiss) → knowledge (URL + paste) → meet → tune (2 turns, reload, transcript persists) → ready → complete → lands in /conversations with employee existing.
- [ ] Resume matrix: hard-reload at every movement → returns to same movement.
- [ ] Re-scan: run /discover twice concurrently → one SCANNING rejection; force LLM failure → prior report still rendered.
- [ ] Hebrew tenant end-to-end: all 9 movements RTL, nudge email Hebrew.
- [ ] `/business` renders same data as setup briefing post-activation; correction there updates discovery.
- [ ] Recommendations hub: resolve + dismiss reflect in nudge content and setup (via reset).
- [ ] Console: nudge (sent/skipped outcomes), reset (counts reported; recommendations NOW also cleared — add to reset), snapshot drawer (P3).
- [ ] Generated employee: toneConfig contains discovered brand voice; tune instructions present; single-agent guard behavior on multi-department tenant documented.
- [ ] SMTP unset: boot warning + nudges FAILED (not SENT).

## 4.9 Automated testing checklist

- [ ] Keep+extend `business-discovery.test.ts` (normalizer).
- [ ] New: recommendations sync (upsert/never-resurrect/REPLACED), nudge `contentForSnapshot` ladder + SKIPPED paths, onboarding-state `deriveStage/Progress/NextAction`, `/discover` guard behavior (mock fetch), `PATCH /discovery` whitelist, transplant mapping unit test (discovery fixture → config fields).
- [ ] Prompt snapshot test for a fixture agent (pre/post transplant).
- [ ] `tsc --noEmit` in auth + ai as CI gate for the five onboarding files (no `as any` on prisma).

## 4.10 Rollout / rollback

- **Rollout:** per-service image rebuilds; migrations additive → deploy schema first, code second. P1 surfaces ship dark-linked (route exists, sidebar entry behind `NEXT_PUBLIC_BUSINESS_PAGE=1` for one cycle), transplant applies to new generations only. Use Reset Onboarding on a staging tenant as the test harness. P2 self-serve behind `SELF_SERVE_SIGNUP` env flag, default off.
- **Rollback:** revert image tags; additive columns are inert when unread; transplant rollback = revert generator (existing agents unaffected since generation is create-time); MissionPanel unification guarded by a render fallback to the legacy missions endpoint for one release.

## 4.11 Definition of Done (per phase)

- **P0:** all §4.8 items 1–3, 9 pass; zero `(prisma as any)` in onboarding files; copy audit shows no untrue claims; emails localized.
- **P1:** twin visible on ≥2 permanent surfaces; ledger is the single "what next" source; a NEW tenant's employee config provably contains ≥4 discovered brand fields; tune survives reload.
- **P2:** stranger-to-briefing unassisted; ceremony event-driven (timer deleted); funnel instrumented.
- **P3:** POC-in-5-minutes demo passes; CSM column real.

---

# VERIFICATION CHECKLIST (audit integrity)

- [x] Every current-state claim cited to working-tree `file:line` (2026-07-08).
- [x] Verified first-hand (not from prior docs): discovery→employee data flow absence (`agent-config-generator.ts:197-263`), post-setup consumer absence (frontend grep), ceremony timer (`setup/page.tsx:659`), resume gap (`:302-309`), nudge/rec/state semantics, email stub, entry gating.
- [x] Prior docs reconciled: Bible/Wonder = target (unchanged); product-review's current-state = superseded by the 9-movement build; its structural findings (self-serve hole) re-verified as still true.
- [x] No code, migrations, or tasks created. Cross-references: SSRF + CDN + secrets → `docs/security/enterprise-readiness-audit.md`; POC tenants → `docs/architecture/platform-entitlements-audit.md`; employee lifecycle → `docs/product/ai-employee-platform-audit.md`.
