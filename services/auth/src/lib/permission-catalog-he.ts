/**
 * The permission catalogue in Hebrew (2026-10-08, the Hebrew sweep): GET
 * /api/permissions/catalog served every permission's name and description,
 * and every built-in role's, in English only. Keyed exactly as
 * packages/shared/permission-catalog.ts; a permission or role with no Hebrew
 * (one added later) keeps its English.
 */
import type { PermissionDef, BuiltinRoleDef } from "@chatcenter/shared";

export const PERMISSION_HE: Record<string, { displayName: string; description: string }> = {
  "ai:employees:create": { displayName: "יצירת עובדי AI", description: "יצירת עובדי AI חדשים." },
  "ai:employees:delete": { displayName: "מחיקת עובדי AI", description: "מחיקת עובדי AI." },
  "ai:employees:read": { displayName: "צפייה בעובדי AI", description: "צפייה בעובדי AI ובהגדרות שלהם." },
  "ai:employees:update": { displayName: "עריכת עובדי AI", description: "עריכת עובדי AI ואופן הפעולה שלהם." },
  "ai:knowledge:read": { displayName: "צפייה במאגר הידע", description: "צפייה במקורות ובמסמכים של מאגר הידע." },
  "ai:knowledge:write": { displayName: "עריכת מאגר הידע", description: "הוספה, עריכה והסרה של תוכן במאגר הידע." },
  "ai:tools:assign": { displayName: "שיוך כלי AI", description: "שיוך כלים הניתנים להפעלה לעובדי AI." },
  "ai:tools:manage": { displayName: "ניהול כלי AI", description: "הפעלה והשבתה של כלים והגדרת מצב ההפעלה (אוטומטי או באישור אנושי), מקבלי האישורים והמגבלות." },
  "ai:tools:read": { displayName: "צפייה בכלי AI", description: "צפייה בכלי AI הניתנים להפעלה, בשיוכים שלהם ובמצב ההפעלה (אוטומטי או באישור אנושי)." },
  "ai:workflows:publish": { displayName: "פרסום אוטומציות", description: "הפעלה או פרסום של אוטומציה כך שתרוץ בפועל, בכפוף לבדיקת תקינות המבנה שלה." },
  "ai:workflows:read": { displayName: "צפייה באוטומציות", description: "צפייה באוטומציות ובתהליכים." },
  "ai:workflows:update": { displayName: "עריכת אוטומציות", description: "יצירה ועריכה של אוטומציות ותהליכים." },
  "analytics:dashboard:read": { displayName: "צפייה בלוח האנליטיקה", description: "צפייה בלוחות אנליטיקה ובדוחות ניהוליים." },
  "analytics:reports:export": { displayName: "ייצוא דוחות", description: "ייצוא דוחות אנליטיקה." },
  "analytics:workspace:read": { displayName: "צפייה בתמונת המצב של סביבת העבודה", description: "צפייה בתמונת המצב התפעולית המשותפת: התור, מי זמין, אישורים ממתינים והנתונים של היום." },
  "approvals:policies:manage": { displayName: "ניהול מדיניות אישורים", description: "הגדרת מדיניות האישורים והאישור האנושי." },
  "approvals:requests:approve": { displayName: "אישור בקשות", description: "אישור בקשות אישור ממתינות." },
  "approvals:requests:reject": { displayName: "דחיית בקשות", description: "דחיית בקשות אישור ממתינות." },
  "approvals:requests:view": { displayName: "צפייה בבקשות אישור", description: "צפייה בבקשות אישור ממתינות של עובדי AI ושל נציגים." },
  "business-systems:connections:connect": { displayName: "חיבור מערכות עסקיות", description: "חיבור או חיבור מחדש של מערכת עסקית (OAuth או מפתח API)." },
  "business-systems:connections:manage": { displayName: "ניהול מערכות עסקיות", description: "הגדרת סנכרון וכתיבה חזרה, שינוי הגדרות או ניתוק של מערכת עסקית." },
  "business-systems:connections:read": { displayName: "צפייה במערכות עסקיות", description: "צפייה במערכות העסקיות המחוברות, בתקינות שלהן ובסטטוס מקור האמת." },
  "business-systems:sot:select": { displayName: "בחירת מקור האמת", description: "בחירת המערכת המחוברת שתשמש כמקור האמת לנתוני הלקוחות." },
  "channels:manage:read": { displayName: "צפייה בערוצים", description: "צפייה בערוצי ההודעות והקול המחוברים." },
  "channels:manage:update": { displayName: "ניהול ערוצים", description: "חיבור והגדרה של ערוצי הודעות וקול." },
  "conversation:messages:assign": { displayName: "הקצאת שיחות", description: "הקצאה או הקצאה מחדש של שיחות לנציגים." },
  "conversation:messages:close": { displayName: "סגירת שיחות", description: "סגירת שיחות או סימונן כפתורות." },
  "conversation:messages:read": { displayName: "צפייה בשיחות", description: "צפייה בשיחות עם לקוחות ובהודעות שבהן." },
  "conversation:messages:reply": { displayName: "מענה בשיחות", description: "שליחת תשובות בשיחות עם לקוחות." },
  "conversation:messages:takeover": { displayName: "השתלטות על שיחות", description: "השתלטות על שיחה מעובד AI או מנציג אחר." },
  "crm:activities:create": { displayName: "יצירת פעילויות ב-CRM", description: "תיעוד משימות, הערות ופעילויות ב-CRM." },
  "crm:contacts:read": { displayName: "צפייה באנשי קשר ב-CRM", description: "צפייה באנשי הקשר ב-CRM." },
  "crm:contacts:update": { displayName: "עריכת אנשי קשר ב-CRM", description: "יצירה ועריכה של אנשי קשר ב-CRM." },
  "crm:deals:read": { displayName: "צפייה בעסקאות ב-CRM", description: "צפייה בעסקאות ובהזדמנויות ב-CRM." },
  "crm:deals:update": { displayName: "עריכת עסקאות ב-CRM", description: "יצירה ועריכה של עסקאות והזדמנויות ב-CRM." },
  "customer:commerce:cancel": { displayName: "ביטול הזמנות", description: "ביטול הזמנה של לקוח בחנות, בכפוף למדיניות העסק ולאישור." },
  "customer:commerce:note": { displayName: "הערות על לקוחות", description: "הוספת הערה פנימית לרשומת הלקוח בחנות המחוברת." },
  "customer:commerce:notify": { displayName: "שליחה חוזרת של מיילי הזמנה", description: "שליחה חוזרת של מייל אישור ההזמנה ללקוח מהחנות המחוברת." },
  "customer:commerce:open": { displayName: "פתיחת הזמנות בחנות", description: "פתיחת ההזמנה של הלקוח בממשק הניהול של החנות המחוברת." },
  "customer:commerce:read": { displayName: "צפייה בהקשר המסחרי", description: "צפייה בהזמנות, בסכומי הרכישה ובסטטוס של הלקוח בחנות המחוברת, בתוך השיחה." },
  "customer:commerce:refund": { displayName: "החזר כספי על הזמנות", description: "ביצוע החזר כספי על הזמנה של לקוח בחנות, בכפוף למדיניות העסק ולאישור." },
  "customer:commerce:return": { displayName: "החזרות והחלפות", description: "פתיחת החזרה או החלפת פריט בהזמנה של לקוח בחנות, בכפוף למדיניות העסק ולאישור." },
  "customer:commerce:tag": { displayName: "תיוג לקוחות", description: "הוספה או הסרה של תגיות ברשומת הלקוח בחנות המחוברת." },
  "customer:profile:export": { displayName: "ייצוא נתוני לקוחות", description: "ייצוא נתוני הפרופיל של לקוחות." },
  "customer:profile:read": { displayName: "צפייה בפרופילי לקוחות", description: "צפייה בנתוני הפרופיל של לקוחות." },
  "customer:profile:update": { displayName: "עריכת פרופילי לקוחות", description: "עריכת נתוני הפרופיל של לקוחות." },
  "integrations:connections:connect": { displayName: "חיבור אינטגרציות", description: "חיבור והגדרה של אינטגרציות צד שלישי." },
  "integrations:connections:disconnect": { displayName: "ניתוק אינטגרציות", description: "ניתוק אינטגרציות צד שלישי." },
  "integrations:connections:read": { displayName: "צפייה באינטגרציות", description: "צפייה באינטגרציות המחוברות." },
  "outbound:calls:create": { displayName: "ביצוע שיחות טלפון יוצאות", description: "התחלת שיחות טלפון יוצאות ללקוחות." },
  "outbound:calls:view": { displayName: "צפייה בשיחות טלפון יוצאות", description: "צפייה בפעילות שיחות הטלפון היוצאות ובשיחות המתנהלות בזמן אמת." },
  "settings:billing:auto-purchase": { displayName: "ניהול טעינה אוטומטית", description: "הפעלת טעינה אוטומטית של קרדיטים וקביעת תקרת ההוצאה החודשית שלה." },
  "settings:billing:cancel": { displayName: "ביטול מנוי", description: "ביטול המנוי של סביבת העבודה או תזמון הביטול שלו." },
  "settings:billing:manage": { displayName: "ניהול חיוב", description: "ניהול המנוי, החיוב והתוכניות." },
  "settings:billing:purchase": { displayName: "רכישת קרדיטים", description: "רכישת חבילות קרדיטים לסביבת העבודה." },
  "settings:billing:read": { displayName: "צפייה בחיוב", description: "צפייה בתוכנית, ביתרת הקרדיטים, בשימוש ובחשבוניות." },
  "settings:business-policies:manage": { displayName: "ניהול כללים עסקיים", description: "יצירת גרסאות חדשות של מדיניות הפעולות של AI, בלי לשנות אף פעם החלטות שכבר התקבלו." },
  "settings:business-policies:preview": { displayName: "תצוגה מקדימה של כללים עסקיים", description: "הרצת ניסיון של תרחישים לדוגמה מול המדיניות הפעילה." },
  "settings:business-policies:read": { displayName: "צפייה בכללים עסקיים", description: "צפייה במדיניות הפעולות של AI בעסק עבור החזרים כספיים, קופונים ופיצויים." },
  "settings:members:manage": { displayName: "ניהול משתמשים", description: "הזמנה, עריכה והשבתה של משתמשים והקצאת תפקידים." },
  "settings:roles:manage": { displayName: "ניהול תפקידים", description: "יצירה ועריכה של תפקידים וההרשאות שלהם." },
  "settings:workspace:read": { displayName: "צפייה בהגדרות סביבת העבודה", description: "צפייה בפרטי העסק שעובדי AI מצטטים: שם, תיאור, שעות פעילות וסגנון כתיבה." },
  "settings:workspace:update": { displayName: "ניהול הגדרות סביבת העבודה", description: "עריכת ההגדרות וברירות המחדל של סביבת העבודה." },
};

export const ROLE_HE: Record<string, { name: string; description: string }> = {
  "owner": { name: "בעלים", description: "גישה מלאה לכל דבר, כולל חיוב, תפקידים ומחזור החיים של סביבת העבודה." },
  "admin": { name: "אדמין", description: "גישה מלאה לתפעול ולהגדרות, למעט חיוב, ניהול תפקידים ומפתחות API." },
  "department_manager": { name: "מנהל מחלקה", description: "ניהול מחלקה: טיפול מלא בשיחות ובאישורים, ואנליטיקה בהיקף המחלקה." },
  "agent": { name: "נציג", description: "נציג קו ראשון: טיפול בשיחות האישיות וצפייה בהקשר של הלקוח וב-CRM." },
};

/** One permission for this reader. */
export function permissionFor(p: PermissionDef, locale: "he" | "en"): PermissionDef {
  const he = locale === "he" ? PERMISSION_HE[p.key] : undefined;
  return he ? { ...p, displayName: he.displayName, description: he.description } : p;
}

/** One built-in role for this reader. */
export function roleFor(r: BuiltinRoleDef, locale: "he" | "en"): BuiltinRoleDef {
  const he = locale === "he" ? ROLE_HE[r.key] : undefined;
  return he ? { ...r, name: he.name, description: he.description } : r;
}
