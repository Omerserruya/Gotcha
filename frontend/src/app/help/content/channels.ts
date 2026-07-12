import type { HelpCategory } from "./types";

export const channels: HelpCategory = {
  slug: "channels",
  icon: "chat",
  title: ["Channels", "ערוצים"],
  desc: ["Connect WhatsApp Business (WABA), Instagram, Messenger and email.", "חיבור וואטסאפ ביזנס (WABA), אינסטגרם, מסנג'ר ואימייל."],
  articles: [
    {
      slug: "connect-whatsapp-waba",
      popular: true,
      title: ["Connect WhatsApp Business (WABA): the complete guide", "חיבור וואטסאפ ביזנס (WABA): המדריך המלא"],
      excerpt: [
        "Everything from preparing your phone number and Meta Business account to the in-app signup popup — plus troubleshooting.",
        "הכול — מהכנת מספר הטלפון וחשבון Meta Business ועד חלון ההרשמה באפליקציה — כולל פתרון תקלות.",
      ],
      keywords: ["whatsapp", "waba", "וואטסאפ", "ווטסאפ", "meta", "business", "embedded signup", "phone number", "מספר", "חיבור"],
      body: [
        `GOTCHA connects to the official **WhatsApp Business Platform (Cloud API)** through Meta. The whole flow happens in a guided Meta popup — no developer work — but the preparation matters, so read this once before you start.

## Before you start — the three prerequisites

**1. A Meta Business Portfolio (Business Manager).**
You need admin access to your company's Meta Business account (business.facebook.com). If you don't have one, the signup popup will create it for you.

**2. A phone number for the API.**
This is the number your customers will message. Important rules:

- The number **cannot be actively registered in the WhatsApp or WhatsApp Business *app*** at the same time. If it currently runs in the app, you must delete the WhatsApp account on that number first (WhatsApp app → Settings → Account → Delete account). Chat history won't transfer — back it up first if you need it.
- It must be able to receive an **SMS or voice call** once, for verification.
- A landline works (choose voice verification).
- Recommended: use a dedicated number, so your personal/app usage is never in conflict.

**3. A verified business (recommended).**
Meta Business Verification (uploading business documents at business.facebook.com → Security Center) unlocks higher messaging limits and the display-name approval. You can connect without it, but limits start low.

## Connecting in GOTCHA

1. In the app, open **Channels** from the sidebar.
2. On the WhatsApp card, click **Connect**.
3. A Meta popup opens (allow popups if blocked). Sign in with a Facebook account that has admin access to your business.
4. Follow the wizard: pick or create your **Business Portfolio** → pick or create your **WhatsApp Business Account (WABA)** → add your **phone number** and verify it with the SMS/voice code → set your **display name** (your brand name — Meta reviews it).
5. Finish. GOTCHA receives the connection automatically and the WhatsApp card turns **Connected**. Incoming messages now land in your inbox and your AI employee starts answering.

## Good to know after connecting

- **Messaging window:** customers can always message you. You can reply freely within **24 hours** of their last message; outside that window Meta requires a pre-approved **template message**.
- **Messaging limits & quality:** new numbers start with a daily limit on business-initiated conversations (typically 250, then 1K/10K/100K as quality holds). Replying inside the 24-hour window is not limited.
- **Display name review:** Meta may take a few hours to approve your name; messaging usually works meanwhile.
- **The green checkmark** (Official Business Account) is a separate Meta application — verification plus brand presence; not required.

## Troubleshooting

- **Popup closes / nothing happens** — your browser blocked the popup. Allow popups for the app and retry.
- **"Number already in use"** — the number is still registered in a WhatsApp app or another WABA. Delete the app account (see above) or release it from the other WABA, wait a few minutes, retry.
- **Verification code never arrives** — try voice-call verification; make sure the number can receive international SMS.
- **Two-step PIN requested** — the number had WhatsApp two-step verification enabled. Use that PIN, or follow Meta's PIN-reset flow.
- Still stuck? [Contact us](/help#contact) — we do this daily.`,
        `GOTCHA מתחברת ל**פלטפורמת WhatsApp Business הרשמית (Cloud API)** דרך Meta. כל התהליך קורה בחלון מודרך של Meta — בלי עבודת פיתוח — אבל ההכנה חשובה, אז קראו את זה פעם אחת לפני שמתחילים.

## לפני שמתחילים — שלושת התנאים

**1. תיק עסקי ב-Meta (Business Manager).**
צריך גישת אדמין לחשבון Meta Business של החברה (business.facebook.com). אם אין לכם — החלון ייצור אחד עבורכם.

**2. מספר טלפון עבור ה-API.**
זה המספר שאליו הלקוחות יכתבו. כללים חשובים:

- המספר **לא יכול להיות רשום במקביל באפליקציית וואטסאפ / וואטסאפ ביזנס**. אם הוא פעיל באפליקציה — צריך קודם למחוק את חשבון הוואטסאפ על המספר (אפליקציה → הגדרות → חשבון → מחיקת חשבון). היסטוריית הצ'אטים לא עוברת — גבו אותה קודם אם צריך.
- הוא חייב לקבל **SMS או שיחה קולית** פעם אחת, לאימות.
- גם קו נייח עובד (בחרו אימות קולי).
- מומלץ: מספר ייעודי, כדי ששימוש אישי/באפליקציה לעולם לא יתנגש.

**3. עסק מאומת (מומלץ).**
אימות עסקי ב-Meta (העלאת מסמכים ב-business.facebook.com → Security Center) פותח מגבלות שליחה גבוהות ואישור שם תצוגה. אפשר להתחבר גם בלי — אבל המגבלות מתחילות נמוך.

## החיבור ב-GOTCHA

1. באפליקציה, פתחו **ערוצים** מהתפריט.
2. בכרטיס וואטסאפ לחצו **התחברות**.
3. נפתח חלון של Meta (אשרו חלונות קופצים אם נחסם). התחברו עם חשבון פייסבוק שיש לו הרשאות אדמין על העסק.
4. עקבו אחרי האשף: בחרו/צרו **תיק עסקי** ← בחרו/צרו **חשבון WhatsApp Business‏ (WABA)** ← הוסיפו את **מספר הטלפון** ואמתו בקוד SMS/שיחה ← הגדירו **שם תצוגה** (שם המותג — עובר בדיקת Meta).
5. סיימו. GOTCHA מקבלת את החיבור אוטומטית וכרטיס הוואטסאפ הופך **מחובר**. הודעות נכנסות מגיעות לתיבה ועובד ה-AI מתחיל לענות.

## טוב לדעת אחרי החיבור

- **חלון ההודעות:** לקוחות תמיד יכולים לכתוב לכם. אתם עונים חופשי בתוך **24 שעות** מההודעה האחרונה שלהם; מעבר לחלון Meta דורשת **הודעת תבנית** מאושרת מראש.
- **מגבלות ואיכות:** מספרים חדשים מתחילים עם מגבלה יומית על שיחות שהעסק יוזם (בד"כ 250, ואז 1K/10K/100K ככל שהאיכות נשמרת). מענה בתוך חלון ה-24 שעות אינו מוגבל.
- **בדיקת שם תצוגה:** אישור השם עשוי לקחת כמה שעות; ההודעות בדרך כלל עובדות בינתיים.
- **הוי הירוק** (חשבון עסקי רשמי) הוא בקשה נפרדת ל-Meta — אימות + נוכחות מותג; לא חובה.

## פתרון תקלות

- **החלון נסגר / כלום לא קורה** — הדפדפן חסם את החלון הקופץ. אשרו חלונות קופצים ונסו שוב.
- **"המספר כבר בשימוש"** — המספר עדיין רשום באפליקציה או ב-WABA אחר. מחקו את חשבון האפליקציה (ראו למעלה) או שחררו מה-WABA האחר, המתינו כמה דקות ונסו שוב.
- **קוד האימות לא מגיע** — נסו אימות בשיחה קולית; ודאו שהמספר מקבל SMS בינלאומי.
- **נדרש PIN דו-שלבי** — למספר הופעל אימות דו-שלבי בוואטסאפ. השתמשו ב-PIN, או עברו את תהליך האיפוס של Meta.
- עדיין תקועים? [דברו איתנו](/help#contact) — אנחנו עושים את זה כל יום.`,
      ],
    },
    {
      slug: "connect-instagram",
      title: ["Connect Instagram", "חיבור אינסטגרם"],
      excerpt: [
        "Bring Instagram DMs into your inbox — requires a professional (business/creator) account.",
        "הכניסו הודעות אינסטגרם לתיבה — נדרש חשבון מקצועי (עסקי/יוצר).",
      ],
      keywords: ["instagram", "אינסטגרם", "dm", "direct", "ig"],
      body: [
        `## Requirements

- An Instagram **professional account** (Business or Creator — switch in the Instagram app under Settings → Account type).
- In the Instagram app: **Settings → Messages → Allow access to messages** must be on, so connected tools can read and reply to DMs.

## Connecting

1. Open **Channels** in the sidebar.
2. On the Instagram card, click **Connect**.
3. Sign in with your **Instagram** account in the popup and approve the permissions.
4. The card turns **Connected** — DMs now flow into your inbox and your AI employee answers them like any other channel.

## Notes

- Story replies and DMs arrive as regular conversations.
- If you see *"no Instagram account"*, the account you signed in with isn't a professional account — switch it and retry.`,
        `## דרישות

- חשבון אינסטגרם **מקצועי** (עסקי או יוצר — מחליפים באפליקציה תחת הגדרות → סוג חשבון).
- באפליקציית אינסטגרם: **הגדרות → הודעות → אפשר גישה להודעות** חייב להיות פעיל, כדי שכלים מחוברים יוכלו לקרוא ולענות.

## החיבור

1. פתחו **ערוצים** בתפריט.
2. בכרטיס אינסטגרם לחצו **התחברות**.
3. התחברו עם חשבון ה**אינסטגרם** בחלון ואשרו הרשאות.
4. הכרטיס הופך **מחובר** — הודעות נכנסות לתיבה ועובד ה-AI עונה כמו בכל ערוץ.

## הערות

- תגובות לסטורי והודעות ישירות מגיעות כשיחות רגילות.
- אם מופיע *"אין חשבון אינסטגרם"* — החשבון שהתחברתם איתו אינו מקצועי. החליפו סוג חשבון ונסו שוב.`,
      ],
    },
    {
      slug: "connect-messenger",
      title: ["Connect Facebook Messenger", "חיבור פייסבוק מסנג'ר"],
      excerpt: ["Answer your Facebook Page's messages from the shared inbox.", "ענו להודעות של עמוד הפייסבוק מהתיבה המשותפת."],
      keywords: ["messenger", "facebook", "מסנג'ר", "פייסבוק", "page"],
      body: [
        `## Requirements

A Facebook **Page** for your business, and a Facebook user with **admin access** to that Page.

## Connecting

1. Open **Channels** → Messenger card → **Connect**.
2. Sign in with Facebook, pick the Page, and approve messaging permissions.
3. Done — Page messages land in the inbox, and your AI employee answers within Facebook's messaging window.

## Notes

- Comments on posts are separate from Messenger; this connects **direct messages**.
- Like WhatsApp, Meta applies a 24-hour reply window for business-initiated content.`,
        `## דרישות

**עמוד** פייסבוק לעסק, ומשתמש פייסבוק עם **הרשאות אדמין** לעמוד.

## החיבור

1. פתחו **ערוצים** ← כרטיס מסנג'ר ← **התחברות**.
2. התחברו עם פייסבוק, בחרו את העמוד ואשרו הרשאות הודעות.
3. סיימתם — הודעות העמוד נכנסות לתיבה, ועובד ה-AI עונה בתוך חלון ההודעות של פייסבוק.

## הערות

- תגובות לפוסטים נפרדות מהמסנג'ר; החיבור הזה הוא ל**הודעות ישירות**.
- כמו בוואטסאפ, Meta מחילה חלון מענה של 24 שעות על תוכן שהעסק יוזם.`,
      ],
    },
    {
      slug: "connect-email",
      title: ["Connect email", "חיבור אימייל"],
      excerpt: ["Gmail/Outlook in one click, or any mailbox via SMTP/IMAP.", "Gmail/Outlook בלחיצה, או כל תיבה דרך SMTP/IMAP."],
      keywords: ["email", "gmail", "outlook", "smtp", "imap", "אימייל", "מייל"],
      body: [
        `## Gmail / Outlook (recommended)

1. **Channels** → Email → choose **Gmail** or **Outlook**.
2. Sign in and approve — that's it. Incoming mail becomes conversations; replies are sent from your address.

## Any other mailbox (SMTP/IMAP)

Choose the manual option and fill in:

- **Email address & display name** — what customers see.
- **SMTP host, port, user, password** — for sending (from your email provider's docs; port 587 is typical).
- **IMAP host & port** (optional) — for receiving into the inbox.

> **Tip:** with Google Workspace/Gmail via SMTP, use an **App Password** (Google Account → Security → 2-Step Verification → App passwords), not your regular password.`,
        `## Gmail / Outlook (מומלץ)

1. **ערוצים** ← אימייל ← בחרו **Gmail** או **Outlook**.
2. התחברו ואשרו — זהו. מיילים נכנסים הופכים לשיחות; תשובות נשלחות מהכתובת שלכם.

## כל תיבה אחרת (SMTP/IMAP)

בחרו באפשרות הידנית ומלאו:

- **כתובת אימייל ושם תצוגה** — מה שהלקוחות רואים.
- **שרת SMTP, פורט, משתמש, סיסמה** — לשליחה (מתיעוד ספק המייל; פורט 587 נפוץ).
- **שרת IMAP ופורט** (אופציונלי) — לקבלה אל התיבה.

> **טיפ:** ב-Gmail/Google Workspace דרך SMTP השתמשו ב**סיסמת אפליקציה** (חשבון Google ← אבטחה ← אימות דו-שלבי ← סיסמאות אפליקציה), לא בסיסמה הרגילה.`,
      ],
    },
  ],
};
