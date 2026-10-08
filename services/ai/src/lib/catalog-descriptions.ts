/**
 * The business systems catalogue's descriptions in Hebrew, keyed by slug.
 *
 * `IntegrationCatalog.description` is one English column (written by
 * migrations); a Hebrew screen showed it as is (/studio/capabilities). The
 * Hebrew lives here, not in a column: no migration, and a new catalogue row
 * without an entry here simply shows its English text.
 */
export const CATALOG_DESCRIPTION_HE: Record<string, string> = {
  shopify: "פלטפורמת מסחר מקוון לחנויות אונליין",
  woocommerce: "תוסף מסחר מקוון בקוד פתוח ל-WordPress",
  fireberry: "CRM ישראלי (לשעבר Powerlink): חשבונות, אנשי קשר ולידים כמקור האמת שלך.",
  stripe: "תשתית לתשלומים ולחיובים אונליין",
  paypal: "שירות לתשלומים דיגיטליים ולהעברות כספים",
  hubspot: "פלטפורמת CRM ואוטומציה שיווקית",
  salesforce: "CRM ארגוני ופלטפורמת ענן למכירות",
  zoho_crm: "CRM בענן למכירות ולשירות לקוחות",
  monday: "מערכת עבודה לניהול פרויקטים",
  google_calendar: "יומן וזימון פגישות אונליין של Google",
  returngo: "פלטפורמה לניהול החזרות: הסטטוס של כל החזר והחזרה, ועדכונים עליהם.",
  calendly: "זימון פגישות ב-Calendly. לא זמין כרגע: החיבור של GOTCHA עדיין לא שלם (אין לו כלים ואין בחירה של סוג פגישה), ולכן עובד AI עוד לא יכול להשתמש בו.",
  postgresql: "מסד נתונים רלציוני בקוד פתוח, עם תמיכה מתקדמת ב-SQL",
  mongodb: "מסד נתונים של מסמכים (NoSQL) לאפליקציות מודרניות",
  aws_rds: "שירות מסדי הנתונים הרלציוניים של Amazon: מסדי SQL מנוהלים בענן",
  custom_api: "כלים משלך מעל HTTP, בבונה בקשות בסגנון Postman. כל כלי חושף ל-AI קריאת API אחת, בשם custom.<slug>.",
  airtable: "בסיס Airtable כמקור האמת על הלקוחות שלך: ממפים את העמודות של טבלת אנשי הקשר, וה-AI קורא וכותב שם.",
};

/** A catalogue entry's description in the reader's language; English when there is no Hebrew for it. */
export function catalogDescription(slug: string, description: string | null, locale: "he" | "en"): string | null {
  return locale === "he" ? CATALOG_DESCRIPTION_HE[slug] ?? description : description;
}
