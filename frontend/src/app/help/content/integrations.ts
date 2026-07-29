import type { HelpCategory } from "./types";

export const integrations: HelpCategory = {
  slug: "integrations",
  icon: "plug",
  title: ["Integrations & CRM", "אינטגרציות ו-CRM"],
  desc: ["Connect your source of truth: HubSpot, Salesforce, Zoho, Fireberry, Airtable, Shopify.", "חיבור מקור האמת: HubSpot, Salesforce, Zoho, Fireberry, Airtable, Shopify."],
  articles: [
    {
      slug: "source-of-truth",
      popular: true,
      title: ["Your source of truth - and connecting HubSpot / Salesforce / Zoho", "מקור האמת שלכם - וחיבור HubSpot / Salesforce / Zoho"],
      excerpt: [
        "Why one system matters, what the AI does with it, and the one-click OAuth connections.",
        "למה מערכת אחת חשובה, מה ה-AI עושה איתה, וחיבורי ה-OAuth בלחיצה.",
      ],
      keywords: ["crm", "hubspot", "salesforce", "zoho", "source of truth", "מקור אמת", "oauth"],
      body: [
        `## What "source of truth" means

It's the one system that holds your customers or orders - your CRM or your store. Once connected, your AI employee can **recognize returning customers**, read their history, capture new leads, and write conversation summaries back - so the CRM stays current without anyone typing.

You pick it during setup (Movement "Connect your source of truth") or later from **Settings → Integrations**.

## HubSpot, Salesforce, Zoho - one-click OAuth

1. Choose the system (in setup, or Settings → Integrations).
2. Click **Connect** - you're redirected to the provider's sign-in.
3. Sign in with an account that has admin/API permissions and approve the requested access.
4. You're returned to GOTCHA, connected. That's it - the AI's customer-lookup and lead-creation abilities light up automatically.

## What the AI writes back

- New leads/contacts for unrecognized customers (with the details it learned in conversation).
- Conversation summaries as notes on the record.
- Field updates are **sparse** - it only touches fields that were actually discussed, never wiping existing data.

> **Tip:** all lead creation goes through one consistent path regardless of vendor, so switching CRMs later doesn't retrain your employee.`,
        `## מה זה "מקור אמת"

זו המערכת האחת שמחזיקה את הלקוחות או ההזמנות - ה-CRM או החנות. אחרי חיבור, עובד ה-AI יכול **לזהות לקוחות חוזרים**, לקרוא היסטוריה, לקלוט לידים חדשים ולכתוב חזרה סיכומי שיחה - כך שה-CRM נשאר מעודכן בלי שאף אחד מקליד.

בוחרים אותו בהגדרה הראשונית (שלב "חיבור מקור האמת") או אחר כך דרך **הגדרות → אינטגרציות**.

## HubSpot, Salesforce, Zoho - חיבור OAuth בלחיצה

1. בחרו את המערכת (בהגדרה, או בהגדרות → אינטגרציות).
2. לחצו **התחברות** - תועברו למסך ההתחברות של הספק.
3. התחברו עם חשבון בעל הרשאות אדמין/API ואשרו את הגישה.
4. חוזרים ל-GOTCHA מחוברים. זהו - יכולות זיהוי הלקוח ויצירת הלידים נדלקות אוטומטית.

## מה ה-AI כותב חזרה

- לידים/אנשי קשר חדשים ללקוחות לא מזוהים (עם הפרטים שנלמדו בשיחה).
- סיכומי שיחה כהערות על הרשומה.
- עדכוני שדות הם **חסכוניים** - רק שדות שנדונו בפועל, בלי למחוק מידע קיים.

> **טיפ:** יצירת לידים עוברת בנתיב אחיד לכל הספקים, כך שמעבר CRM בעתיד לא דורש אימון מחדש של העובד.`,
      ],
    },
    {
      slug: "connect-fireberry",
      title: ["Connect Fireberry", "חיבור Fireberry"],
      excerpt: ["Fireberry connects with an API token - here's exactly where to find it.", "Fireberry מתחבר עם טוקן API - הנה בדיוק איפה מוצאים אותו."],
      keywords: ["fireberry", "פיירברי", "token", "טוקן", "api"],
      body: [
        `Fireberry uses an **API token** instead of OAuth.

## Get your token

In Fireberry: **Settings → Integration → API Forms → My Token**. Copy the token (\`tokenid\`).

## Connect

1. In GOTCHA setup (or Settings → Integrations), pick **Fireberry**.
2. Paste the token and click **Connect**.
3. Done - accounts and contacts become available to your AI employee.

## Troubleshooting

- **"Couldn't connect"** - re-copy the token (no spaces), and confirm your Fireberry user has API access enabled.
- The token can be rotated in Fireberry at any time; if you rotate it, reconnect in GOTCHA with the new one.`,
        `Fireberry מתחבר עם **טוקן API** במקום OAuth.

## איפה הטוקן

ב-Fireberry: **הגדרות → אינטגרציה → API → הטוקן שלי**. העתיקו את הטוקן (\`tokenid\`).

## החיבור

1. בהגדרת GOTCHA (או בהגדרות → אינטגרציות) בחרו **Fireberry**.
2. הדביקו את הטוקן ולחצו **התחברות**.
3. זהו - חשבונות ואנשי קשר זמינים לעובד ה-AI.

## פתרון תקלות

- **"לא הצלחנו להתחבר"** - העתיקו שוב את הטוקן (בלי רווחים), וודאו שלמשתמש שלכם ב-Fireberry יש גישת API.
- אפשר להחליף טוקן ב-Fireberry בכל עת; אחרי החלפה - התחברו מחדש ב-GOTCHA עם החדש.`,
      ],
    },
    {
      slug: "connect-airtable",
      title: ["Connect Airtable (with column mapping)", "חיבור Airtable (כולל מיפוי עמודות)"],
      excerpt: ["OAuth, then tell GOTCHA which base, table and columns hold your contacts.", "OAuth, ואז מגדירים ל-GOTCHA איזה בסיס, טבלה ועמודות מחזיקים את אנשי הקשר."],
      keywords: ["airtable", "אירטייבל", "base", "mapping", "מיפוי", "columns"],
      body: [
        `Airtable is flexible - your contacts can live in any base with any column names - so after OAuth you map your columns once.

## Steps

1. Pick **Airtable** in setup (or Settings → Integrations) and complete the OAuth sign-in.
2. Back in GOTCHA, the mapping wizard opens:
   - **Base** - the base holding your contacts.
   - **Contacts table** - the table itself.
   - **Columns** - map Name (required), Email and/or Phone (at least one required), and optionally Stage/Status and a Notes column. GOTCHA pre-suggests matches by column name.
3. Leave **"Create Notes / ID columns for me if missing"** checked and GOTCHA prepares what it needs.
4. Finish - Airtable is now your source of truth.

## Notes

- Without a mapped Name + (Email or Phone), the connection isn't usable yet and the AI won't treat Airtable as ready - complete the mapping.
- The AI writes conversation summaries into your Notes column, and creates rows for new customers.`,
        `Airtable גמיש - אנשי הקשר יכולים לשבת בכל בסיס ועם כל שמות עמודות - ולכן אחרי ה-OAuth ממפים עמודות פעם אחת.

## שלבים

1. בחרו **Airtable** בהגדרה (או בהגדרות → אינטגרציות) והשלימו התחברות OAuth.
2. בחזרה ב-GOTCHA נפתח אשף המיפוי:
   - **בסיס** - הבסיס עם אנשי הקשר.
   - **טבלת אנשי קשר** - הטבלה עצמה.
   - **עמודות** - מפו שם (חובה), אימייל ו/או טלפון (לפחות אחד חובה), ואופציונלית שלב/סטטוס ועמודת הערות. GOTCHA מציעה התאמות לפי שמות העמודות.
3. השאירו מסומן **"צרו עבורי עמודות הערות/מזהה אם חסרות"** ו-GOTCHA תכין את מה שצריך.
4. סיימו - Airtable הוא כעת מקור האמת.

## הערות

- בלי שם ממופה + (אימייל או טלפון) החיבור עדיין לא שמיש וה-AI לא יתייחס ל-Airtable כמוכן - השלימו את המיפוי.
- ה-AI כותב סיכומי שיחה לעמודת ההערות, ויוצר שורות ללקוחות חדשים.`,
      ],
    },
    {
      slug: "connect-shopify",
      title: ["Connect Shopify", "חיבור Shopify"],
      excerpt: ["Let the AI answer \"where's my order?\" itself - orders, products and customers from your store.", "תנו ל-AI לענות בעצמו על \"איפה ההזמנה שלי?\" - הזמנות, מוצרים ולקוחות מהחנות."],
      keywords: ["shopify", "שופיפיי", "store", "orders", "הזמנות", "חנות"],
      body: [
        `## Connect

1. Pick **Shopify** in setup (or Settings → Integrations).
2. Enter your store's **myshopify domain** - e.g. \`my-store.myshopify.com\` (find it in Shopify Admin → Settings → Domains).
3. Approve the app install in the Shopify screen that opens.

## What it unlocks

- **"Where's my order?"** answered automatically - the AI looks up the order by the customer's details and reports real status.
- Product questions answered from your live catalog.
- Customer recognition by email/phone from your store records.
- Shopify can also serve as your **source of truth** if you don't run a separate CRM.

> After connecting, GOTCHA adds store-specific recommendations (like automating order-status replies) to your recommendations list.`,
        `## חיבור

1. בחרו **Shopify** בהגדרה (או בהגדרות → אינטגרציות).
2. הזינו את דומיין ה-**myshopify** של החנות - למשל \`my-store.myshopify.com\` (נמצא ב-Shopify Admin ← Settings ← Domains).
3. אשרו את התקנת האפליקציה במסך Shopify שנפתח.

## מה זה פותח

- **"איפה ההזמנה שלי?"** נענה אוטומטית - ה-AI מאתר את ההזמנה לפי פרטי הלקוח ומדווח סטטוס אמיתי.
- שאלות מוצר נענות מהקטלוג החי.
- זיהוי לקוחות לפי אימייל/טלפון מרשומות החנות.
- Shopify יכול לשמש גם כ**מקור האמת** אם אין לכם CRM נפרד.

> אחרי החיבור GOTCHA מוסיפה המלצות ייעודיות לחנות (כמו אוטומציה למענה על סטטוס הזמנה) לרשימת ההמלצות שלכם.`,
      ],
    },
  ],
};
