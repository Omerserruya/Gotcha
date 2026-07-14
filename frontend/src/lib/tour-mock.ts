// Tour mock mode - demo data for the guided product tour's inbox act.
//
// While the GuidedTour walks a brand-new owner through the inbox, their real
// inbox is empty - there is nothing to show and nothing to click. The tour
// flips a sessionStorage flag before navigating to /conversations; while it
// is on, the api layers (apiFetch in lib/api.ts, authedFetch in lib/api-crm.ts)
// short-circuit the inbox/copilot endpoints below and serve these fixtures
// instead. Every mock id is prefixed "tour-" so nothing here can collide with
// (or mutate) real data - mutating POSTs against tour ids are swallowed with
// a plausible success.
//
// The flag lives in sessionStorage (not localStorage) so an abandoned tour
// can never leak demo data into a future real session.

const FLAG_KEY = "onboarding.tourMock";

export function tourMockActive(): boolean {
  try { return sessionStorage.getItem(FLAG_KEY) === "1"; } catch { return false; }
}

export function setTourMock(on: boolean): void {
  try {
    if (on) sessionStorage.setItem(FLAG_KEY, "1");
    else sessionStorage.removeItem(FLAG_KEY);
  } catch { /* private mode */ }
  // Lets already-mounted components (the conversation list) swap data live.
  try { window.dispatchEvent(new CustomEvent("tour:mock-changed", { detail: { on } })); } catch { /* SSR */ }
}

function isHebrew(): boolean {
  try { return localStorage.getItem("locale") === "he"; } catch { return false; }
}

// ─── Fixtures ───────────────────────────────────────────────

const NOW = () => new Date();
const minsAgo = (m: number) => new Date(NOW().getTime() - m * 60_000).toISOString();

interface MockMsg {
  id: string; direction: "INBOUND" | "OUTBOUND"; body: string;
  createdAt: string; status: string; senderName?: string; messageType?: string;
  metadata?: Record<string, unknown>;
}

function fixtures() {
  const he = isHebrew();
  // One warm, believable storyline: a customer asking about an order - the
  // AI employee answered, a human can take over. Two more rows for depth.
  const c1 = {
    id: "tour-1",
    customerName: he ? "דנה לוי" : "Dana Levi",
    customerPhone: "+972501234567",
    customerExternalId: "+972501234567",
    customerAvatarUrl: null,
    channel: "WHATSAPP",
    status: "OPEN",
    assignedAgentId: null,
    assignedAgent: null,
    assignedAiAgentId: "tour-ai",
    isHandedOver: false,
    handledBy: "ai_agent",
    department: null,
    departmentId: null,
    lastMessageAt: minsAgo(2),
    lastMessageBody: he ? "מעולה, תודה רבה! 🙏" : "Perfect, thank you so much! 🙏",
    lastMessageDirection: "INBOUND",
    createdAt: minsAgo(34),
    closedAt: null,
  };
  const c2 = {
    ...c1,
    id: "tour-2",
    customerName: he ? "יוסי כהן" : "Yossi Cohen",
    customerPhone: "+972529876543",
    customerExternalId: "yossi.cohen",
    channel: "INSTAGRAM",
    lastMessageAt: minsAgo(11),
    lastMessageBody: he ? "יש לכם משלוח עד הבית?" : "Do you deliver to my area?",
    lastMessageDirection: "INBOUND",
    createdAt: minsAgo(48),
  };
  const c3 = {
    ...c1,
    id: "tour-3",
    customerName: he ? "מאיה ברק" : "Maya Barak",
    customerPhone: "+972547654321",
    customerExternalId: "+972547654321",
    channel: "WHATSAPP",
    lastMessageAt: minsAgo(26),
    lastMessageBody: he ? "אשמח לקבוע פגישת ייעוץ" : "I'd love to book a consultation",
    lastMessageDirection: "INBOUND",
    createdAt: minsAgo(52),
  };

  const messages: MockMsg[] = he
    ? [
        { id: "tour-m1", direction: "INBOUND", body: "היי, הזמנתי אצלכם לפני יומיים (#4832) ורציתי לבדוק מתי זה מגיע?", createdAt: minsAgo(34), status: "READ" },
        { id: "tour-m2", direction: "OUTBOUND", body: "היי דנה! בדקתי - הזמנה #4832 יצאה למשלוח הבוקר ותגיע אלייך מחר בין 10:00-14:00. שלחתי לך גם קישור מעקב בהודעה נפרדת.", createdAt: minsAgo(33), status: "READ", senderName: "AI Employee" },
        { id: "tour-m3", direction: "INBOUND", body: "וואו מהיר! אפשר לשנות את הכתובת לרחוב הרצל 12?", createdAt: minsAgo(5), status: "READ" },
        { id: "tour-m4", direction: "OUTBOUND", body: "בטח, עדכנתי את הכתובת להרצל 12. השליח יקבל את העדכון אוטומטית. משהו נוסף?", createdAt: minsAgo(4), status: "READ", senderName: "AI Employee" },
        { id: "tour-m5", direction: "INBOUND", body: "מעולה, תודה רבה! 🙏", createdAt: minsAgo(2), status: "READ" },
      ]
    : [
        { id: "tour-m1", direction: "INBOUND", body: "Hi, I ordered from you two days ago (#4832) - when will it arrive?", createdAt: minsAgo(34), status: "READ" },
        { id: "tour-m2", direction: "OUTBOUND", body: "Hi Dana! I checked - order #4832 shipped this morning and will reach you tomorrow between 10:00-14:00. I've also sent you a tracking link.", createdAt: minsAgo(33), status: "READ", senderName: "AI Employee" },
        { id: "tour-m3", direction: "INBOUND", body: "Wow, that was fast! Can I change the address to 12 Herzl St.?", createdAt: minsAgo(5), status: "READ" },
        { id: "tour-m4", direction: "OUTBOUND", body: "Of course, I've updated the address to 12 Herzl St. The courier gets it automatically. Anything else?", createdAt: minsAgo(4), status: "READ", senderName: "AI Employee" },
        { id: "tour-m5", direction: "INBOUND", body: "Perfect, thank you so much! 🙏", createdAt: minsAgo(2), status: "READ" },
      ];

  const crmContext = {
    vendor: "demo-crm",
    status: "linked",
    contact: {
      id: "tour-crm-1",
      kind: "contact",
      display_name: c1.customerName,
      email: he ? "dana@example.co.il" : "dana@example.com",
      phone: c1.customerPhone,
      owner_id: null,
      stage: he ? "לקוחה חוזרת" : "Returning customer",
      custom_fields: {},
      vendor_updated_at: minsAgo(60),
      fetched_at: minsAgo(1),
    },
    deals: [
      { id: "tour-d1", name: he ? "הזמנה #4832" : "Order #4832", stage: he ? "נשלחה" : "Shipped", amount: 340 },
    ],
    tickets: [],
    open_issues: [],
    recent_activities: [],
    recent_summaries: [],
    recent_crm_notes: [],
    sentiment_trend: ["positive", "positive", "neutral", "positive"],
    active_stage: null,
    candidates: [],
  };

  const suggestions = he
    ? [
        { text: "דנה, רק מוודאת שקיבלת את קישור המעקב - אם משהו לא ברור אני כאן", label: "Reply", type: "reply", confidence: 92, rationale: "הלקוחה סיימה בטון חיובי - סגירה חמה משמרת את החוויה." },
        { text: "להוסיף תזכורת מעקב למחרת המשלוח כדי לוודא שההזמנה הגיעה בשלמותה", label: "Action", type: "action", confidence: 78, rationale: "מעקב יזום אחרי משלוח מעלה שביעות רצון ומקטין פניות חוזרות." },
      ]
    : [
        { text: "Dana, just making sure the tracking link came through - I'm here if anything is unclear", label: "Reply", type: "reply", confidence: 92, rationale: "The customer closed on a positive note - a warm close protects the experience." },
        { text: "Add a follow-up reminder for the day after delivery to confirm the order arrived intact", label: "Action", type: "action", confidence: 78, rationale: "Proactive post-delivery follow-up raises satisfaction and cuts repeat contacts." },
      ];

  const intelligence = {
    detectedIntent: he ? "בירור סטטוס משלוח + עדכון כתובת" : "Delivery status inquiry + address change",
    intentConfidence: 94,
    sentiment: "positive",
    sentimentScore: 0.86,
    customerEffort: "low",
    resolutionOutcome: "resolved",
    toolsUsed: ["order_lookup", "update_shipping_address"],
  };

  const summary = he
    ? "**דנה לוי** שאלה על הזמנה #4832. עובד ה-AI אימת את הסטטוס (יצאה למשלוח, מגיעה מחר 10:00-14:00), שלח קישור מעקב, ועדכן את כתובת המשלוח להרצל 12 לבקשתה. השיחה הסתיימה בטון חיובי - אין צורך בפעולה אנושית."
    : "**Dana Levi** asked about order #4832. The AI employee verified the status (shipped, arriving tomorrow 10:00-14:00), sent a tracking link, and updated the shipping address to 12 Herzl St. at her request. The conversation ended on a positive note - no human action needed.";

  const chatReply = he
    ? "בשמחה! בסיור הזה אני עונה מנתוני דמו - אבל ככה בדיוק אני עוזר לצוות שלך בשיחות אמיתיות: שואלים אותי כל דבר על הלקוח או השיחה ואני עונה מיד."
    : "Happy to! On this tour I'm answering from demo data - but this is exactly how I help your team in real conversations: ask me anything about the customer or the chat and I answer instantly.";

  return { conversations: [c1, c2, c3], messages, crmContext, suggestions, intelligence, summary, chatReply };
}

// ─── Resolver ───────────────────────────────────────────────

/**
 * Returns a mock response body for the given API call while tour mock mode is
 * on, or `undefined` to let the real request through. Callers must treat only
 * `undefined` as "no mock".
 */
export function resolveTourMock(path: string, method: string): unknown | undefined {
  if (typeof window === "undefined" || !tourMockActive()) return undefined;
  const f = fixtures();
  const p = path.split("?")[0];

  // Conversation list - serve the demo rows (any filter combination).
  if (p === "/api/conversations" && method === "GET") {
    return { data: f.conversations, meta: { total: f.conversations.length } };
  }

  // Anything addressing a tour-conversation directly.
  const convMatch = p.match(/^\/api\/conversations\/(tour-[\w-]+)(\/.*)?$/);
  if (convMatch) {
    const [, id, rest] = convMatch;
    const conv = f.conversations.find((c) => c.id === id) || f.conversations[0];
    if (!rest && method === "GET") {
      return { data: { ...conv, messages: id === "tour-1" ? f.messages : f.messages.slice(0, 2) } };
    }
    if (rest === "/messages" && method === "POST") {
      // Echo the send so the composer clears and the bubble appears.
      return {
        data: {
          id: `tour-sent-${Math.floor(Math.random() * 1e6)}`,
          direction: "OUTBOUND", body: "", status: "SENT",
          createdAt: new Date().toISOString(),
        },
      };
    }
    // claim / close / return-to-ai / release etc. - plausible success, no side effects.
    return { data: { ...conv } };
  }

  // CRM context panel (api-crm.ts authedFetch).
  if (/^\/api\/crm\/conversation\/tour-[\w-]+\/context$/.test(p)) {
    return { data: f.crmContext };
  }

  // Copilot endpoints.
  const aiMatch = p.match(/^\/api\/ai-assist\/tour-[\w-]+\/(suggestions|intelligence|summary|chat)$/);
  if (aiMatch) {
    switch (aiMatch[1]) {
      case "suggestions": return { data: f.suggestions, copilotMode: "SUGGEST" };
      case "intelligence": return { data: f.intelligence };
      case "summary": return { data: { summary: f.summary } };
      case "chat": return { data: { reply: f.chatReply } };
    }
  }
  // Any other copilot call against a tour conversation (e.g. executing an
  // "action" suggestion) - swallow with a benign success so a fake id never
  // reaches the real API.
  if (p.startsWith("/api/ai-assist/tour-")) return { data: {} };

  return undefined;
}
