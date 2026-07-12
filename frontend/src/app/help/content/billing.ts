import type { HelpCategory } from "./types";

export const billing: HelpCategory = {
  slug: "billing",
  icon: "credit",
  title: ["Billing & AI credits", "חיוב וקרדיטים"],
  desc: ["How AI credits work, usage alerts at 80% and 100%, buying more, and pilots.", "איך עובדים קרדיטים, התראות ב-80% ו-100%, רכישה, ופיילוטים."],
  articles: [
    {
      slug: "how-credits-work",
      popular: true,
      title: ["How AI credits work", "איך עובדים קרדיטים של AI"],
      excerpt: ["Included vs purchased credits, what consumes them, and where to see your balance.", "קרדיטים כלולים מול נרכשים, מה צורך אותם, ואיפה רואים יתרה."],
      keywords: ["credits", "units", "balance", "קרדיטים", "יתרה", "יחידות", "usage"],
      body: [
        `Everything your AI employees think and write consumes **AI credits** (units). Credits keep pricing honest: heavier work costs more, small replies cost little.

## Two buckets

- **Included credits** — your plan's monthly allowance. They reset each billing period (use-it-or-lose-it).
- **Purchased credits** — top-ups you buy. They **never expire** and are used only after the month's included credits.

## What consumes credits

AI replies, conversation summaries, knowledge processing — any real AI work. Human agents typing in the inbox costs nothing.

## Where to see it

**Settings → Billing** shows your live balance: included remaining, purchased remaining, and how much of this month's budget you've used. Every consumption is recorded in a ledger — no mystery charges.

## When credits run out

Your AI employees pause and conversations route to your team — customers are never left unanswered, humans just take over. Top up (or enable auto-purchase) and the AI resumes instantly. See [Usage alerts](/help/billing/usage-alerts).`,
        `כל מה שעובדי ה-AI חושבים וכותבים צורך **קרדיטים** (יחידות). קרדיטים שומרים על תמחור הוגן: עבודה כבדה עולה יותר, תשובות קטנות עולות מעט.

## שני סוגים

- **קרדיטים כלולים** — ההקצאה החודשית של התוכנית. מתאפסים כל תקופת חיוב (מה שלא נוצל — נעלם).
- **קרדיטים נרכשים** — טעינות שקניתם. הם **לא פגים לעולם** ונצרכים רק אחרי הקרדיטים הכלולים של החודש.

## מה צורך קרדיטים

תשובות AI, סיכומי שיחות, עיבוד ידע — כל עבודת AI אמיתית. נציגים אנושיים שמקלידים בתיבה לא עולים כלום.

## איפה רואים

**הגדרות → חיוב** מציג יתרה חיה: כלולים שנותרו, נרכשים שנותרו, וכמה מתקציב החודש נוצל. כל צריכה נרשמת ביומן — בלי חיובים מסתוריים.

## כשהקרדיטים נגמרים

עובדי ה-AI מושהים והשיחות מנותבות לצוות — לקוחות לעולם לא נשארים בלי מענה, פשוט בני אדם נכנסים. טענו (או הפעילו רכישה אוטומטית) וה-AI חוזר מיד. ראו [התראות שימוש](/help/billing/usage-alerts).`,
      ],
    },
    {
      slug: "usage-alerts",
      title: ["Usage alerts at 80% and 100%", "התראות שימוש ב-80% וב-100%"],
      excerpt: ["What you'll see in the app and by email as your budget runs down — and what happens at zero.", "מה תראו באפליקציה ובמייל כשהתקציב מתרוקן — ומה קורה באפס."],
      keywords: ["alerts", "80%", "100%", "התראות", "exhausted", "paused", "מושהה"],
      body: [
        `GOTCHA tells you **before** credits become a problem:

## At 80% of your budget

- An **amber banner** appears in the workspace for admins: *"80% of your AI credit budget used"* with a one-click path to billing. Dismissable — it's a heads-up, not an alarm. (Further notices as usage climbs through 90% and 95%.)
- An email notification goes to the account owner.

## At 100% — credits exhausted

- A **red banner**: *"AI credits exhausted — your AI employees are paused."* It stays until you top up.
- The AI stops consuming: new customer messages route to your human team with full context. Nothing is lost — the AI just steps aside.
- If **auto-purchase** is enabled, a top-up is bought automatically at your configured threshold and the AI never pauses at all.

## Getting back to work

Buy credits at **Settings → Billing** — the AI resumes the moment the balance is positive. Mid-conversation customers get picked up right where they were.`,
        `GOTCHA מעדכנת אתכם **לפני** שקרדיטים הופכים לבעיה:

## ב-80% מהתקציב

- **באנר כתום** מופיע בסביבת העבודה למנהלים: *"80% מתקציב קרדיטי ה-AI נוצל"* עם קיצור לעמוד החיוב. ניתן לסגירה — זו התרעה, לא אזעקה. (עדכונים נוספים ב-90% וב-95%.)
- מייל נשלח לבעל החשבון.

## ב-100% — הקרדיטים נגמרו

- **באנר אדום**: *"קרדיטי ה-AI נגמרו — עובדי ה-AI מושהים."* נשאר עד שטוענים.
- ה-AI מפסיק לצרוך: הודעות לקוח חדשות מנותבות לצוות האנושי עם הקשר מלא. שום דבר לא הולך לאיבוד — ה-AI פשוט זז הצידה.
- אם **רכישה אוטומטית** פעילה — טעינה נקנית אוטומטית בסף שהגדרתם וה-AI לא מושהה בכלל.

## חזרה לעבודה

קונים קרדיטים ב**הגדרות → חיוב** — ה-AI חוזר ברגע שהיתרה חיובית. לקוחות באמצע שיחה נאספים בדיוק מאיפה שהיו.`,
      ],
    },
    {
      slug: "plans-topups-pilots",
      title: ["Plans, top-ups, auto-purchase & pilots", "תוכניות, טעינות, רכישה אוטומטית ופיילוטים"],
      excerpt: ["Choosing a plan, buying credit packages, setting auto-purchase, and how free pilots (POC) work.", "בחירת תוכנית, רכישת חבילות, רכישה אוטומטית, ואיך עובד פיילוט חינמי."],
      keywords: ["plan", "pricing", "poc", "pilot", "auto-purchase", "תוכנית", "פיילוט", "רכישה"],
      body: [
        `## Plans

Plans bundle a monthly included-credit allowance with the feature areas your team can use. Upgrades apply immediately (prorated); downgrades and cancellations apply at the end of the period — you never lose paid time.

## Buying credits

**Settings → Billing → Credits**: pick a package and pay. Purchased credits never expire.

## Auto-purchase

Never think about it again: set a threshold and a monthly ceiling, and GOTCHA buys a package automatically when your balance drops low. The monthly ceiling caps the total so a busy month can't surprise you.

## Free pilots (POC)

Want to try GOTCHA on real conversations before subscribing? We provision **pilot workspaces**: free, no credit card, with a real credit budget and the feature set agreed for the pilot, optionally time-limited. The same alerts (80% / 100%) and honest AI-pause behavior apply — a pilot behaves exactly like production, just prepaid by us. Ask your GOTCHA contact to set one up.

## Invoices

Every charge produces a legal invoice (חשבונית מס/קבלה) automatically, available under Billing.`,
        `## תוכניות

תוכנית מאגדת הקצאת קרדיטים חודשית עם אזורי הפיצ'רים שהצוות יכול להשתמש בהם. שדרוגים נכנסים מיד (יחסית); הורדות וביטולים נכנסים בסוף התקופה — לא מאבדים זמן ששולם.

## רכישת קרדיטים

**הגדרות → חיוב → קרדיטים**: בוחרים חבילה ומשלמים. קרדיטים נרכשים לא פגים לעולם.

## רכישה אוטומטית

לא לחשוב על זה שוב: מגדירים סף ותקרה חודשית, ו-GOTCHA קונה חבילה אוטומטית כשהיתרה יורדת. התקרה החודשית מגבילה את הסכום — חודש עמוס לא יפתיע אתכם.

## פיילוטים חינמיים (POC)

רוצים לנסות את GOTCHA על שיחות אמיתיות לפני מנוי? אנחנו מקימים **סביבות פיילוט**: חינם, בלי כרטיס אשראי, עם תקציב קרדיטים אמיתי וסט הפיצ'רים שסוכם, ואפשר גם בהגבלת זמן. אותן התראות (80% / 100%) ואותה השהיה כנה של ה-AI חלות — פיילוט מתנהג בדיוק כמו פרודקשן, רק על חשבוננו. בקשו מאיש הקשר שלכם ב-GOTCHA להקים אחד.

## חשבוניות

כל חיוב מפיק חשבונית מס/קבלה אוטומטית, זמינה תחת חיוב.`,
      ],
    },
  ],
};
