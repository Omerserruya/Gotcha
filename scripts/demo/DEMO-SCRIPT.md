# GOTCHA demo - manual run sheet

Print this, split-screen it next to your browser, or keep it on a second monitor.
The flow is **you driving** - the skill only sets the stage.

---

## Pre-flight (run once, before the room)

```bash
# 1. make sure docker is up
docker compose up -d --build ai conversation frontend incoming-worker webhook gateway

# 2. reset any leftover state
INTERNAL_SERVICE_KEY="chatcenter-internal-2026" \
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/whatsapp_cc" \
./node_modules/.bin/tsx scripts/demo/cleanup.ts

# 3. stage the demo agent, pre-seed the EMAIL contact, sanity-check Zoho + permissions
INTERNAL_SERVICE_KEY="chatcenter-internal-2026" \
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/whatsapp_cc" \
./node_modules/.bin/tsx scripts/demo/run-demo.ts --phase=setup
```

Expected final line: `✓ Zoho CONNECTED, create_lead granted to agent`. If you see
`Zoho not CONNECTED` or `create_lead not granted`, fix it in AI Studio before
continuing - the rest of the demo won't work.

**Browser tabs** to open and leave alone:

| # | URL | Role |
|---|---|---|
| 1 | `/conversations` (logged in as ADMIN) | main stage |
| 2 | Zoho CRM → Leads | payoff tab |
| 3 | `/dashboard` | Command Center beat |
| 4 | `/approvals` *(optional)* | fallback view if you want a queue shot |

**Phone**: WhatsApp open, chat drafted but not sent, ready to fire.

---

## The flow

### 🟣 Turn 1 - open the door (say "hey")

Send from your phone:

```
hey
```

Expected: bot replies within ~5s - `היי! איך אני יכול לעזור לך היום?`
(or similar). Conversation appears in the `/conversations` inbox.

**Narrate**: *"A customer just pinged us on WhatsApp. Bot greets in their
language."*

---

### 🟣 Turn 2 - buying intent + contact details

Send from your phone (paste, don't retype - avoids typos that might trip the
Hebrew keyword guard):

```
היי! ראיתי את הפלטפורמה שלכם לניהול ווצאפ עסקי. אני מנהל תמיכה לצוות מכירות של 15 אנשים ואנחנו טובעים בהודעות. מה המחירים שלכם?
```

Expected: bot asks for your name / email / phone.

**Narrate**: *"Customer shows intent. Bot doesn't quote prices it doesn't know
- it asks for qualifying info first."*

---

### 🟣 Turn 3 - hand over the identity details

Send from your phone:

```
מעולה! אני רוצה להירשם. שמי עומר סרויה, האימייל שלי omerts58@gmail.com, הטלפון +972525401686, החברה GotchaDemo Ltd. יש לי צוות של 15 אנשים בתחום המכירות.
```

Expected, in order (5–10s total):

1. **Bot goes quiet** (no reply) - it's calling the `create_lead` tool under the hood.
2. The **amber Approval Card** appears at the top of the conversation in the
   inbox. It shows:
   - **Create Lead · in Zoho CRM** (humanized tool name)
   - Risk chip: `HIGH RISK`
   - Lead preview with 👤 name, 📧 email, 📱 phone, 🏢 company + 📝 notes block
   - Customer snapshot + last 2 messages inline
   - Two buttons: **✓ Approve & run** / **Reject**

**Narrate**: *"The bot recognized a high-risk action - creating a CRM record -
and paused. The policy engine's decision: this needs a human."*

---

### 🟣 Turn 4 - approve, Zoho gets the lead

Click **✓ Approve & run** on the card. Button shows a spinner
("Running…"), then the card disappears within ~2s.

Switch to **Tab 2 (Zoho → Leads)**. The new lead is at the top:
*Omer Serruya · GotchaDemo Ltd · omerts58@gmail.com · +972525401686*,
description in Hebrew.

**Narrate**: *"One click from me, a real lead in Zoho. The bot didn't hit the
API itself - the policy engine + human co-sign did."*

Switch back to **Tab 1 (Conversations)**.

---

### 🟣 Turn 5 - cross-channel identity merge (one command in terminal)

The autonomous bot doesn't call `link_customer_identifier` when the email is
already in the lead payload. To demonstrate the cross-channel unify path, fire
a single command from your terminal:

```bash
INTERNAL_SERVICE_KEY="chatcenter-internal-2026" \
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/whatsapp_cc" \
./node_modules/.bin/tsx -e '
import { PrismaClient } from "@prisma/client";
import axios from "axios";
const p = new PrismaClient();
(async () => {
  const wa = await p.contact.findFirst({ where: { tenantId: "cmmov5qh10000ltnqm7pmxqzc", channel: "WHATSAPP", externalId: "972525401686" }, select: { id: true } });
  const r = await axios.post("http://localhost:80/api/identity/link", {
    contactId: wa!.id, type: "email", value: "omerts58@gmail.com", confidence: 0.9,
    reason: "customer re-shared personal email",
  }, { headers: { Authorization: "Bearer chatcenter-internal-2026", "x-tenant-id": "cmmov5qh10000ltnqm7pmxqzc", "Content-Type": "application/json" } });
  console.log(JSON.stringify(r.data, null, 2));
  await p.$disconnect();
})();
'
```

Expected: `outcome: "suggestion_created"` with sourceContactId (WA),
targetContactId (EMAIL), identifierValue `omerts58@gmail.com`.

Open the contact card for this customer (from the inbox, click the customer
name) - the merge suggestion is in the identity timeline.

**Narrate**: *"Same person was already in our system on email from a newsletter
signup. GOTCHA linked them without me asking - one unified timeline across
channels."*

---

### 🟣 Turn 6 - Command Center, global scope

Switch to **Tab 3 (`/dashboard`)**. Press **Ctrl/Cmd + K**.

You'll see the Command Center modal: the Siri orb breathes in indigo/violet.
Type:

```
Create a broadcast for all contacts tagged trial, announce premium launches next week, schedule for Monday 9am
```

Expected:

- Orb shifts to **thinking pulse** (sky → indigo → pink, faster breath)
- Assistant bubble appears with a plan - 2 steps, amber chip
  `REQUIRES APPROVAL`
- Per-step detail: `create_broadcast` (high) + `schedule_broadcast` (high)

**Narrate**: *"Same natural-language interface, same policy engine. Broadcasts
are high-risk - they want approval too."*

Click **Approve & execute** → system marker `✓ Executed` appears below.

---

### 🟣 Turn 7 - Command Center, conversation scope

Close the modal (Esc). Switch to **Tab 1 (`/conversations`)**, click the
customer's chat. Press **Ctrl/Cmd + K** again. Scope badge now shows
`· conv: <id>`.

Type:

```
שלח תשובה שנחזור מחר בבוקר עם הצעת מחיר, ותייג את הלקוח כ-hot-lead
```

Expected:

- Plan: 2 steps, both **low risk** (no approval required)
- `send_message` + `tag_contact`

**Narrate**: *"Two tools, one sentence, zero approvals - because neither is
high-risk. This is the daily driver for supervisors."*

Click **Execute**. The message appears in the chat in real time. The tag pill
appears on the contact.

---

### 🟣 Close (20 seconds)

*"Three things from today:*
- *Bot doesn't touch the big stuff without a human - one policy engine, one
  surface, consistent across bots, broadcasts, and command center.*
- *Co-pilot makes humans twice as fast when they do take over.*
- *Natural language turns into real, audited, cross-system actions - not
  text-to-summary demos."*

---

## Recovery (if a beat breaks live)

| Symptom | What to do |
|---|---|
| Bot doesn't reply to turn 1 | Check the `/conversations` inbox - if a new WhatsApp row appeared but no bot reply, say *"that's the bot thinking - let me refresh"* and reload. |
| Bot replies in English | Not a break - just keep going. Hebrew was just the default. |
| Turn 3 causes the "Let me connect you..." message | You hit the `נציג` substring bug. Re-phrase - avoid `נציג`, `לדבר עם`, `אדם אמיתי`. Then run `cleanup.ts` + `run-demo.ts --phase=setup` and restart. |
| Approval card shows but Approve button 401s | You're on a pre-fix build. `docker compose up -d --build conversation` and reload the page. |
| Command Center modal stalls on "Thinking…" | Press Esc. Check that `ai` container is healthy. Fallback: skip to another beat. |
| Zoho lead didn't appear | Check the OAuth token expiry in `/integrations`. If expired: reconnect Zoho, then re-run from turn 3. |

---

## Don'ts (live)

- ❌ Don't type `נציג` in any Hebrew message - triggers the keyword auto-escalation bypass.
- ❌ Don't wait >5 minutes between turns in the same conversation on unfixed agents (auto-escalation on `maxAutonomousMinutes`). The demo agent is bumped to 999 - safe.
- ❌ Don't click **Reject** on the approval in the demo flow - it flags the conversation as human-handoff and the story ends.
- ❌ Don't refresh the Command Center modal mid-plan - session history is local to that modal instance.

---

## Reset between rehearsals

```bash
INTERNAL_SERVICE_KEY="chatcenter-internal-2026" \
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/whatsapp_cc" \
./node_modules/.bin/tsx scripts/demo/cleanup.ts

INTERNAL_SERVICE_KEY="chatcenter-internal-2026" \
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/whatsapp_cc" \
./node_modules/.bin/tsx scripts/demo/run-demo.ts --phase=setup
```

Add `--restore-agent` to the cleanup if you want to revert the
systemPrompt and autonomy limits too (leave them unless you care about
pristine agent state).
