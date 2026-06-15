# GOTCHA demo runner

Scripts that drive an end-to-end WhatsApp-to-bot-to-Zoho demo on the
local docker stack.

## What it demonstrates

1. Inbound WhatsApp → routing → autonomous AI bot
2. Bot calls `integration_create_lead` → F4 policy engine pauses for approval
3. Approval dispatched → real POST to Zoho `/crm/v7/Leads` → lead record created
4. Bot also calls `escalate_to_human` (captured in audit trail)
5. Replay of `link_customer_identifier` produces an `IdentityLinkSuggestion`
   linking the WhatsApp contact to a pre-seeded EMAIL contact → the
   cross-channel merge candidate

## Prerequisites on the demo tenant (`cmmov5qh10000ltnqm7pmxqzc`)

- Zoho CRM integration OAuth-connected (`status=CONNECTED`)
- AI agent `cmnvsm2ao0003eioazm6qbg8c` has `create_lead` granted via
  AgentToolPermission on a CONNECTED Zoho tenantTool
- Docker stack up (`docker compose up -d`), Postgres on `localhost:5432`,
  nginx gateway on `localhost:80`
- `INTERNAL_SERVICE_KEY=chatcenter-internal-2026` (matches what the
  compose file gives the running services)

## Usage

```bash
# full flow - setup, wait for you to send "hey", drive the 3 turns
./node_modules/.bin/tsx scripts/demo/run-demo.ts

# phases can run individually
./node_modules/.bin/tsx scripts/demo/run-demo.ts --phase=setup
./node_modules/.bin/tsx scripts/demo/run-demo.ts --phase=wait
./node_modules/.bin/tsx scripts/demo/run-demo.ts --phase=drive
./node_modules/.bin/tsx scripts/demo/run-demo.ts --phase=report

# reset between rehearsals
./node_modules/.bin/tsx scripts/demo/cleanup.ts
./node_modules/.bin/tsx scripts/demo/cleanup.ts --restore-agent   # also revert systemPrompt + autonomy limits
```

## Known-caveats (rough edges in the product, not the script)

| | Where | Workaround in script |
|---|---|---|
| A | `ai-bot.service.ts:508` - bare Hebrew keyword `נציג` substring-matches `נציגי מכירות`, bypassing the LLM tool path | Turn wording avoids `נציג`, `לדבר עם נציג`, `אדם אמיתי`, and English triggers. |
| B | `ai-bot.service.ts:99/422` - `buildSystemPrompt` reads `systemPrompt` only, not `description` | Setup phase copies `description + TOOL-USE RULES` into `systemPrompt`. |
| C | `approvals.ts:223` un-pauses with `handledBy:"ai_bot"`, but `incoming.worker.ts:397` resumes the bot only on `handledBy:"ai_agent"` | Script un-pauses with `ai_agent`. |
| D | Frontend POST `/api/approvals/:id/approve` returns 401 | Script performs Zoho POST directly with the internal key. |
| E | LLM skips `link_customer_identifier` when the email is already in the `create_lead` payload | Script calls `/api/identity/link` directly to produce the `IdentityLinkSuggestion`. |
| F | `maxAutonomousMinutes` (default 15) auto-escalates older conversations | Setup bumps it to 999 for this agent (cleanup with `--restore-agent` reverts). |

## Files

- `run-demo.ts` - orchestrator (setup → wait → drive → report)
- `cleanup.ts` - reset conversation + seeded contacts + suggestions + approvals
- `README.md` - this file
