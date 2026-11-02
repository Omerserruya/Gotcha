/**
 * What support mode may not do, whatever the role says (Omer, 2026-11-01).
 *
 * A support principal is the tenant's ADMIN, so the route's own permission
 * check passes; this table is the ceiling on top of it, checked once in
 * authenticate() for every service, so no route can forget it.
 *
 * Codes are a contract with the console UI - keep them as they are:
 *   support_denied:billing    any write to billing, checkout or auto-buy
 *   support_denied:delete     deleting conversations, messages or AI employees;
 *                             disconnecting a channel, number, system or Woo
 *                             site; uninstalling a store; erasing a user
 *   support_denied:ownership  removing a user, changing a role, inviting an admin;
 *                             signing a member out (one session or all others),
 *                             removing an MFA device, changing the MFA policy;
 *                             any change to roles, role assignments or grants
 *                             (an invite into a role id is refused at the
 *                             resolved role, auth lib/grant-ceiling);
 *                             a person's own notification settings;
 *                             registering or removing a phone for push (the
 *                             support actor must never receive the
 *                             workspace's pushes, nor drop a member's phone)
 *   support_denied:secrets    rotating credentials
 * Reconnecting a store, and editing or deleting automations and knowledge
 * documents, stay allowed.
 */

export type SupportDenyCode =
  | "support_denied:billing"
  | "support_denied:delete"
  | "support_denied:ownership"
  | "support_denied:secrets";

interface Rule {
  methods: string[] | "WRITE";
  path: RegExp;
  code: SupportDenyCode;
  /** Narrows a rule to a body shape (role changes, admin invites). */
  when?: (body: any) => boolean;
}

const WRITE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ID = "[^/?#]+";

const RULES: Rule[] = [
  { methods: "WRITE", path: /^\/api\/(billing|checkout|auto-buy)(\/|$)/, code: "support_denied:billing" },

  { methods: ["DELETE"], path: new RegExp(`^/api/conversations/${ID}$`), code: "support_denied:delete" },
  { methods: ["DELETE"], path: new RegExp(`^/api/conversations/${ID}/messages/${ID}$`), code: "support_denied:delete" },
  { methods: ["DELETE"], path: new RegExp(`^/api/ai-agents/${ID}$`), code: "support_denied:delete" },
  { methods: ["POST"], path: new RegExp(`^/api/channels/${ID}/disconnect$`), code: "support_denied:delete" },
  { methods: ["DELETE"], path: new RegExp(`^/api/channels/(?!whatsapp/)${ID}$`), code: "support_denied:delete" },
  { methods: ["DELETE"], path: new RegExp(`^/api/channels/whatsapp/numbers/${ID}$`), code: "support_denied:delete" },
  { methods: ["POST"], path: /^\/api\/integrations\/shopify\/uninstall$/, code: "support_denied:delete" },
  { methods: ["POST"], path: new RegExp(`^/api/integrations/${ID}/disconnect$`), code: "support_denied:delete" },
  { methods: ["POST"], path: new RegExp(`^/api/connectors/${ID}/disconnect$`), code: "support_denied:delete" },
  { methods: ["DELETE"], path: new RegExp(`^/api/woocommerce-plugin/sites/${ID}$`), code: "support_denied:delete" },
  { methods: ["DELETE"], path: new RegExp(`^/api/gdpr/users/${ID}$`), code: "support_denied:delete" },

  { methods: ["DELETE"], path: new RegExp(`^/api/agents/(?!presence|settings)${ID}$`), code: "support_denied:ownership" },
  { methods: ["PATCH", "PUT"], path: new RegExp(`^/api/agents/(?!presence|settings)${ID}$`), code: "support_denied:ownership", when: (b) => b && typeof b === "object" && ("role" in b || "isActive" in b) },
  { methods: ["POST"], path: /^\/api\/agents\/?$/, code: "support_denied:ownership", when: (b) => ["ADMIN", "OWNER", "SYSTEM_ADMIN"].includes(String(b?.role ?? "").toUpperCase()) },
  { methods: ["DELETE"], path: new RegExp(`^/api/account/sessions(/${ID})?$`), code: "support_denied:ownership" },
  { methods: ["DELETE"], path: new RegExp(`^/api/account/security/device/${ID}/${ID}$`), code: "support_denied:ownership" },
  { methods: "WRITE", path: /^\/api\/tenant\/security$/, code: "support_denied:ownership" },
  { methods: "WRITE", path: /^\/api\/permissions\/(users|roles)(\/|$)/, code: "support_denied:ownership" },
  // A person's own notification settings (and their WhatsApp number): theirs, not support's (2026-11-02).
  { methods: "WRITE", path: /^\/api\/notification-preferences\/me(\/|$)/, code: "support_denied:ownership" },
  // A person's own phones for push: theirs, not support's (2026-11-03).
  { methods: "WRITE", path: /^\/api\/notifications\/devices(\/|$)/, code: "support_denied:ownership" },

  { methods: ["POST"], path: new RegExp(`^/api/voice-channels/${ID}/rotate-secrets$`), code: "support_denied:secrets" },
];

/** The refusal for this request in support mode, or null when it may run. */
export function supportDenial(method: string, url: string, body?: unknown): SupportDenyCode | null {
  const m = method.toUpperCase();
  const path = url.split("?")[0]!.replace(/\/+$/, "") || "/";
  for (const r of RULES) {
    const methodOk = r.methods === "WRITE" ? WRITE.has(m) : r.methods.includes(m);
    if (!methodOk || !r.path.test(path)) continue;
    if (r.when && !r.when(body)) continue;
    return r.code;
  }
  return null;
}
