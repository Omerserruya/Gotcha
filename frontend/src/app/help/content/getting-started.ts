import type { HelpCategory } from "./types";

export const gettingStarted: HelpCategory = {
  slug: "getting-started",
  icon: "rocket",
  title: ["Getting started", "מתחילים"],
  desc: ["What GOTCHA is, your first setup, and your first day.", "מה זה GOTCHA, ההגדרה הראשונה והיום הראשון שלכם."],
  articles: [
    {
      slug: "what-is-gotcha",
      popular: true,
      title: ["What is GOTCHA?", "מה זה GOTCHA?"],
      excerpt: [
        "AI employees that work your customer conversations - across WhatsApp, Instagram, Messenger and email - from one inbox.",
        "עובדי AI שעובדים בשיחות הלקוחות שלכם - בוואטסאפ, אינסטגרם, מסנג'ר ואימייל - מתוך תיבה אחת.",
      ],
      keywords: ["about", "intro", "overview", "מה זה", "היכרות", "ai employee", "עובד"],
      body: [
        `GOTCHA is the **next generation of customer engagement**: every channel your customers use, one intelligent inbox, and **AI employees** - not chatbots with canned replies, but teammates that learn your business and handle real customer conversations.

## What an AI employee does

- **Answers customers** on WhatsApp, Instagram, Facebook Messenger and email - in your brand voice, in Hebrew or English.
- **Knows your business**: your products, policies (shipping, returns, refunds), FAQ and any knowledge you teach it.
- **Uses your systems**: it can look up a customer in your CRM (HubSpot, Salesforce, Zoho, Fireberry, Airtable) or an order in Shopify, book meetings, and update records.
- **Knows when to stop**: anything sensitive - refunds, discounts, irreversible actions - waits for a human's approval, and it hands the conversation to your team the moment it's unsure.

## How it learns your business

During setup, GOTCHA **investigates your website** - it reads your pages, detects your channels and technology, learns your brand voice and finds your policies. Everything it learns is shown to you with a confidence level, and you can correct anything. That living profile powers your AI employee from day one, and keeps living at **Your Business** in the sidebar.

## One inbox for everything

All channels land in a single shared inbox. Your team sees every conversation, can take over from the AI at any time, and the AI reports honestly what it did and why.

**Next:** [Your first 10 minutes - the guided setup](/help/getting-started/onboarding-walkthrough)`,
        `GOTCHA היא **הדור הבא של התקשורת עם לקוחות**: כל הערוצים שהלקוחות שלכם משתמשים בהם, תיבה חכמה אחת, ו**עובדי AI** - לא צ'אטבוטים עם תשובות מוכנות, אלא חברי צוות שלומדים את העסק ומטפלים בשיחות לקוחות אמיתיות.

## מה עובד AI עושה

- **עונה ללקוחות** בוואטסאפ, אינסטגרם, מסנג'ר ואימייל - בקול המותג שלכם, בעברית או באנגלית.
- **מכיר את העסק**: המוצרים, המדיניות (משלוחים, החזרות, החזרים), שאלות נפוצות וכל ידע שתלמדו אותו.
- **משתמש במערכות שלכם**: מאתר לקוח ב-CRM (HubSpot, Salesforce, Zoho, Fireberry, Airtable) או הזמנה ב-Shopify, קובע פגישות ומעדכן רשומות.
- **יודע מתי לעצור**: כל דבר רגיש - החזרים, הנחות, פעולות בלתי הפיכות - ממתין לאישור אנושי, והוא מעביר את השיחה לצוות ברגע שהוא לא בטוח.

## איך הוא לומד את העסק

בהגדרה הראשונית GOTCHA **חוקרת את האתר שלכם** - קוראת את העמודים, מזהה ערוצים וטכנולוגיות, לומדת את קול המותג ומוצאת את המדיניות. כל ממצא מוצג לכם עם רמת ביטחון, וניתן לתקן הכול. הפרופיל החי הזה מפעיל את עובד ה-AI מהיום הראשון, וממשיך לחיות תחת **העסק שלכם** בתפריט.

## תיבה אחת להכול

כל הערוצים נכנסים לתיבת דואר משותפת אחת. הצוות רואה כל שיחה, יכול להשתלט מה-AI בכל רגע, וה-AI מדווח בכנות מה עשה ולמה.

**המשך:** [10 הדקות הראשונות - ההגדרה המודרכת](/help/getting-started/onboarding-walkthrough)`,
      ],
    },
    {
      slug: "onboarding-walkthrough",
      popular: true,
      title: ["Your first 10 minutes: the guided setup", "10 הדקות הראשונות: ההגדרה המודרכת"],
      excerpt: [
        "From entering your website to a working AI employee - every step of the setup wizard.",
        "מהזנת האתר ועד עובד AI פעיל - כל שלבי אשף ההגדרה.",
      ],
      keywords: ["setup", "wizard", "onboarding", "אשף", "הגדרה", "scan", "סריקה", "start"],
      body: [
        `You reach setup from your welcome email (the magic link signs you in - no password needed). Here's what happens:

## 1. Enter your website

One question: *where does your business live online?* Type your domain and GOTCHA starts investigating.

## 2. Watch the investigation

GOTCHA reads your site end to end - homepage, policy pages, FAQ, contact pages. You'll see each stage land as it really finishes, with live findings (channels, platform) appearing as they're discovered. Typically 30–60 seconds.

## 3. Review what it learned

The briefing shows everything: what you do, your communication channels (with real identifiers, e.g. your WhatsApp number), your technology (Shopify, review tools…), your brand voice, and honest gaps it couldn't determine. **Everything is correctable** - press "Something off?" to fix any item, and teach missing knowledge on the spot. Confirm when it's accurate.

## 4. Connect your source of truth

The one system that holds your customers or orders - your CRM or store. GOTCHA suggests the one it detected. You can skip; it's saved as a recommendation.

## 5. Pick your primary goal

Support, sales, lead qualification, operations… your answer shapes the employee.

## 6–7. Integrations & knowledge

Recommended integrations based on what was found, plus knowledge intake: teach by URL, upload files (PDF/Word), or connect Google Drive.

## 8. Meet & tune your employee

Chat with your AI employee **before it goes live**. Ask it to be friendlier, more concise, more sales-focused - it remembers.

## 9. Deploy

One click and it's hired. You land in the inbox; connect WhatsApp and it starts working. Anything you skipped is saved and keeps waiting - nothing is lost.`,
        `מגיעים להגדרה מהמייל שקיבלתם (הקישור הקסום מחבר אתכם - בלי סיסמה). כך זה עובד:

## 1. מזינים את האתר

שאלה אחת: *איפה העסק שלכם חי באינטרנט?* מקלידים את הדומיין ו-GOTCHA מתחילה לחקור.

## 2. צופים בחקירה

GOTCHA קוראת את האתר מקצה לקצה - עמוד הבית, עמודי מדיניות, שאלות נפוצות, יצירת קשר. כל שלב מסומן כשהוא באמת מסתיים, וממצאים חיים (ערוצים, פלטפורמה) מופיעים תוך כדי. בדרך כלל 30–60 שניות.

## 3. סוקרים את מה שנלמד

התדריך מציג הכול: מה אתם עושים, ערוצי התקשורת (עם מזהים אמיתיים, למשל מספר הוואטסאפ שלכם), הטכנולוגיה (Shopify, כלי ביקורות…), קול המותג, ופערים כנים שלא ניתן היה לקבוע. **הכול ניתן לתיקון** - לחצו "משהו לא מדויק?" כדי לתקן כל פריט, וללמד ידע חסר במקום. אשרו כשהכול מדויק.

## 4. מחברים את מקור האמת

המערכת שמחזיקה את הלקוחות או ההזמנות - ה-CRM או החנות. GOTCHA מציעה את מה שזוהה. אפשר לדלג; זה נשמר כהמלצה.

## 5. בוחרים מטרה עיקרית

תמיכה, מכירות, סינון לידים, תפעול… התשובה מעצבת את העובד.

## 6–7. אינטגרציות וידע

אינטגרציות מומלצות לפי מה שנמצא, והזנת ידע: לימוד מקישור, העלאת קבצים (PDF/Word) או חיבור Google Drive.

## 8. פוגשים ומכווננים את העובד

משוחחים עם עובד ה-AI **לפני שהוא עולה לאוויר**. בקשו ממנו להיות ידידותי יותר, תמציתי יותר, ממוקד מכירות - הוא זוכר.

## 9. פריסה

לחיצה אחת והוא מגויס. אתם נוחתים בתיבה; חברו וואטסאפ והוא מתחיל לעבוד. כל מה שדילגתם עליו נשמר וממשיך לחכות - שום דבר לא הולך לאיבוד.`,
      ],
    },
    {
      slug: "first-day-checklist",
      title: ["After setup: your first-day checklist", "אחרי ההגדרה: צ'ק-ליסט ליום הראשון"],
      excerpt: [
        "Five things to do right after your AI employee is deployed.",
        "חמישה דברים שכדאי לעשות מיד אחרי שעובד ה-AI נפרס.",
      ],
      keywords: ["checklist", "first day", "יום ראשון", "next steps", "המשך"],
      body: [
        `Your AI employee exists - here's how to make its first day great:

## 1. Connect WhatsApp

Most customer conversations happen there. Go to **Channels → WhatsApp → Connect** and complete the Meta signup popup. [Full guide](/help/channels/connect-whatsapp-waba).

## 2. Review "Your Business"

The sidebar's **Your Business** page is the living profile GOTCHA built. Check the readiness strip ("Can I help you yet?"), resolve open recommendations, and teach any remaining gaps.

## 3. Send a real test message

Message your own WhatsApp number as a customer would. Ask about shipping, a product, opening hours. See how it answers - then tune anything you don't like.

## 4. Watch the Approvals queue

Sensitive actions (refund promises, discounts, meeting bookings above your threshold) wait in **Approvals**. Nothing risky goes out without you.

## 5. Invite your team

Add agents and managers in **Settings → Users** - they get the shared inbox, and the AI hands conversations to them when a human is needed. [How roles work](/help/account/invite-team).

> **Tip:** the AI never guesses. When it's not sure, it says so and escalates. The more knowledge you teach it, the fewer escalations you'll see.`,
        `עובד ה-AI שלכם קיים - כך תהפכו את היום הראשון שלו למצוין:

## 1. חברו וואטסאפ

רוב שיחות הלקוחות קורות שם. גשו אל **ערוצים → וואטסאפ → התחברות** והשלימו את חלון ההרשמה של Meta. [מדריך מלא](/help/channels/connect-whatsapp-waba).

## 2. עברו על "העסק שלכם"

עמוד **העסק שלכם** בתפריט הוא הפרופיל החי ש-GOTCHA בנתה. בדקו את רצועת המוכנות ("האם אני כבר יכול לעזור?"), טפלו בהמלצות פתוחות ולמדו פערים שנותרו.

## 3. שלחו הודעת בדיקה אמיתית

כתבו למספר הוואטסאפ שלכם כמו לקוח. שאלו על משלוח, מוצר, שעות פתיחה. ראו איך הוא עונה - וכווננו כל מה שלא מוצא חן בעיניכם.

## 4. עקבו אחרי תור האישורים

פעולות רגישות (הבטחות החזר, הנחות, קביעת פגישות מעל הסף שהגדרתם) ממתינות ב**אישורים**. שום דבר מסוכן לא יוצא בלעדיכם.

## 5. הזמינו את הצוות

הוסיפו נציגים ומנהלים ב**הגדרות → משתמשים** - הם מקבלים את התיבה המשותפת, וה-AI מעביר אליהם שיחות כשנדרש אדם. [איך עובדים תפקידים](/help/account/invite-team).

> **טיפ:** ה-AI אף פעם לא מנחש. כשהוא לא בטוח - הוא אומר זאת ומסלים לצוות. ככל שתלמדו אותו יותר ידע, תראו פחות הסלמות.`,
      ],
    },
    {
      slug: "sign-in",
      title: ["Signing in: magic links & passwords", "התחברות: קישורים קסומים וסיסמאות"],
      excerpt: [
        "How magic links work, resetting a password, and what to do when a link expires.",
        "איך עובדים קישורים קסומים, איפוס סיסמה, ומה עושים כשקישור פג.",
      ],
      keywords: ["login", "password", "magic link", "סיסמה", "התחברות", "קישור"],
      body: [
        `## Magic links

Your welcome email contains a **magic link** that signs you in directly - no password needed. Links are valid for **48 hours** and can be used once. If yours expired, ask your GOTCHA contact for a fresh one, or use password sign-in if you've already set one.

## Password sign-in

Go to the app's sign-in page and enter your workspace, email and password. Forgot it? Use **"Forgot password"** - the reset link is valid for 1 hour.

## Common issues

- **"Link expired or already used"** - magic links are single-use. Request a new one or sign in with your password.
- **"Tenant is not active"** - your workspace setup isn't finished. The account admin should complete the setup wizard first.
- Sessions last 24 hours and refresh automatically while you use the app.`,
        `## קישורים קסומים

מייל ברוכים-הבאים מכיל **קישור קסום** שמחבר אתכם ישירות - בלי סיסמה. הקישור תקף **48 שעות** וחד-פעמי. אם פג - בקשו קישור חדש מאיש הקשר שלכם ב-GOTCHA, או התחברו עם סיסמה אם כבר הגדרתם.

## התחברות עם סיסמה

בעמוד ההתחברות הזינו את סביבת העבודה, האימייל והסיסמה. שכחתם? השתמשו ב**"שכחתי סיסמה"** - קישור האיפוס תקף לשעה.

## בעיות נפוצות

- **"הקישור פג או שכבר נעשה בו שימוש"** - קישורים קסומים הם חד-פעמיים. בקשו חדש או התחברו עם סיסמה.
- **"סביבת העבודה אינה פעילה"** - ההגדרה הראשונית לא הושלמה. מנהל החשבון צריך לסיים קודם את אשף ההגדרה.
- חיבור נשמר 24 שעות ומתחדש אוטומטית בזמן שימוש.`,
      ],
    },
  ],
};
