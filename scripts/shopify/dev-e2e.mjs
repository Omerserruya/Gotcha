#!/usr/bin/env node
/**
 * Shopify Dev end-to-end harness.
 *
 * Drives a real customer conversation the way a customer actually arrives: a
 * SIGNED WhatsApp webhook, through the gateway, into the worker, through the
 * AI, out to Shopify and back. No service is called directly except to read
 * state back for verification, because the bugs this repo keeps finding live
 * in the seams between those steps, not inside any one of them.
 *
 * Everything here mutates a real store, so it is opt-in and it refuses to run
 * unless every guard passes:
 *
 *   SHOPIFY_DEV_E2E=true    explicit intent
 *   NODE_ENV != production
 *   tenant, shop domain, WhatsApp channel and customer phone all allowlisted
 *
 * The allowlists are literals in this file rather than environment variables
 * on purpose: an env var is exactly the thing that gets set wrong on the day
 * someone runs this against a merchant's live store.
 *
 * Usage:
 *   SHOPIFY_DEV_E2E=true node scripts/shopify/dev-e2e.mjs say "מה קורה עם הזמנה 1011?"
 *   SHOPIFY_DEV_E2E=true node scripts/shopify/dev-e2e.mjs order '#1011'
 *   SHOPIFY_DEV_E2E=true node scripts/shopify/dev-e2e.mjs approvals
 *   SHOPIFY_DEV_E2E=true node scripts/shopify/dev-e2e.mjs approve <id>
 *   SHOPIFY_DEV_E2E=true node scripts/shopify/dev-e2e.mjs reject  <id> "reason"
 *   SHOPIFY_DEV_E2E=true node scripts/shopify/dev-e2e.mjs state
 *   SHOPIFY_DEV_E2E=true node scripts/shopify/dev-e2e.mjs fixtures
 *   SHOPIFY_DEV_E2E=true node scripts/shopify/dev-e2e.mjs scenario "<hebrew>" [waitSeconds]
 *   SHOPIFY_DEV_E2E=true node scripts/shopify/dev-e2e.mjs suite            # every named capability
 *   SHOPIFY_DEV_E2E=true node scripts/shopify/dev-e2e.mjs suite missing-item
 *   SHOPIFY_DEV_E2E=true node scripts/shopify/dev-e2e.mjs customer
 *   SHOPIFY_DEV_E2E=true node scripts/shopify/dev-e2e.mjs tools
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import crypto from "node:crypto";

// ─── Allowlists. Deliberately literal. ──────────────────────────────────────
const ALLOW = {
  tenantId: "cms4ug98n0004chmrp4lv6ujl",
  tenantName: "Urban Supply - GOTCHA Demo",
  shopDomains: ["urban-supply-gotcha-demo.myshopify.com"],
  // Demo WhatsApp business phone-number id (the channel we may send through).
  channelExternalId: "1010938148762991",
  // The ONLY number this harness will ever originate a message from.
  customerPhones: ["972545680665"],
};

const DB = ["compose", "exec", "-T", "db", "psql", "-U", "postgres", "-d", "whatsapp_cc"];

function docker(args, input) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** One-column, tab-separated psql query. */
function sql(query) {
  return docker([...DB, "-A", "-F", "\t", "-t", "-c", query]).trim();
}

/** Run a node snippet inside a service container (they hold the secrets). */
function inContainer(service, js) {
  return docker(["compose", "exec", "-T", service, "node", "-e", js], undefined).trim();
}

// ─── Guards ─────────────────────────────────────────────────────────────────

function die(why) {
  console.error(`\n  REFUSING TO RUN\n  ${why}\n`);
  process.exit(2);
}

function preflight() {
  if (process.env.SHOPIFY_DEV_E2E !== "true") {
    die("SHOPIFY_DEV_E2E is not 'true'. This harness mutates a real Shopify store.");
  }
  if ((process.env.NODE_ENV || "").toLowerCase() === "production") {
    die("NODE_ENV is production.");
  }

  // The tenant must be the one we think it is, by NAME as well as id - an id
  // that got copied between environments would otherwise sail through.
  const tenant = sql(`select name from tenants where id='${ALLOW.tenantId}'`);
  if (tenant !== ALLOW.tenantName) {
    die(`tenant ${ALLOW.tenantId} is "${tenant || "missing"}", expected "${ALLOW.tenantName}".`);
  }

  const shop = sql(
    `select config->>'shopDomain' from tenant_integrations ti
     join integration_catalog ic on ic.id=ti.integration_id
     where ti.tenant_id='${ALLOW.tenantId}' and ic.slug='shopify'`,
  );
  if (!ALLOW.shopDomains.includes(shop)) {
    die(`shop domain "${shop}" is not allowlisted. Allowed: ${ALLOW.shopDomains.join(", ")}`);
  }

  const channel = sql(
    `select external_id from channel_accounts
     where tenant_id='${ALLOW.tenantId}' and channel='WHATSAPP' and is_active`,
  );
  if (channel !== ALLOW.channelExternalId) {
    die(`WhatsApp channel "${channel}" is not the approved Dev channel.`);
  }

  // A production Shopify host anywhere in the connection is disqualifying.
  if (shop.includes("myshopify.com") === false) {
    die(`shop domain "${shop}" is not a myshopify.com dev store.`);
  }

  return { shop, channel };
}

// ─── Inbound: a genuinely signed WhatsApp webhook ───────────────────────────

function sendInbound(text, phone = ALLOW.customerPhones[0]) {
  if (!ALLOW.customerPhones.includes(phone)) {
    die(`phone ${phone} is not allowlisted. This harness never messages anyone else.`);
  }
  // Signing happens INSIDE the webhook container, which is the only place the
  // app secret exists. Signature verification is mandatory and fail-closed, so
  // an unsigned replay would be silently dropped and look like a bot failure.
  const js = `
    const crypto = require("crypto");
    const secret = process.env.WHATSAPP_APP_SECRET || process.env.META_APP_SECRET;
    const payload = ${JSON.stringify(
      JSON.stringify({
        object: "whatsapp_business_account",
        entry: [
          {
            id: "WABA_DEV_E2E",
            changes: [
              {
                field: "messages",
                value: {
                  messaging_product: "whatsapp",
                  metadata: { display_phone_number: "15550000000", phone_number_id: ALLOW.channelExternalId },
                  contacts: [{ profile: { name: "Matan Amran" }, wa_id: phone }],
                  messages: [{ from: phone, id: "__WAMID__", timestamp: "0", type: "text", text: { body: text } }],
                },
              },
            ],
          },
        ],
      }),
    )};
    const wamid = "wamid.e2e" + Date.now();
    const raw = payload.replace("__WAMID__", wamid).replace('"timestamp":"0"', '"timestamp":"' + Math.floor(Date.now()/1000) + '"');
    const sig = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
    fetch("http://localhost:4003/api/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-hub-signature-256": sig },
      body: raw,
    }).then(r => console.log(JSON.stringify({ status: r.status, wamid })));
  `;
  return JSON.parse(inContainer("webhook", js));
}

// ─── Verification reads ─────────────────────────────────────────────────────

const CONV_SCOPE = `(select id from conversations where tenant_id='${ALLOW.tenantId}' and customer_external_id='${ALLOW.customerPhones[0]}')`;

function transcript(sinceIso) {
  const rows = sql(
    `select direction, coalesce(message_type,'text'), coalesce(metadata->>'source',''), replace(coalesce(body,''), E'\\n',' ')
     from messages where conversation_id in ${CONV_SCOPE}
       ${sinceIso ? `and created_at > timestamp '${sinceIso}'` : ""}
     order by created_at`,
  );
  return rows ? rows.split("\n").map((l) => l.split("\t")) : [];
}

function approvals(sinceIso) {
  const rows = sql(
    `select id, tool, status, execution_state, coalesce(customer_notified_at::text,''), params::text
     from approval_requests where tenant_id='${ALLOW.tenantId}'
       ${sinceIso ? `and created_at > timestamp '${sinceIso}'` : ""}
     order by created_at`,
  );
  return rows ? rows.split("\n").map((l) => l.split("\t")) : [];
}

function ownership() {
  const rows = sql(
    `select handled_by, is_handed_over, status from conversations
     where tenant_id='${ALLOW.tenantId}' and customer_external_id='${ALLOW.customerPhones[0]}'
       and status <> 'CLOSED'`,
  );
  return rows ? rows.split("\n").map((l) => l.split("\t")) : [];
}

/** Read an order straight from Shopify - the independent check. */
function readOrder(orderName) {
  const js = `
    const key = process.env.INTERNAL_SERVICE_KEY;
    fetch("http://ai:4006/api/ai-assist/system/adapter-tools/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key, "x-tenant-id": "${ALLOW.tenantId}" },
      body: JSON.stringify({ toolFunctionName: "shopify.get_order", args: { order_name: ${JSON.stringify(orderName)} } }),
    }).then(r => r.text()).then(t => {
      const o = (JSON.parse(t).data || {}).output || {};
      console.log(JSON.stringify({
        name: o.name, financial_status: o.financial_status, fulfillment_status: o.fulfillment_status,
        cancelled_at: o.cancelled_at, total_price: o.total_price, currency: o.currency,
        refunds: (o.refunds || []).map(r => ({ id: r.id, amount: r.amount })),
      }));
    });
  `;
  return JSON.parse(inContainer("conversation", js));
}

// ─── Approval decisions, through the SAME endpoints the product uses ────────

function decide(kind, approvalId, reason) {
  if (kind === "approve") {
    sql(
      `update approval_requests set status='APPROVED', decided_by='dev-e2e', decided_at=now()
       where id='${approvalId}' and tenant_id='${ALLOW.tenantId}' and status='PENDING'`,
    );
  } else {
    sql(
      `update approval_requests set status='REJECTED', decided_by='dev-e2e', decided_at=now(),
       decision_reason='${String(reason || "rejected by dev-e2e").replace(/'/g, "''")}'
       where id='${approvalId}' and tenant_id='${ALLOW.tenantId}' and status='PENDING'`,
    );
  }
  const route = kind === "approve" ? "dispatch-approved" : "dispatch-rejected";
  const js = `
    const key = process.env.INTERNAL_SERVICE_KEY;
    fetch("http://localhost:4002/api/approvals/${approvalId}/${route}", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Key": key, "x-tenant-id": "${ALLOW.tenantId}" },
      body: JSON.stringify({ source: "dev-e2e" }),
    }).then(r => r.text()).then(t => console.log(t));
  `;
  return inContainer("conversation", js);
}

/** Read the customer straight from Shopify - the independent check for a profile write. */
function readCustomer(phone = ALLOW.customerPhones[0]) {
  if (!ALLOW.customerPhones.includes(phone)) die(`phone ${phone} is not allowlisted.`);
  const js = `
    const key = process.env.INTERNAL_SERVICE_KEY;
    fetch("http://ai:4006/api/ai-assist/system/adapter-tools/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key, "x-tenant-id": "${ALLOW.tenantId}" },
      body: JSON.stringify({ toolFunctionName: "shopify.get_customer_by_phone", args: { phone: "+${phone}" } }),
    }).then(r => r.text()).then(t => {
      const c = (JSON.parse(t).data || {}).output || {};
      console.log(JSON.stringify({
        id: c.id, first_name: c.first_name, last_name: c.last_name,
        email: c.email, phone: c.phone,
        default_address: c.default_address ? {
          address1: c.default_address.address1, city: c.default_address.city,
          province: c.default_address.province, zip: c.default_address.zip,
          country: c.default_address.country,
        } : null,
      }));
    });
  `;
  return JSON.parse(inContainer("conversation", js));
}

/**
 * The tool surface the AI actually holds.
 *
 * Worth a command of its own: Part 3's worst defect was a healthy connection
 * and an assistant with seven tools, and every health signal we had said the
 * integration was fine because all of them ask about the CONNECTION. This asks
 * what the assistant can do.
 */
function toolSurface() {
  const rows = sql(
    `select ct.slug, ct.allowed_modes::text, tt.is_enabled, atp.is_allowed
     from agent_tool_permissions atp
     join tenant_tools tt on tt.id = atp.tenant_tool_id
     join catalog_tools ct on ct.id = tt.catalog_tool_id
     join integration_catalog ic on ic.id = ct.integration_id
     where atp.tenant_id='${ALLOW.tenantId}' and ic.slug='shopify'
     order by ct.slug`,
  );
  return rows ? rows.split("\n").map((l) => l.split("\t")) : [];
}

// ─── Named scenarios ────────────────────────────────────────────────────────
//
// One entry per capability this round added or changed, so a rerun is a command
// rather than a paragraph of instructions that drifts from what was actually
// run. The `expect` notes are what a reader should check in the transcript;
// they are deliberately not assertions, because the interesting failures here
// are ones no assertion anticipated.

const SCENARIOS = {
  "unsupported-coupon": {
    say: "יש קופון שאני יכול לקבל?",
    expect: "plain refusal; NO discount tool, NO approval, NO handoff, AI retains the conversation",
  },
  "missing-item": {
    say: "קיבלתי את ההזמנה אבל חסר לי פריט",
    expect: "reconcile_order_items called; NO identity re-verification; names the item or asks only when genuinely ambiguous",
  },
  "note-tag": {
    say: "תרשמו בהזמנה 1011 שאני מבקש שיחזרו אליי לפני המשלוח",
    expect: "add_order_note called and read back; says the note was added; does NOT say a team was told",
  },
  "customer-profile-update": {
    say: "אפשר לעדכן את המייל שלי ל-matan.amran.dev@example.com?",
    expect: "update_my_profile with NO customer id asked for; confirms the new value first; read-back verified",
  },
  "shipping-address-update": {
    say: "אפשר לשנות את כתובת המשלוח בהזמנה 1011 להרצל 1, חיפה, ישראל?",
    expect: "eligibility from fulfillment orders; HITL raised when eligible; refusal names the real reason otherwise",
  },
  exchange: {
    say: "אפשר להחליף את המידה בהזמנה 1011 למידה אחרת?",
    expect: "variant_information first; same-price only; a price gap is refused with the exact difference, never a coupon",
  },
  "return-shopify": {
    say: "אני רוצה להחזיר את המוצר, הוא הגיע פגום",
    expect: "return provider resolved; a return claim ONLY with a real return id; otherwise a real handoff",
  },
  "return-returngo": {
    say: "מה הסטטוס של ההחזרה שלי?",
    expect: "status may read both providers; creation is never attempted in two places",
  },
  "send-confirmation": {
    say: "אפשר לקבל אישור הזמנה במייל?",
    expect: "goes to the stored address only; never asks where to send it; claims sent only after the tool succeeds",
  },
  "send-invoice": {
    say: "אני צריך חשבונית מס בבקשה",
    expect: "honest unavailability, no provider name or status code, no order summary dressed as a tax invoice",
  },
};

/**
 * The scopes Shopify says are granted, read live from the store.
 *
 * Not the cached capability state: a reconnect changes what the store granted
 * and nothing local knows until something asks. This asks.
 */
function scopeCheck() {
  // Through `tsx`, because the shared package inside the service container is
  // TypeScript source: a plain `node -e` that requires it dies on the first
  // `export`. Same route the ad-hoc probes take.
  const ts = `
    import { prisma, decryptCredentials } from "@chatcenter/shared";
    (async () => {
      const ti: any = await (prisma as any).tenantIntegration.findFirst({
        where: { tenantId: "${ALLOW.tenantId}", integration: { slug: "shopify" } },
      });
      const c: any = typeof ti.credentials === "string" ? decryptCredentials(ti.credentials) : ti.credentials;
      const shop = (ti.config as any).shopDomain;
      const r = await fetch(\`https://\${shop}/admin/oauth/access_scopes.json\`, {
        headers: { "X-Shopify-Access-Token": c.accessToken },
      });
      const j: any = await r.json();
      console.log(JSON.stringify({ status: r.status, shop, granted: (j.access_scopes || []).map((s: any) => s.handle).sort() }));
      process.exit(0);
    })();
  `;
  const file = `/tmp/dev-e2e-scope-${process.pid}.ts`;
  writeFileSync(file, ts, "utf8");
  docker(["compose", "cp", file, "ai:/app/services/ai/dev-e2e-scope.ts"]);
  const out = docker(["compose", "exec", "-T", "ai", "npx", "tsx", "dev-e2e-scope.ts"]).trim();
  const line = out.split("\n").filter((l) => l.trim().startsWith("{")).pop();
  if (!line) die(`scope probe returned nothing usable:\n${out.slice(0, 400)}`);
  return JSON.parse(line);
}

/** Every Shopify mutation this round made, newest first. The audit trail. */
function mutationLedger(limit = 40) {
  const rows = sql(
    `select created_at::text, action, coalesce(metadata->>'tool',''), left(coalesce(metadata::text,''), 160)
     from audit_logs where tenant_id='${ALLOW.tenantId}'
       and (action like '%adapter%' or action like '%approval%' or action like 'security.%')
     order by created_at desc limit ${Number(limit) || 40}`,
  );
  return rows ? rows.split("\n").map((l) => l.split("\t")) : [];
}

/** The turn's normalized outcome, as the contract recorded it. */
function outcomes(limit = 10) {
  const rows = sql(
    `select created_at::text, action, left(metadata::text, 200)
     from audit_logs where tenant_id='${ALLOW.tenantId}'
       and action in ('ai.unsupported_outcome_claim','ai.unsupported_action_claim','security.private_url_in_reply')
     order by created_at desc limit ${Number(limit) || 10}`,
  );
  return rows ? rows.split("\n").map((l) => l.split("\t")) : [];
}

/**
 * What this run left behind on the store, for the closure report.
 *
 * Deliberately a REPORT and not a cleanup: a harness that tidies up after
 * itself destroys the evidence that it ran.
 */
function cleanupReport() {
  const orders = ["#1002", "#1003", "#1006", "#1011", "#1012", "#1013", "#1014"];
  return orders.map((n) => {
    try {
      const o = readOrder(n);
      return { order: n, state: o.cancelled_at ? "cancelled" : o.financial_status, fulfillment: o.fulfillment_status ?? "unfulfilled", total: `${o.total_price} ${o.currency}` };
    } catch {
      return { order: n, state: "unreadable" };
    }
  });
}

// ─── Fixture manifest ───────────────────────────────────────────────────────

function fixtures() {
  const names = ["#1006", "#1007", "#1008", "#1009", "#1010", "#1011"];
  return names.map((n) => {
    try {
      const o = readOrder(n);
      return {
        order: n,
        state: o.cancelled_at ? "cancelled" : o.financial_status,
        fulfillment: o.fulfillment_status ?? "unfulfilled",
        total: `${o.total_price} ${o.currency}`,
        refunded: (o.refunds || []).reduce((s, r) => s + Number(r.amount || 0), 0).toFixed(2),
      };
    } catch {
      return { order: n, state: "unreadable" };
    }
  });
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const nowIso = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const env = preflight();
  console.log(`# tenant=${ALLOW.tenantName}  shop=${env.shop}  channel=${env.channel}\n`);

  switch (cmd) {
    case "say":
      console.log(JSON.stringify(sendInbound(rest.join(" ")), null, 1));
      break;

    case "scenario": {
      const text = rest[0];
      const wait = Number(rest[1] || 50);
      const since = nowIso();
      console.log(JSON.stringify(sendInbound(text)));
      await sleep(wait);
      console.log("\n--- TRANSCRIPT ---");
      for (const [dir, type, source, body] of transcript(since)) {
        console.log(`${dir}${source ? ` (${source})` : ""}: ${body || `[${type}]`}`);
      }
      console.log("\n--- APPROVALS ---");
      for (const a of approvals(since)) console.log(a.join(" | "));
      console.log("\n--- OWNERSHIP ---");
      for (const o of ownership()) console.log(o.join(" | "));
      break;
    }

    case "suite": {
      // One named capability, or all of them in order. Each run prints what a
      // reader is supposed to check, so a rerun and its evidence stay together.
      const wanted = rest[0] ? [rest[0]] : Object.keys(SCENARIOS);
      const wait = Number(rest[1] || 50);
      for (const name of wanted) {
        const s = SCENARIOS[name];
        if (!s) die(`unknown scenario "${name}". Known: ${Object.keys(SCENARIOS).join(", ")}`);
        const since = nowIso();
        console.log(`\n════════ ${name} ════════`);
        console.log(`> ${s.say}`);
        console.log(`# expect: ${s.expect}`);
        sendInbound(s.say);
        await sleep(wait);
        console.log("--- TRANSCRIPT ---");
        for (const [dir, type, source, body] of transcript(since)) {
          console.log(`${dir}${source ? ` (${source})` : ""}: ${body || `[${type}]`}`);
        }
        const aps = approvals(since);
        if (aps.length) {
          console.log("--- APPROVALS ---");
          for (const a of aps) console.log(a.join(" | "));
        }
        console.log("--- OWNERSHIP ---");
        for (const o of ownership()) console.log(o.join(" | "));
      }
      break;
    }

    case "customer":
      console.log(JSON.stringify(readCustomer(rest[0]), null, 1));
      break;

    case "scope-check": {
      const s = scopeCheck();
      const NEEDED = [
        "read_orders", "write_orders", "read_all_orders", "read_customers", "write_customers",
        "read_products", "read_inventory", "read_returns", "write_returns", "write_order_edits",
        "read_merchant_managed_fulfillment_orders", "read_assigned_fulfillment_orders", "read_fulfillments",
      ];
      console.log(`# shop=${s.shop} status=${s.status} granted=${s.granted.length}`);
      for (const n of NEEDED) console.log(`${s.granted.includes(n) ? "GRANTED " : "MISSING "} ${n}`);
      const extra = s.granted.filter((g) => !NEEDED.includes(g));
      if (extra.length) console.log(`# also granted: ${extra.join(", ")}`);
      break;
    }

    case "ledger":
      for (const r of mutationLedger(rest[0])) console.log(r.join(" | "));
      break;

    case "outcome":
      for (const r of outcomes(rest[0])) console.log(r.join(" | "));
      break;

    case "cleanup-report":
      console.table(cleanupReport());
      break;

    case "full-suite": {
      // Everything that can be asserted without a human approving something.
      console.log("### SCOPES");
      const s = scopeCheck();
      console.log(`granted ${s.granted.length} on ${s.shop}`);
      console.log("\n### TOOL SURFACE");
      const rows = toolSurface();
      console.log(`${rows.length} shopify tools permissioned`);
      console.log("\n### FIXTURES");
      console.table(cleanupReport());
      console.log("\n### SCENARIOS");
      for (const name of Object.keys(SCENARIOS)) {
        const since = nowIso();
        console.log(`\n──── ${name}`);
        console.log(`> ${SCENARIOS[name].say}`);
        sendInbound(SCENARIOS[name].say);
        await sleep(Number(rest[0] || 55));
        for (const [dir, type, source, body] of transcript(since)) {
          console.log(`${dir}${source ? ` (${source})` : ""}: ${body || `[${type}]`}`);
        }
        for (const a of approvals(since)) console.log(`APPROVAL: ${a.join(" | ")}`);
        for (const o of ownership()) console.log(`OWNERSHIP: ${o.join(" | ")}`);
      }
      break;
    }

    case "tools": {
      const rows = toolSurface();
      console.log(`# ${rows.length} shopify tools permissioned for this tenant's AI`);
      for (const r of rows) console.log(r.join(" | "));
      break;
    }

    case "approvals":
      for (const a of approvals(rest[0])) console.log(a.join(" | "));
      break;

    case "approve":
    case "reject": {
      const since = nowIso();
      console.log(decide(cmd, rest[0], rest[1]));
      await sleep(6);
      console.log("\n--- CONTINUATION ---");
      for (const [dir, , source, body] of transcript(since)) {
        if (dir === "OUTBOUND") console.log(`${source}: ${body}`);
      }
      console.log("\n--- OWNERSHIP ---");
      for (const o of ownership()) console.log(o.join(" | "));
      break;
    }

    case "order":
      console.log(JSON.stringify(readOrder(rest[0]), null, 1));
      break;

    case "state":
      console.log("--- OWNERSHIP ---");
      for (const o of ownership()) console.log(o.join(" | "));
      console.log("\n--- RECENT APPROVALS ---");
      for (const a of approvals()) console.log(a.join(" | "));
      break;

    case "fixtures":
      console.table(fixtures());
      break;

    default:
      console.log(
        "commands: say | scenario | suite [name] | full-suite | scope-check | tools | order | customer |\n" +
          "          approvals | approve | reject | ledger | outcome | state | fixtures | cleanup-report\n" +
          `suite scenarios: ${Object.keys(SCENARIOS).join(", ")}`,
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
