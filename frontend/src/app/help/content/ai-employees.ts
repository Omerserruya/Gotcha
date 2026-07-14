import type { HelpCategory } from "./types";

export const aiEmployees: HelpCategory = {
  slug: "ai-employees",
  icon: "bot",
  title: ["AI employees", "עובדי AI"],
  desc: ["What they can do, how to tune them, and how approvals & handoff work.", "מה הם יודעים לעשות, איך מכווננים אותם, ואיך עובדים אישורים והעברה לאדם."],
  articles: [
    {
      slug: "what-they-do",
      popular: true,
      title: ["What can an AI employee actually do?", "מה עובד AI באמת יודע לעשות?"],
      excerpt: [
        "Answering, acting in your systems, escalating - and the honesty rules it always follows.",
        "לענות, לפעול במערכות שלכם, להסלים - וכללי הכנות שהוא תמיד מקיים.",
      ],
      keywords: ["capabilities", "actions", "tools", "יכולות", "פעולות", "bot"],
      body: [
        `## Conversation

- Answers customer questions from your taught knowledge - policies, products, FAQ - in your brand voice, Hebrew or English (it mirrors the customer's language).
- Handles the full conversation: greeting, clarifying, resolving, closing.
- Never invents specifics. If a customer asks for something it doesn't know (a delivery date, a price it wasn't taught), it says so and brings in your team.

## Actions in your systems

When you've connected a source of truth, the employee can:

- **Recognize customers** - look them up in HubSpot / Salesforce / Zoho / Fireberry / Airtable and use their history.
- **Answer "where's my order?"** - look up orders in Shopify.
- **Create and update leads/contacts** - new customers get captured into your CRM automatically.
- **Book, reschedule and cancel meetings** on your calendar, checking real availability first.

## Judgment

- **Approvals:** financial or irreversible actions (refund commitments, discounts, long meetings) are proposed to you first - see [Approvals & human handoff](/help/ai-employees/approvals-handoff).
- **Escalation:** when the customer is upset, asks for a human, or the AI is out of its depth, it hands over gracefully and tells the customer what's happening.
- **Honest status:** it reports what actually happened - done, waiting for approval, or failed - never a false "done".`,
        `## שיחה

- עונה לשאלות לקוחות מתוך הידע שלימדתם - מדיניות, מוצרים, שאלות נפוצות - בקול המותג שלכם, בעברית או באנגלית (הוא משקף את שפת הלקוח).
- מנהל שיחה שלמה: פתיחה, בירור, פתרון, סגירה.
- לא ממציא פרטים. אם לקוח שואל משהו שהוא לא יודע (מועד משלוח, מחיר שלא לימדו אותו) - הוא אומר זאת ומצרף את הצוות.

## פעולות במערכות שלכם

כשמחובר מקור אמת, העובד יכול:

- **לזהות לקוחות** - לאתר אותם ב-HubSpot / Salesforce / Zoho / Fireberry / Airtable ולהשתמש בהיסטוריה.
- **לענות על "איפה ההזמנה שלי?"** - לאתר הזמנות ב-Shopify.
- **ליצור ולעדכן לידים/אנשי קשר** - לקוחות חדשים נקלטים ל-CRM אוטומטית.
- **לקבוע, להזיז ולבטל פגישות** ביומן, אחרי בדיקת זמינות אמיתית.

## שיקול דעת

- **אישורים:** פעולות כספיות או בלתי הפיכות (התחייבות להחזר, הנחות, פגישות ארוכות) מוצעות לכם קודם - ראו [אישורים והעברה לאדם](/help/ai-employees/approvals-handoff).
- **הסלמה:** כשהלקוח מתוסכל, מבקש אדם, או שה-AI מחוץ לתחום שלו - הוא מעביר בעדינות ומעדכן את הלקוח מה קורה.
- **סטטוס כן:** הוא מדווח מה באמת קרה - בוצע, ממתין לאישור, או נכשל - לעולם לא "בוצע" כוזב.`,
      ],
    },
    {
      slug: "tune-your-employee",
      title: ["Tuning your employee's personality & behavior", "כוונון האישיות וההתנהגות של העובד"],
      excerpt: [
        "Chat-to-tune before deploy, ongoing corrections, brand voice and forbidden words.",
        "כוונון בשיחה לפני הפריסה, תיקונים שוטפים, קול מותג ומילים אסורות.",
      ],
      keywords: ["tune", "persona", "tone", "כוונון", "טון", "אישיות", "brand voice", "קול מותג"],
      body: [
        `## During setup: chat-to-tune

Before your employee goes live you chat with it. Say things like *"be friendlier"*, *"be more concise"*, *"always offer our WhatsApp for follow-up"* - each instruction is remembered and applied when it's deployed. The conversation survives page reloads, so tune at your own pace.

## Its voice comes from your business

The employee is compiled from the living business profile GOTCHA built: your **brand voice** (tone, personality, preferred words), your **forbidden words**, your positioning and your languages. Fix the profile at **Your Business** and the changes carry into how the employee speaks.

## Ongoing corrections

- On **Your Business**, correct any wrong finding (a channel that isn't yours, a tool you don't use) - the AI learns immediately and never resurfaces it.
- Teach missing knowledge any time (URL, text, files, Drive) - see the [Knowledge](/help/knowledge/teach-from-website) guides.
- Watch a few real conversations in the inbox during the first days; when an answer isn't how you'd say it, teach the better answer as knowledge.`,
        `## בהגדרה: כוונון בשיחה

לפני שהעובד עולה לאוויר אתם משוחחים איתו. אמרו דברים כמו *"תהיה ידידותי יותר"*, *"תמציתי יותר"*, *"תמיד תציע את הוואטסאפ שלנו להמשך"* - כל הנחיה נזכרת ומוחלת בפריסה. השיחה שורדת רענון עמוד, אז כווננו בקצב שלכם.

## הקול שלו מגיע מהעסק שלכם

העובד מורכב מהפרופיל העסקי החי ש-GOTCHA בנתה: **קול המותג** (טון, אישיות, מילים מועדפות), **מילים אסורות**, מיצוב ושפות. תקנו את הפרופיל תחת **העסק שלכם** - והשינויים עוברים לאופן שבו העובד מדבר.

## תיקונים שוטפים

- ב**העסק שלכם** תקנו כל ממצא שגוי (ערוץ שאינו שלכם, כלי שאינכם משתמשים בו) - ה-AI לומד מיד ולא מעלה זאת שוב.
- למדו ידע חסר בכל עת (קישור, טקסט, קבצים, Drive) - ראו מדריכי [ידע](/help/knowledge/teach-from-website).
- צפו בכמה שיחות אמיתיות בתיבה בימים הראשונים; כשתשובה אינה כפי שהייתם מנסחים - למדו את התשובה הטובה כידע.`,
      ],
    },
    {
      slug: "approvals-handoff",
      title: ["Approvals & human handoff", "אישורים והעברה לאדם"],
      excerpt: [
        "What waits for your approval, how escalation works, and how to take over a conversation.",
        "מה ממתין לאישורכם, איך עובדת הסלמה, ואיך משתלטים על שיחה.",
      ],
      keywords: ["approvals", "hitl", "escalation", "אישורים", "הסלמה", "human", "takeover", "השתלטות"],
      body: [
        `## The approval queue

Actions with real-world consequences don't just happen. The AI **proposes**, you **approve**:

- Refunds, discounts and anything financial.
- Irreversible or outward-facing actions.
- Meeting bookings above your configured threshold.

Open **Approvals** in the sidebar to see pending items with the AI's reasoning; approve or reject in one click. The customer is told their request is being handled - never left hanging.

## When the AI hands off

The employee escalates to your team when:

- the customer **asks for a human**,
- frustration is detected,
- it can't answer confidently after clarifying,
- an action it needs isn't available.

Escalated conversations are flagged in the inbox for your agents, with full context - no "please repeat your issue".

## Taking over manually

Any agent can jump into any conversation at any time - just start typing in the inbox. The AI steps back for that conversation and won't fight you for the keyboard.`,
        `## תור האישורים

פעולות עם השלכות אמיתיות לא פשוט קורות. ה-AI **מציע**, אתם **מאשרים**:

- החזרים, הנחות וכל דבר כספי.
- פעולות בלתי הפיכות או יוצאות-החוצה.
- קביעת פגישות מעל הסף שהגדרתם.

פתחו **אישורים** בתפריט כדי לראות פריטים ממתינים עם הנימוק של ה-AI; אשרו או דחו בלחיצה. הלקוח מקבל עדכון שהבקשה בטיפול - לעולם לא נשאר באוויר.

## מתי ה-AI מעביר לאדם

העובד מסלים לצוות כאשר:

- הלקוח **מבקש אדם**,
- מזוהה תסכול,
- הוא לא מצליח לענות בביטחון אחרי בירור,
- פעולה שנדרשת לו אינה זמינה.

שיחות מוסלמות מסומנות בתיבה לנציגים, עם הקשר מלא - בלי "נא לחזור על הבעיה".

## השתלטות ידנית

כל נציג יכול להיכנס לכל שיחה בכל רגע - פשוט מתחילים להקליד בתיבה. ה-AI זז הצידה בשיחה הזו ולא נאבק אתכם על המקלדת.`,
      ],
    },
  ],
};
