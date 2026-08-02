# AI Studio Cleanup — Phase 0 Execution Matrix (round 2)

Branch `feat/customer-intelligence-phase1` @ `7262082`. The §1–§12 round is already
committed here (`429bb47`..`cc3f87a`) and green (105 frontend tests + chatbot suite).
This round audits the 13-phase spec against that reality and fills genuine gaps.

| Phase | Spec | Committed state | Verdict |
|---|---|---|---|
| 0 | Audit + matrix | this doc | this doc |
| 1 | Tabs/nav, Back preserves origin, no Team default | `429bb47` `lib/ai-studio-tabs.ts` + nested-page returnTab; 9 nav tests | **DONE — verify** |
| 2 | Canvas-first Processes + fullscreen + honest save states + 409 | `93be4e7` FlowEditor embedded, saveState machine, expectedUpdatedAt→409 | **DONE — verify** |
| 3 | Typed ports + FE isValidConnection + authoritative backend validator | `e81da3b` connection-rules + graph-validator(422); covers empty/no_start/broken_edge/self_loop/no_input/no_output/multi_input/unreachable/no_terminal/cycle/missing_config. **GAP: duplicate static-entry, branch completeness, delay validity** | **GAP — extend** |
| 4 | Provider-generic integration deps, metadata-driven | `a419b4a`+`cc3f87a` `requires`+`PROVIDER_CONNECTIONS` (voice/shopify/crm/calendar), no type-prefix branch; tested | **DONE (core) — verify**; expanded per-employee/health states = runtime, out of flow-editor scope |
| 5 | Workflow i18n + RTL | `11f257b` node-i18n (29 nodes, 9 cats, 11 templates) EN+HE nested | **DONE — verify** |
| 6 | Node info tooltips, one canonical metadata | `5bd912d` NodeInfoIcon a11y hover+focus | **DONE — verify** |
| 7 | Static-entry left boundary (graph-space) | `ce7eccb` leftBoundaryX + translateExtent/nodeExtent | **DONE — verify** |
| 8 | Knowledge real mapped sources + cards + table | `2189fae`+`ad28646` source cards + real table (canonicalDocType) + manage page (resync/pause/reconnect/remove) | **DONE (core) — verify** |
| 9 | Remove standalone Business Policies → one governance surface | `dbab871`+`cc3f87a` folded into Permissions&Policies; PolicyAdmin → Settings→Your Business; system/integration/action kind split | **DONE — verify** |
| 10 | Membership permissions (`ai:*`), no new role checks, migration | **NOT DONE**: AI Studio routes still `requireRole("ADMIN")`; catalog has ai:*:read only. | **GAP — implement (primary work)** |
| 11 | Full automated verification | 105 FE + chatbot + shared suites | **run** |
| 12 | Live screenshots (he/he-narrow/en) | driver exists (scratchpad/shots-aistudio) | **re-capture** |
| 13 | Final report | — | **produce** |

## This round's work (genuine deltas)
1. **Phase 3**: add backend validators — duplicate static-entry nodes, branch
   completeness (condition/route branches), delay/time validity — + FE parity + tests.
2. **Phase 10 (primary)**: extend the existing `ai` permission domain with
   manage/publish/assign/hitl actions (reuse `integrations`/`approvals`/`business-systems`
   where they already own a concept); convert AI Studio backend routes from
   `requireRole("ADMIN")` to `requirePermissionOrRole(<perm>, "ADMIN")` (anti-lockout
   transitional, matching `f87c242`); boot re-seed covers the new keys; authz + tenant
   isolation + 401/403 tests. No competing `ai-studio:*` domain — the repo convention is `ai:*`.
3. Verify phases 1–9 (tests green, already screenshot-verified), re-screenshot, report.

Phases 1,2,4,5,6,7,8,9 outcomes are already true and tested; they are verified, not
rebuilt (rebuilding tested/verified code is waste + regression risk). The report
attributes each phase to its commit(s).
