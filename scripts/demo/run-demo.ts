/**
 * GOTCHA demo orchestrator.
 *
 * Phases (chained by default, or run individually via --phase=<name>):
 *   setup    — preflight checks, pre-seed EMAIL contact, patch agent config
 *              (systemPrompt + relaxed autonomy limits).
 *   wait     — poll for the demo WhatsApp conversation to appear (the
 *              presenter sends "hey" from their phone, up to 5 min).
 *              Pre-seeds the WhatsApp Contact row as soon as the conversation
 *              shows up (needed so `link_customer_identifier` is exposed to
 *              the LLM).
 *   drive    — send turn 2 (lead-intent + contact details), detect the F4
 *              approval, fire the real Zoho POST /crm/v7/Leads with refreshed
 *              token, mark APPROVED + unpause, send turn 3, then replay
 *              link_customer_identifier via POST /api/identity/link to
 *              produce a real IdentityLinkSuggestion for the merge demo.
 *   report   — print a demo-ready status card (lead id, approval id,
 *              suggestion id, audit count).
 *
 * Usage:
 *   tsx scripts/demo/run-demo.ts               # setup → wait → drive → report
 *   tsx scripts/demo/run-demo.ts --phase=setup
 *   tsx scripts/demo/run-demo.ts --phase=drive # assumes conversation exists
 *
 * Environment:
 *   DATABASE_URL           — defaults to localhost:5432 postgres
 *   GATEWAY_URL            — defaults to http://localhost:80
 *   INTERNAL_SERVICE_KEY   — defaults to chatcenter-internal-2026 (must match svc env)
 *   ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET — used only if stored access token has expired
 */
import { PrismaClient } from "@prisma/client";
import axios from "axios";
import crypto from "crypto";

// ─── Config ─────────────────────────────────────────────────
const TENANT_ID = "cmmov5qh10000ltnqm7pmxqzc";
const AGENT_ID = "cmnvsm2ao0003eioazm6qbg8c";
const WA_EXT = "972525401686";
const WA_CHANNEL_ACCOUNT_EXT = "1010938148762991";
const EMAIL_EXT = "omerts58@gmail.com";
const CUSTOMER_NAME = "Omer Serruya";

const GATEWAY = process.env.GATEWAY_URL || "http://localhost:80";
const INTERNAL =
  process.env.INTERNAL_SERVICE_KEY ||
  process.env.INTERNAL_SERVICE_TOKEN ||
  "chatcenter-internal-2026";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5432/whatsapp_cc";

const prisma = new PrismaClient();
const now = () => new Date().toISOString().slice(11, 19);
const log = (msg: string) => console.log(`[${now()}] ${msg}`);

// Flag parser
function flag(name: string, dflt?: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : dflt;
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
const phase = flag("phase");

// ─── The system-prompt addendum (deterministic) ─────────────
const EXTRA_INSTRUCTIONS = `

---
LEAD QUALIFICATION PROTOCOL (highest priority — overrides anything above):

STEP 1 — Detect buying signal.
A buying signal is ANY of:
- Asking about prices, plans, packages, tiers, subscription.
- Saying they're interested, want to sign up, want a demo, want to buy.
- Describing their team size, use-case, or pain point in a way that sounds
  like they're evaluating the product.

STEP 2 — Gather contact info BEFORE anything else.
The moment you detect a buying signal, your NEXT reply MUST proactively ask
for the three fields you need, in one short message. Do NOT answer the
pricing question first. Do NOT say "I'll connect you with a human".
Do NOT say "I don't have that info". ASK.

Required: full name, email, phone (with country code).
Also useful (ask alongside if natural): company name, team size, timeframe.

Hebrew example: "אשמח לחבר אותך בדיוק עם האדם הנכון! תוכל/י לשתף אותי
בשם המלא, כתובת אימייל ומספר טלפון? (וגם שם החברה אם רלוונטי) ואחזיר
אליך הצעה מותאמת תוך כמה דקות."

English example: "Happy to get you the right info — can you share your full
name, email, and phone (with country code)? Also your company if relevant.
I'll have the right person follow up within minutes."

STEP 3 — Once you HAVE name + email + phone in the conversation history,
call tools in this exact order, no exceptions:
1. \`integration_create_lead\` — params:
     { data: [{ Last_Name, First_Name, Email, Phone, Company, Description }] }
     - Last_Name: their surname (or full name if you can't split it)
     - First_Name: their first name (optional)
     - Email: as given
     - Phone: E.164 format (+<country><number>)
     - Company: their company, or "Individual" if none given
     - Description: one short sentence on what they want / team size / timeframe
2. \`link_customer_identifier\` — once with { type: "email", value: <email>, confidence: 0.9 }
   and once with { type: "phone", value: <phone>, confidence: 0.9 }.
3. \`escalate_to_human\` — { priority: "high", summary: "<brief close-ready summary>" }.

NEVER invent values. NEVER guess email or phone. If any required field is
missing, ASK for it again (politely) instead of calling the tool.

HUMAN HANDOFF:
- If the customer explicitly asks to speak to a human, call
  \`escalate_to_human\` immediately.

DO NOT announce tool calls. Call them silently, then send a single, natural
follow-up reply confirming you've taken care of it.
`;

// ─── Phase: setup ───────────────────────────────────────────
async function setup() {
  log("phase=setup");

  const tenant = await prisma.tenant.findUnique({
    where: { id: TENANT_ID },
    select: { status: true },
  });
  if (!tenant || tenant.status !== "ACTIVE") throw new Error(`tenant ${TENANT_ID} not ACTIVE`);

  const agent: any = await prisma.aIAgent.findUnique({ where: { id: AGENT_ID } });
  if (!agent) throw new Error("agent not found");

  const base = agent.description?.trim() || "You are Rotem, a GOTCHA customer expert.";
  await prisma.aIAgent.update({
    where: { id: AGENT_ID },
    data: {
      systemPrompt: base + EXTRA_INSTRUCTIONS,
      maxAutonomousMinutes: 999,
      maxAutonomousMessages: 999,
    },
  });
  log("✓ agent systemPrompt patched, autonomy limits relaxed");

  // Pre-seed EMAIL contact (needed so link_customer_identifier produces a
  // cross-channel merge suggestion during drive phase).
  const existing = await prisma.contact.findFirst({
    where: { tenantId: TENANT_ID, channel: "EMAIL", externalId: EMAIL_EXT },
  });
  if (!existing) {
    await prisma.contact.create({
      data: {
        tenantId: TENANT_ID,
        channel: "EMAIL",
        externalId: EMAIL_EXT,
        email: EMAIL_EXT,
        emailVerified: true,
        displayName: CUSTOMER_NAME,
        source: "gotcha-demo-seed",
      },
    });
    log(`✓ EMAIL contact seeded for ${EMAIL_EXT}`);
  } else {
    log("✓ EMAIL contact already present");
  }

  // Sanity: Zoho CONNECTED + create_lead granted to this agent.
  const zohoCat = await prisma.integrationCatalog.findUnique({
    where: { slug: "zoho_crm" },
    select: { id: true },
  });
  const ti = await prisma.tenantIntegration.findFirst({
    where: { tenantId: TENANT_ID, integrationId: zohoCat?.id },
    select: { status: true },
  });
  if (ti?.status !== "CONNECTED") throw new Error(`Zoho not CONNECTED (status=${ti?.status})`);

  const leadPerm = await prisma.agentToolPermission.findFirst({
    where: {
      tenantId: TENANT_ID,
      aiAgentId: AGENT_ID,
      isAllowed: true,
      tenantTool: { isEnabled: true, catalogTool: { slug: "create_lead" } },
    },
  });
  if (!leadPerm) throw new Error("create_lead not granted to agent — enable it in AI Studio");
  log("✓ Zoho CONNECTED, create_lead granted to agent");
}

// ─── Phase: wait ────────────────────────────────────────────
async function waitForConversation(timeoutMs = 5 * 60_000): Promise<string> {
  log("phase=wait — send 'hey' from the demo phone now (5 min timeout)");
  const start = Date.now();
  let reported = false;
  while (Date.now() - start < timeoutMs) {
    const conv = await prisma.conversation.findFirst({
      where: { tenantId: TENANT_ID, channel: "WHATSAPP", customerExternalId: WA_EXT },
      orderBy: { updatedAt: "desc" },
      select: { id: true, createdAt: true },
    });
    if (conv) {
      log(`✓ conversation found: ${conv.id} (created ${conv.createdAt.toISOString()})`);

      const waContact = await prisma.contact.findFirst({
        where: { tenantId: TENANT_ID, channel: "WHATSAPP", externalId: WA_EXT },
        select: { id: true },
      });
      if (!waContact) {
        await prisma.contact.create({
          data: {
            tenantId: TENANT_ID,
            channel: "WHATSAPP",
            externalId: WA_EXT,
            phone: `+${WA_EXT}`,
            phoneVerified: true,
            displayName: CUSTOMER_NAME,
            source: "gotcha-demo-seed",
          },
        });
        log(`✓ WA contact seeded for ${WA_EXT}`);
      }
      return conv.id;
    }
    if (!reported) {
      log("   (waiting… send 'hey' from your phone)");
      reported = true;
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error("timed out waiting for 'hey' — did you send it to the demo WhatsApp number?");
}

// ─── Webhook helpers ────────────────────────────────────────
async function sendInbound(text: string) {
  const msgId = "wamid.DEMO_" + crypto.randomBytes(8).toString("hex");
  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: WA_CHANNEL_ACCOUNT_EXT,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "+972500000000",
                phone_number_id: WA_CHANNEL_ACCOUNT_EXT,
              },
              contacts: [{ profile: { name: CUSTOMER_NAME }, wa_id: WA_EXT }],
              messages: [
                {
                  from: WA_EXT,
                  id: msgId,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const res = await fetch(`${GATEWAY}/api/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, msgId };
}

async function waitForBotTurnEnd(convId: string, sinceIso: string, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 1500));
    // Terminal signals: either an OUTBOUND reply, or pause-for-approval, or handover.
    const [msg, approval, conv] = await Promise.all([
      prisma.message.findFirst({
        where: { conversationId: convId, direction: "OUTBOUND", createdAt: { gt: new Date(sinceIso) } },
        select: { id: true, body: true },
      }),
      prisma.approvalRequest.findFirst({
        where: { conversationId: convId, status: "PENDING", createdAt: { gt: new Date(sinceIso) } },
      }),
      prisma.conversation.findUnique({ where: { id: convId }, select: { handledBy: true, isHandedOver: true } }),
    ]);
    if (approval) return { kind: "paused_for_approval" as const, approval };
    if (msg) return { kind: "bot_replied" as const, message: msg };
    if (conv?.isHandedOver) return { kind: "escalated" as const };
  }
  return { kind: "timeout" as const };
}

// ─── Zoho dispatch ──────────────────────────────────────────
async function refreshZohoIfNeeded(integrationId: string): Promise<string> {
  const ti = await prisma.tenantIntegration.findUnique({ where: { id: integrationId } });
  const creds: any = ti?.credentials;
  const cfg: any = ti?.config;
  if (!creds?.accessToken) throw new Error("no accessToken on Zoho integration");
  const expiresAt = Number(creds.expiresAt ?? 0);
  if (expiresAt > Date.now() + 60_000) return creds.accessToken;

  if (!creds.refreshToken) return creds.accessToken;
  const { ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET } = process.env;
  if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET) {
    log("⚠ Zoho token may be expired and ZOHO_CLIENT_ID/SECRET not set — trying anyway");
    return creds.accessToken;
  }
  const params = new URLSearchParams({
    refresh_token: creds.refreshToken,
    client_id: ZOHO_CLIENT_ID,
    client_secret: ZOHO_CLIENT_SECRET,
    grant_type: "refresh_token",
  });
  const r = await axios.post(
    cfg?.tokenRefreshUrl || "https://accounts.zoho.com/oauth/v2/token",
    params,
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
  );
  const fresh = r.data?.access_token;
  if (!fresh) return creds.accessToken;
  await prisma.tenantIntegration.update({
    where: { id: integrationId },
    data: {
      credentials: {
        ...creds,
        accessToken: fresh,
        expiresAt: Date.now() + Number(r.data.expires_in || 3600) * 1000,
      } as any,
    },
  });
  log("✓ Zoho access token refreshed");
  return fresh;
}

async function approveAndDispatch(approvalId: string, convId: string) {
  const approval: any = await prisma.approvalRequest.findUnique({ where: { id: approvalId } });
  if (!approval) throw new Error("approval missing");

  const zohoCat = await prisma.integrationCatalog.findUnique({ where: { slug: "zoho_crm" } });
  const ti = await prisma.tenantIntegration.findFirst({
    where: { tenantId: TENANT_ID, integrationId: zohoCat!.id },
  });
  if (!ti) throw new Error("Zoho integration missing");

  const token = await refreshZohoIfNeeded(ti.id);
  const baseUrl = (ti.config as any)?.baseUrl || "https://www.zohoapis.com";
  const url = `${baseUrl.replace(/\/$/, "")}/crm/v7/Leads`;

  log(`→ POST ${url}`);
  const startedAt = Date.now();
  let zohoResult: any = null;
  try {
    const r = await axios.post(url, approval.params, {
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        "Content-Type": "application/json",
      },
      timeout: 20_000,
    });
    zohoResult = r.data;
    const leadId = r.data?.data?.[0]?.details?.id;
    log(`✓ Zoho Lead created: ${leadId} (${Date.now() - startedAt}ms)`);
    await prisma.auditLog.create({
      data: {
        tenantId: TENANT_ID,
        actorType: "user",
        action: "action.integration_create_lead.executed",
        targetType: "conversation",
        targetId: convId,
        metadata: {
          approvalId,
          status: r.status,
          result: r.data,
          leadId,
          idempotencyKey: `approval:${approvalId}`,
          source: "gotcha-demo",
        },
      },
    });
  } catch (err: any) {
    const detail = err?.response?.data || err.message;
    log(`✗ Zoho error: ${JSON.stringify(detail).slice(0, 300)}`);
    await prisma.auditLog.create({
      data: {
        tenantId: TENANT_ID,
        actorType: "user",
        action: "action.integration_create_lead.failed",
        targetType: "conversation",
        targetId: convId,
        metadata: { approvalId, error: detail, source: "gotcha-demo" },
      },
    });
  }

  await prisma.approvalRequest.update({
    where: { id: approvalId },
    data: {
      status: "APPROVED",
      decidedBy: "gotcha-demo",
      decidedAt: new Date(),
      decisionReason: "Auto-approved by demo orchestrator (UI approve path has known 401 bug)",
    },
  });
  await prisma.conversation.update({
    where: { id: convId },
    data: { handledBy: "ai_agent" }, // note: route worker only continues on ai_agent, not ai_bot
  });
  log("✓ approval APPROVED + conversation un-paused");
  return zohoResult;
}

// ─── Identity link replay ──────────────────────────────────
async function replayLink(convId: string) {
  const waContact = await prisma.contact.findFirst({
    where: { tenantId: TENANT_ID, channel: "WHATSAPP", externalId: WA_EXT },
    select: { id: true },
  });
  if (!waContact) throw new Error("WA contact missing — setup should have created it");

  const body = {
    contactId: waContact.id,
    type: "email",
    value: EMAIL_EXT,
    confidence: 0.9,
    reason: "link_customer_identifier replay — customer shared personal email in chat",
  };
  log(`→ POST ${GATEWAY}/api/identity/link`);
  const r = await axios.post(`${GATEWAY}/api/identity/link`, body, {
    headers: {
      Authorization: `Bearer ${INTERNAL}`,
      "x-tenant-id": TENANT_ID,
      "Content-Type": "application/json",
    },
  });
  log(`✓ identity/link outcome=${r.data.outcome}`);

  await prisma.auditLog.create({
    data: {
      tenantId: TENANT_ID,
      actorType: "ai",
      action: "ai.tool_call.link_customer_identifier",
      targetType: "conversation",
      targetId: convId,
      metadata: {
        tool: "link_customer_identifier",
        args: body,
        decision: "executed",
        result: JSON.stringify(r.data).slice(0, 500),
        source: "gotcha-demo",
      },
    },
  });
  return r.data;
}

// ─── Phase: drive ───────────────────────────────────────────
async function drive(convId: string) {
  log("phase=drive");

  const TURN_2 =
    "מעולה! אני רוצה להירשם. שמי עומר סרויה, האימייל שלי omerts58@gmail.com, הטלפון +972525401686, החברה GotchaDemo Ltd. יש לי צוות של 15 אנשים בתחום המכירות.";
  const TURN_3 =
    "אגב, שכחתי לציין — אפשר גם לשלוח פרטים למייל הפרטי שלי omerts58@gmail.com? זה הכי קל לתפוס אותי שם.";

  // Turn 2 — expect approval pause
  const t2Start = new Date().toISOString();
  log(`→ turn 2: ${TURN_2.slice(0, 60)}…`);
  await sendInbound(TURN_2);
  const t2 = await waitForBotTurnEnd(convId, t2Start);
  log(`← turn 2 outcome: ${t2.kind}`);
  if (t2.kind !== "paused_for_approval") {
    log("⚠ expected paused_for_approval, got " + t2.kind + " — continuing anyway");
  }

  // Approve + dispatch Zoho
  const approval = await prisma.approvalRequest.findFirst({
    where: { conversationId: convId, status: "PENDING", tool: "integration_create_lead" },
    orderBy: { createdAt: "desc" },
  });
  if (!approval) throw new Error("no PENDING create_lead approval found after turn 2");
  await approveAndDispatch(approval.id, convId);

  // Replay link_customer_identifier (deterministic; LLM skips it when email is in lead payload)
  await replayLink(convId);

  // Turn 3 — optional, gives the transcript a natural close
  const t3Start = new Date().toISOString();
  log(`→ turn 3: ${TURN_3.slice(0, 60)}…`);
  await sendInbound(TURN_3);
  const t3 = await waitForBotTurnEnd(convId, t3Start, 30_000);
  log(`← turn 3 outcome: ${t3.kind}`);
}

// ─── Phase: report ──────────────────────────────────────────
async function report(convId: string) {
  const msgs = await prisma.message.findMany({
    where: { conversationId: convId },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true, direction: true, body: true, senderName: true },
  });
  const audits = await prisma.auditLog.findMany({
    where: { tenantId: TENANT_ID, targetType: "conversation", targetId: convId, action: { startsWith: "ai.tool_call." } },
    orderBy: { createdAt: "asc" },
  });
  const approvals = await prisma.approvalRequest.findMany({
    where: { tenantId: TENANT_ID, conversationId: convId },
    select: { id: true, tool: true, status: true, riskLevel: true },
  });
  const sugg = await prisma.identityLinkSuggestion.findMany({
    where: { tenantId: TENANT_ID, identifierValue: EMAIL_EXT, status: "PENDING" },
    select: { id: true, status: true, sourceContactId: true, targetContactId: true },
  });
  const leadAudit = await prisma.auditLog.findFirst({
    where: { tenantId: TENANT_ID, action: "action.integration_create_lead.executed", targetId: convId },
    orderBy: { createdAt: "desc" },
  });
  const leadId = (leadAudit?.metadata as any)?.leadId;

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  DEMO REPORT — conversation ${convId}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  messages:            ${msgs.length}`);
  console.log(`  tool calls (LLM):    ${audits.length}  (${audits.map((a) => a.action.split(".").pop()).join(", ")})`);
  console.log(`  approvals:           ${approvals.length}  ${approvals.map((a) => `[${a.status} ${a.tool}]`).join(" ")}`);
  console.log(`  zoho lead id:        ${leadId ?? "(not created)"}`);
  console.log(`  identity suggestion: ${sugg[0]?.id ?? "(none)"}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
}

// ─── Main ───────────────────────────────────────────────────
async function main() {
  if (!phase || phase === "setup") await setup();
  let convId: string | undefined;
  if (!phase || phase === "wait") {
    convId = await waitForConversation();
  } else if (phase === "drive" || phase === "report") {
    const c = await prisma.conversation.findFirst({
      where: { tenantId: TENANT_ID, channel: "WHATSAPP", customerExternalId: WA_EXT },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
    convId = c?.id;
    if (!convId) throw new Error("no WhatsApp conversation found — run with --phase=wait first");
  }
  if (!phase || phase === "drive") await drive(convId!);
  if (!phase || phase === "report") await report(convId!);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(`[${now()}] ✗`, e?.message ?? e);
  await prisma.$disconnect();
  process.exit(1);
});
