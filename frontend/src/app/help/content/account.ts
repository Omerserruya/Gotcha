import type { HelpCategory, HelpFaq } from "./types";

export const account: HelpCategory = {
  slug: "account",
  icon: "users",
  title: ["Team & account", "צוות וחשבון"],
  desc: ["Invite teammates, roles and departments, and how your data is protected.", "הזמנת חברי צוות, תפקידים ומחלקות, ואיך המידע שלכם מוגן."],
  articles: [
    {
      slug: "invite-team",
      popular: true,
      title: ["Inviting your team & roles", "הזמנת הצוות ותפקידים"],
      excerpt: ["Add agents and admins, what each role can do, and invite links.", "הוספת נציגים ומנהלים, מה כל תפקיד יכול, וקישורי הזמנה."],
      keywords: ["invite", "team", "roles", "agent", "admin", "הזמנה", "צוות", "תפקידים", "נציג"],
      body: [
        `## Roles

- **Admin** - full workspace control: settings, integrations, billing, AI configuration, all conversations.
- **Agent** - works the inbox: sees and answers conversations, takes over from the AI.
- **Department manager** - an agent with team-level views (like conversation history) for their department.

## Inviting

**Settings → Users → Invite**: enter the teammate's email and they receive an invite that drops them straight into the workspace (valid 48 hours). You can also create a shareable **invite link** for onboarding several people at once.

## Managing

Deactivate a user any time - access ends immediately; their conversation history stays. Roles can be changed after joining.

> Seats are part of your plan; if you're growing past it, upgrading takes effect immediately.`,
        `## תפקידים

- **מנהל (Admin)** - שליטה מלאה: הגדרות, אינטגרציות, חיוב, תצורת AI, כל השיחות.
- **נציג (Agent)** - עובד בתיבה: רואה ועונה לשיחות, משתלט מה-AI.
- **מנהל מחלקה** - נציג עם תצוגות צוותיות (כמו היסטוריית שיחות) למחלקה שלו.

## הזמנה

**הגדרות → משתמשים → הזמנה**: מזינים אימייל והעמית מקבל הזמנה שמכניסה אותו ישר לסביבה (תקפה 48 שעות). אפשר גם ליצור **קישור הזמנה** משותף לקליטת כמה אנשים בבת אחת.

## ניהול

אפשר להשבית משתמש בכל רגע - הגישה נחסמת מיד; היסטוריית השיחות נשארת. תפקידים ניתנים לשינוי אחרי ההצטרפות.

> מקומות הצוות הם חלק מהתוכנית; אם גדלתם מעבר - שדרוג נכנס לתוקף מיד.`,
      ],
    },
    {
      slug: "security-privacy",
      title: ["Security & your data", "אבטחה והמידע שלכם"],
      excerpt: ["Isolation, access control, and what the AI does (and doesn't do) with your data.", "בידוד, בקרת גישה, ומה ה-AI עושה (ולא עושה) עם המידע."],
      keywords: ["security", "privacy", "data", "אבטחה", "פרטיות", "מידע", "gdpr"],
      body: [
        `## Workspace isolation

Every workspace (tenant) is fully isolated: your conversations, customers, knowledge and configuration are scoped to your workspace only, enforced at every layer of the platform.

## Access control

- Role-based access: admins configure, agents work the inbox.
- Sessions expire after 24 hours and refresh only while in use; magic links are single-use and short-lived.
- Sensitive AI actions require explicit human approval (see [Approvals](/help/ai-employees/approvals-handoff)).

## Your data and AI

- Your knowledge and conversations are used to **answer your customers** - that's it.
- Your data is **not used to train** foundation models.
- Every AI action is logged - what it did, why, and with which data - for full auditability.

## Channel credentials

Connections to Meta, Google, your CRM and your store use each provider's official OAuth; GOTCHA never sees your passwords. Payment card details are held by the payment provider, never on GOTCHA servers.

Questions about a DPA or specific compliance needs? [Contact us](/help#contact).`,
        `## בידוד סביבות

כל סביבת עבודה (tenant) מבודדת לחלוטין: השיחות, הלקוחות, הידע והתצורה תחומים לסביבה שלכם בלבד, ונאכפים בכל שכבת הפלטפורמה.

## בקרת גישה

- גישה מבוססת תפקידים: מנהלים מגדירים, נציגים עובדים בתיבה.
- חיבורים פגים אחרי 24 שעות ומתחדשים רק בשימוש; קישורים קסומים חד-פעמיים וקצרי-חיים.
- פעולות AI רגישות דורשות אישור אנושי מפורש (ראו [אישורים](/help/ai-employees/approvals-handoff)).

## המידע שלכם וה-AI

- הידע והשיחות משמשים **למענה ללקוחות שלכם** - וזהו.
- המידע שלכם **לא משמש לאימון** מודלים.
- כל פעולת AI מתועדת - מה נעשה, למה, ועם איזה מידע - לביקורת מלאה.

## הרשאות ערוצים

חיבורים ל-Meta, Google, ה-CRM והחנות משתמשים ב-OAuth הרשמי של כל ספק; GOTCHA לעולם לא רואה סיסמאות. פרטי כרטיסי אשראי נשמרים אצל ספק הסליקה, לעולם לא בשרתי GOTCHA.

שאלות על DPA או דרישות רגולציה? [דברו איתנו](/help#contact).`,
      ],
    },
  ],
};

export const faqs: HelpFaq[] = [
  {
    q: ["Can I keep using WhatsApp on my phone with the same number?", "אפשר להמשיך להשתמש בוואטסאפ בטלפון עם אותו מספר?"],
    a: [
      "No - a number connected to the WhatsApp Business Platform (API) can't run in the WhatsApp app at the same time. Most businesses dedicate a number to GOTCHA. See the [WhatsApp guide](/help/channels/connect-whatsapp-waba).",
      "לא - מספר שמחובר לפלטפורמת WhatsApp Business‏ (API) לא יכול לפעול במקביל באפליקציה. רוב העסקים מייעדים מספר ל-GOTCHA. ראו את [מדריך הוואטסאפ](/help/channels/connect-whatsapp-waba).",
    ],
  },
  {
    q: ["Does the AI speak Hebrew?", "ה-AI מדבר עברית?"],
    a: [
      "Yes - fluently, including your brand voice. It mirrors the customer's language automatically, so Hebrew customers get Hebrew and English customers get English.",
      "כן - באופן שוטף, כולל קול המותג שלכם. הוא משקף את שפת הלקוח אוטומטית: לקוח בעברית מקבל עברית, לקוח באנגלית מקבל אנגלית.",
    ],
  },
  {
    q: ["What happens when the AI doesn't know an answer?", "מה קורה כשה-AI לא יודע תשובה?"],
    a: [
      "It says so honestly, and hands the conversation to your team with full context. It never invents facts. Teach it the answer once and it knows it forever.",
      "הוא אומר זאת בכנות ומעביר את השיחה לצוות עם הקשר מלא. הוא לעולם לא ממציא עובדות. למדו אותו את התשובה פעם אחת - והוא יודע אותה לתמיד.",
    ],
  },
  {
    q: ["How long does setup take?", "כמה זמן לוקחת ההגדרה?"],
    a: [
      "About 10 minutes. The website investigation runs in under a minute; the rest is you reviewing what it learned, connecting a system, and tuning your employee.",
      "בערך 10 דקות. חקירת האתר רצה בפחות מדקה; השאר הוא סקירת מה שנלמד, חיבור מערכת וכוונון העובד.",
    ],
  },
  {
    q: ["Can I take over a conversation from the AI?", "אפשר להשתלט על שיחה מה-AI?"],
    a: [
      "Always. Start typing in any conversation and the AI steps back. It also proactively hands over when the customer asks for a human or when it's unsure.",
      "תמיד. מתחילים להקליד בכל שיחה וה-AI זז הצידה. הוא גם מעביר יזומות כשהלקוח מבקש אדם או כשהוא לא בטוח.",
    ],
  },
  {
    q: ["Do my purchased credits expire?", "קרדיטים שרכשתי פגים?"],
    a: [
      "No. Purchased credits never expire. Only the monthly *included* allowance resets each billing period.",
      "לא. קרדיטים נרכשים לא פגים לעולם. רק ההקצאה החודשית ה*כלולה* מתאפסת כל תקופת חיוב.",
    ],
  },
  {
    q: ["Can I edit what the AI learned about my business?", "אפשר לערוך את מה שה-AI למד על העסק?"],
    a: [
      "Yes - everything. During setup press \"Something off?\" on the review screen, and any time later on **Your Business** in the sidebar. Corrections stick: the AI never resurfaces something you removed.",
      "כן - הכול. בהגדרה לחצו \"משהו לא מדויק?\" במסך הסקירה, ובכל שלב אחר תחת **העסק שלכם** בתפריט. תיקונים נשמרים: ה-AI לא מעלה שוב משהו שהסרתם.",
    ],
  },
  {
    q: ["Is my data used to train AI models?", "המידע שלי משמש לאימון מודלים?"],
    a: [
      "No. Your knowledge and conversations serve your customers only, and every AI action is logged for audit.",
      "לא. הידע והשיחות משרתים רק את הלקוחות שלכם, וכל פעולת AI מתועדת לביקורת.",
    ],
  },
  {
    q: ["Can I try GOTCHA before paying?", "אפשר לנסות את GOTCHA לפני תשלום?"],
    a: [
      "Yes - we set up free pilot workspaces (no credit card) with a real credit budget and the features you need. [Contact us](/help#contact) to arrange one.",
      "כן - אנחנו מקימים סביבות פיילוט חינמיות (בלי כרטיס אשראי) עם תקציב קרדיטים אמיתי והפיצ'רים שצריך. [דברו איתנו](/help#contact) לתיאום.",
    ],
  },
  {
    q: ["Which channels are supported?", "אילו ערוצים נתמכים?"],
    a: [
      "WhatsApp Business (API), Instagram DM, Facebook Messenger and email (Gmail, Outlook, or any SMTP/IMAP mailbox) - all in one shared inbox.",
      "וואטסאפ ביזנס (API), הודעות אינסטגרם, פייסבוק מסנג'ר ואימייל (Gmail, Outlook או כל תיבת SMTP/IMAP) - הכול בתיבה משותפת אחת.",
    ],
  },
  {
    q: ["How do I contact GOTCHA support?", "איך יוצרים קשר עם התמיכה של GOTCHA?"],
    a: [
      "Email **support@gotcha.co.il** - a real human reads every message. Setup emails can also simply be replied to.",
      "כתבו ל-**support@gotcha.co.il** - בן אדם אמיתי קורא כל הודעה. אפשר גם פשוט להשיב למיילים של ההגדרה.",
    ],
  },
];
