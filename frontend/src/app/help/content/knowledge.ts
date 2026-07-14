import type { HelpCategory } from "./types";

export const knowledge: HelpCategory = {
  slug: "knowledge",
  icon: "book",
  title: ["Knowledge base", "מאגר ידע"],
  desc: ["Teach your AI from your website, files and Google Drive - and keep it current.", "למדו את ה-AI מהאתר, מקבצים ומ-Google Drive - ושמרו אותו מעודכן."],
  articles: [
    {
      slug: "teach-from-website",
      popular: true,
      title: ["Teaching from your website & text", "לימוד מהאתר ומטקסט"],
      excerpt: ["Teach by URL or pasted text - during setup or any time after.", "לימוד מקישור או טקסט מודבק - בהגדרה או בכל שלב אחר."],
      keywords: ["teach", "knowledge", "url", "ידע", "ללמד", "קישור", "faq"],
      body: [
        `Your AI answers only from what it knows. The scan already taught it a lot (policies, FAQ it found on your site) - here's how to teach the rest.

## Two ways to teach

- **Provide a URL** - a help-center page, a policy page, a product guide. GOTCHA reads the page and learns its content.
- **Paste text** - anything: internal answers, price lists, "how we handle X". Great for knowledge that isn't public.

## Where to do it

- **During setup** - the review screen shows "What I'd love you to teach me": concrete, business-specific gaps (e.g. *your warranty policy*). Each card takes a URL or pasted text.
- **Any time after** - the same teach cards live on **Your Business**, and remaining gaps stay listed as recommendations until you teach or dismiss them.

## Good teaching habits

- Prefer teaching the **source page** over summarizing it yourself - the AI extracts what it needs.
- When a customer asks something the AI couldn't answer, teach that answer right away - it's the fastest quality loop you have.
- Wrong or outdated knowledge? Teach the corrected version; the newest knowledge wins.`,
        `ה-AI עונה רק ממה שהוא יודע. הסריקה כבר לימדה אותו הרבה (מדיניות, שאלות נפוצות שנמצאו באתר) - כך מלמדים את השאר.

## שתי דרכים ללמד

- **קישור** - עמוד מרכז עזרה, עמוד מדיניות, מדריך מוצר. GOTCHA קוראת את העמוד ולומדת את תוכנו.
- **הדבקת טקסט** - כל דבר: תשובות פנימיות, מחירונים, "איך אנחנו מטפלים ב-X". מצוין לידע שאינו פומבי.

## איפה עושים את זה

- **בהגדרה** - מסך הסקירה מציג "מה שאשמח שתלמדו אותי": פערים קונקרטיים לעסק שלכם (למשל *מדיניות האחריות*). כל כרטיס מקבל קישור או טקסט.
- **בכל שלב אחרי** - אותם כרטיסי לימוד חיים ב**העסק שלכם**, ופערים שנותרו נשארים כהמלצות עד שתלמדו או תדחו.

## הרגלי לימוד טובים

- העדיפו ללמד את **עמוד המקור** במקום לסכם בעצמכם - ה-AI מחלץ את מה שצריך.
- כשלקוח שואל משהו שה-AI לא ידע - למדו את התשובה מיד. זו לולאת האיכות המהירה ביותר שיש.
- ידע שגוי או ישן? למדו את הגרסה המתוקנת; הידע החדש גובר.`,
      ],
    },
    {
      slug: "upload-files",
      title: ["Uploading files (PDF, Word, text)", "העלאת קבצים (PDF, Word, טקסט)"],
      excerpt: ["Drop documents straight into the knowledge base - formats, limits, and processing.", "מכניסים מסמכים ישירות למאגר הידע - פורמטים, מגבלות ועיבוד."],
      keywords: ["upload", "pdf", "docx", "files", "קבצים", "העלאה", "מסמכים"],
      body: [
        `## Supported formats & limits

- **PDF, DOC/DOCX, TXT, MD, CSV**
- Up to **10MB per file**, multiple files at once.

## Where

- **During setup** - the knowledge step has a "Files" tile: click **Upload files** and select.
- **After setup** - the Knowledge section of the app; upload into your knowledge base there.

## What happens after upload

GOTCHA parses the file, splits it into searchable pieces and indexes it - usually ready within a minute. From then on the AI cites it when answering related questions.

## Tips

- Clean text beats scans: if a PDF is a photo/scan, the text may not extract - prefer the original document.
- One topic per document indexes better than one giant everything-file.
- Uploading a new version? Just upload it - and delete the outdated one in the Knowledge section so old answers can't leak.`,
        `## פורמטים ומגבלות

- **PDF, DOC/DOCX, TXT, MD, CSV**
- עד **10MB לקובץ**, אפשר כמה קבצים בבת אחת.

## איפה

- **בהגדרה** - בשלב הידע יש אריח "קבצים": לחצו **העלו קבצים** ובחרו.
- **אחרי ההגדרה** - באזור הידע באפליקציה; מעלים ישירות למאגר.

## מה קורה אחרי ההעלאה

GOTCHA מפענחת את הקובץ, מפצלת לקטעים ניתנים לחיפוש ומאנדקסת - בדרך כלל מוכן תוך דקה. מאז ה-AI נשען עליו בתשובות רלוונטיות.

## טיפים

- טקסט נקי עדיף על סריקות: אם ה-PDF הוא צילום, הטקסט עלול לא להיחלץ - העדיפו את המסמך המקורי.
- מסמך לכל נושא מתאנדקס טוב יותר מקובץ-ענק אחד.
- גרסה חדשה? פשוט העלו - ומחקו את הישנה באזור הידע כדי שתשובות ישנות לא ידלפו.`,
      ],
    },
    {
      slug: "google-drive-sync",
      title: ["Google Drive sync", "סנכרון Google Drive"],
      excerpt: ["Connect Drive, pick the files, and GOTCHA keeps them fresh - re-synced hourly.", "מחברים Drive, בוחרים קבצים, ו-GOTCHA שומרת עליהם טריים - מתעדכן כל שעה."],
      keywords: ["drive", "google", "sync", "דרייב", "סנכרון"],
      body: [
        `## Connect

1. In the setup knowledge step (or the app's Knowledge area), find the **Google Drive** tile and click **Connect**.
2. Approve read-only Drive access in the Google window.
3. Back in GOTCHA, click **Pick files**.

## Pick what to sync

A mini file browser opens - navigate folders, check the files you want the AI to know, and click **Sync**. Only what you select is read; GOTCHA has read-only access and never modifies your Drive.

## Staying fresh - automatically

Synced files are **re-checked every hour**. Edit the doc in Drive and the AI's knowledge updates on the next pass - no re-upload, no reminders. That makes Drive the best home for living documents: price lists, policies, playbooks.

## Managing the selection

Reopen the picker any time to add files. To stop syncing a file, remove it in the Knowledge area of the app.`,
        `## חיבור

1. בשלב הידע בהגדרה (או באזור הידע באפליקציה) מצאו את אריח **Google Drive** ולחצו **התחברות**.
2. אשרו גישת קריאה-בלבד בחלון של Google.
3. בחזרה ב-GOTCHA לחצו **בחרו קבצים**.

## בוחרים מה לסנכרן

נפתח דפדפן קבצים קטן - נווטו בתיקיות, סמנו את הקבצים שה-AI צריך להכיר, ולחצו **סנכרון**. רק מה שנבחר נקרא; ל-GOTCHA גישת קריאה-בלבד והיא לעולם לא משנה את ה-Drive.

## נשאר טרי - אוטומטית

קבצים מסונכרנים **נבדקים מחדש כל שעה**. ערכתם את המסמך ב-Drive - הידע של ה-AI מתעדכן בסבב הבא. בלי העלאה מחדש, בלי תזכורות. זה הופך את Drive לבית הטוב ביותר למסמכים חיים: מחירונים, מדיניות, נהלים.

## ניהול הבחירה

פתחו את הבוחר שוב בכל עת להוספת קבצים. להפסקת סנכרון של קובץ - הסירו אותו באזור הידע באפליקציה.`,
      ],
    },
  ],
};
