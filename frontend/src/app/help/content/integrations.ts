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

1. Pick **Shopify** in setup (or Settings \u2192 Integrations).
2. Enter your store's **myshopify domain** - e.g. \`my-store.myshopify.com\` (find it in Shopify Admin \u2192 Settings \u2192 Domains).
3. Approve the app install in the Shopify screen that opens.

## What the AI can do

**Answer questions** about orders, products, inventory, variants, shipping and returns, using your live store data.

**Take action**, when you allow it: cancel an order, refund, start a return, exchange an item, change a shipping address, update notes and tags, resend an order confirmation.

Money-moving and irreversible actions are held for a human by default. The AI proposes, you approve, and only then does it run. After you approve or reject, the customer gets a message telling them what actually happened.

## Reconnecting

Some changes need you to reconnect the store:

- adding a permission the AI did not have before
- a Shopify permission that was revoked or expired
- an error on the connection that does not clear

Reconnecting is safe. **Tools you switched off stay off.** Reconnect restores what the store makes available, not your decisions about it.

## Connection health

Settings \u2192 Integrations shows whether the store is connected, which permissions are granted, and how many tools the AI actually holds. A connected store with missing tools is a real state and it is shown as one, because a green connection on its own does not mean the AI can do anything.

## What is not supported

Being straight about this is cheaper than a customer finding out mid-conversation:

- **Coupons and discount codes for customers.** The AI does not create or validate them in a customer conversation.
- **Tax invoices** need a connected invoicing provider. Shopify alone will not produce one.
- **Address changes** are limited by fulfillment. Once an order has shipped, the address cannot be edited.
- **Exchanges after fulfillment** go through a return, not an edit.
- **Returns** depend on what your returns provider supports and how it is configured.
- **A disconnected store cannot do anything.** No tool runs while the connection is down.
- **Tools you disabled stay disabled**, including after a reconnect.

## Troubleshooting

**"The AI says it cannot do that."** Usually the tool is switched off in Settings, or the store is missing a Shopify permission. Both are shown on the integration page.

**A permission error.** Reconnect the store and approve the requested permissions.

**Customer data is not appearing.** Some Shopify data needs Protected Customer Data approval on the Shopify side. This is a Shopify setting, not a GOTCHA one.`,
        `## \u05d7\u05d9\u05d1\u05d5\u05e8

1. \u05d1\u05d7\u05e8\u05d5 **Shopify** \u05d1\u05d4\u05d2\u05d3\u05e8\u05d4 (\u05d0\u05d5 \u05d1\u05d4\u05d2\u05d3\u05e8\u05d5\u05ea \u2190 \u05d0\u05d9\u05e0\u05d8\u05d2\u05e8\u05e6\u05d9\u05d5\u05ea).
2. \u05d4\u05d6\u05d9\u05e0\u05d5 \u05d0\u05ea \u05d3\u05d5\u05de\u05d9\u05d9\u05df \u05d4-**myshopify** \u05e9\u05dc \u05d4\u05d7\u05e0\u05d5\u05ea - \u05dc\u05de\u05e9\u05dc \`my-store.myshopify.com\`.
3. \u05d0\u05e9\u05e8\u05d5 \u05d0\u05ea \u05d4\u05ea\u05e7\u05e0\u05ea \u05d4\u05d0\u05e4\u05dc\u05d9\u05e7\u05e6\u05d9\u05d4 \u05d1\u05de\u05e1\u05da Shopify \u05e9\u05e0\u05e4\u05ea\u05d7.

## \u05de\u05d4 \u05d4-AI \u05d9\u05db\u05d5\u05dc \u05dc\u05e2\u05e9\u05d5\u05ea

**\u05dc\u05e2\u05e0\u05d5\u05ea \u05e2\u05dc \u05e9\u05d0\u05dc\u05d5\u05ea** \u05d1\u05e0\u05d5\u05d2\u05e2 \u05dc\u05d4\u05d6\u05de\u05e0\u05d5\u05ea, \u05de\u05d5\u05e6\u05e8\u05d9\u05dd, \u05de\u05dc\u05d0\u05d9, \u05d5\u05e8\u05d9\u05d0\u05e0\u05d8\u05d9\u05dd, \u05de\u05e9\u05dc\u05d5\u05d7 \u05d5\u05d4\u05d7\u05d6\u05e8\u05d5\u05ea, \u05dc\u05e4\u05d9 \u05e0\u05ea\u05d5\u05e0\u05d9 \u05d4\u05d7\u05e0\u05d5\u05ea \u05d4\u05d7\u05d9\u05d9\u05dd.

**\u05dc\u05d1\u05e6\u05e2 \u05e4\u05e2\u05d5\u05dc\u05d5\u05ea**, \u05db\u05e9\u05d0\u05ea\u05dd \u05de\u05e8\u05e9\u05d9\u05dd: \u05d1\u05d9\u05d8\u05d5\u05dc \u05d4\u05d6\u05de\u05e0\u05d4, \u05d6\u05d9\u05db\u05d5\u05d9, \u05e4\u05ea\u05d9\u05d7\u05ea \u05d4\u05d7\u05d6\u05e8\u05d4, \u05d4\u05d7\u05dc\u05e4\u05ea \u05e4\u05e8\u05d9\u05d8, \u05e9\u05d9\u05e0\u05d5\u05d9 \u05db\u05ea\u05d5\u05d1\u05ea \u05de\u05e9\u05dc\u05d5\u05d7, \u05e2\u05d3\u05db\u05d5\u05df \u05d4\u05e2\u05e8\u05d5\u05ea \u05d5\u05ea\u05d5\u05d9\u05d5\u05ea, \u05e9\u05dc\u05d9\u05d7\u05d4 \u05d7\u05d5\u05d6\u05e8\u05ea \u05e9\u05dc \u05d0\u05d9\u05e9\u05d5\u05e8 \u05d4\u05d6\u05de\u05e0\u05d4.

\u05e4\u05e2\u05d5\u05dc\u05d5\u05ea \u05e9\u05de\u05e2\u05d5\u05e8\u05d1\u05d5\u05ea \u05d1\u05d4\u05df \u05db\u05e1\u05e3 \u05d0\u05d5 \u05e9\u05d0\u05d9\u05e0\u05df \u05d4\u05e4\u05d9\u05db\u05d5\u05ea \u05de\u05de\u05ea\u05d9\u05e0\u05d5\u05ea \u05dc\u05d0\u05d9\u05e9\u05d5\u05e8 \u05d0\u05e0\u05d5\u05e9\u05d9 \u05db\u05d1\u05e8\u05d9\u05e8\u05ea \u05de\u05d7\u05d3\u05dc. \u05d0\u05d7\u05e8\u05d9 \u05e9\u05d0\u05d9\u05e9\u05e8\u05ea\u05dd \u05d0\u05d5 \u05d3\u05d7\u05d9\u05ea\u05dd, \u05d4\u05dc\u05e7\u05d5\u05d7 \u05de\u05e7\u05d1\u05dc \u05d4\u05d5\u05d3\u05e2\u05d4 \u05e9\u05de\u05e1\u05e4\u05e8\u05ea \u05de\u05d4 \u05d1\u05d0\u05de\u05ea \u05e7\u05e8\u05d4.

## \u05d7\u05d9\u05d1\u05d5\u05e8 \u05de\u05d7\u05d3\u05e9

\u05dc\u05e4\u05e2\u05de\u05d9\u05dd \u05e6\u05e8\u05d9\u05da \u05dc\u05d7\u05d1\u05e8 \u05d0\u05ea \u05d4\u05d7\u05e0\u05d5\u05ea \u05de\u05d7\u05d3\u05e9: \u05db\u05e9\u05de\u05d5\u05e1\u05d9\u05e4\u05d9\u05dd \u05d4\u05e8\u05e9\u05d0\u05d4 \u05d7\u05d3\u05e9\u05d4, \u05db\u05e9\u05d4\u05e8\u05e9\u05d0\u05d4 \u05e4\u05d2\u05d4, \u05d0\u05d5 \u05db\u05e9\u05d9\u05e9 \u05e9\u05d2\u05d9\u05d0\u05d4 \u05e9\u05dc\u05d0 \u05e0\u05e1\u05d2\u05e8\u05ea.

\u05d7\u05d9\u05d1\u05d5\u05e8 \u05de\u05d7\u05d3\u05e9 \u05d1\u05d8\u05d5\u05d7. **\u05db\u05dc\u05d9\u05dd \u05e9\u05db\u05d9\u05d1\u05d9\u05ea\u05dd \u05e0\u05e9\u05d0\u05e8\u05d9\u05dd \u05db\u05d1\u05d5\u05d9\u05d9\u05dd.**

## \u05de\u05d4 \u05dc\u05d0 \u05e0\u05ea\u05de\u05da

- **\u05e7\u05d5\u05e4\u05d5\u05e0\u05d9\u05dd \u05d5\u05e7\u05d5\u05d3\u05d9 \u05d4\u05e0\u05d7\u05d4 \u05dc\u05dc\u05e7\u05d5\u05d7\u05d5\u05ea** \u05d1\u05e9\u05d9\u05d7\u05d4.
- **\u05d7\u05e9\u05d1\u05d5\u05e0\u05d9\u05ea \u05de\u05e1** \u05d3\u05d5\u05e8\u05e9\u05ea \u05e1\u05e4\u05e7 \u05d7\u05e9\u05d1\u05d5\u05e0\u05d9\u05d5\u05ea \u05de\u05d7\u05d5\u05d1\u05e8.
- **\u05e9\u05d9\u05e0\u05d5\u05d9 \u05db\u05ea\u05d5\u05d1\u05ea** \u05de\u05d5\u05d2\u05d1\u05dc \u05d0\u05d7\u05e8\u05d9 \u05e9\u05dc\u05d9\u05d7\u05d4.
- **\u05d4\u05d7\u05dc\u05e4\u05d4 \u05d0\u05d7\u05e8\u05d9 \u05de\u05e9\u05dc\u05d5\u05d7** \u05e2\u05d5\u05d1\u05e8\u05ea \u05d3\u05e8\u05da \u05d4\u05d7\u05d6\u05e8\u05d4.
- **\u05d7\u05e0\u05d5\u05ea \u05de\u05e0\u05d5\u05ea\u05e7\u05ea \u05dc\u05d0 \u05de\u05d1\u05e6\u05e2\u05ea \u05db\u05dc\u05d5\u05dd.**
- **\u05db\u05dc\u05d9\u05dd \u05e9\u05db\u05d9\u05d1\u05d9\u05ea\u05dd \u05e0\u05e9\u05d0\u05e8\u05d9\u05dd \u05db\u05d1\u05d5\u05d9\u05d9\u05dd**, \u05d2\u05dd \u05d0\u05d7\u05e8\u05d9 \u05d7\u05d9\u05d1\u05d5\u05e8 \u05de\u05d7\u05d3\u05e9.`,
      ],
    },
  ],
};
