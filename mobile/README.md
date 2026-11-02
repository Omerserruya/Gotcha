# GOTCHA Mobile (Capacitor shell)

<div dir="rtl">

## מה יש כאן

זו "קליפה" נייטיב דקה לאפליקציית GOTCHA ל-iOS ול-Android, בנויה עם Capacitor 8.

הקליפה **לא** מכילה את אפליקציית הווב. ה-WebView טוען את אפליקציית Next.js החיה (frontend-v2) מרחוק, דרך `server.url`. כל שינוי במסכים מגיע למשתמשים ברגע שהווב עולה לאוויר, בלי לשחרר גרסה חדשה בחנויות. גרסה חדשה של האפליקציה צריך לשחרר רק כשמשנים משהו נייטיב (הרשאות, plugins, אייקון, וכו').

- נקודת הכניסה: `<origin>/he/m/inbox` (עברית היא שפת ברירת המחדל).
- מסכי המובייל בווב: `/<locale>/m/...` למשל `/he/m/inbox`, `/he/m/inbox/<id>`, `/he/m/approvals`, `/he/m/outreach`, `/he/m/customers`.
- ההתחברות (Authentik) קורית בתוך ה-WebView.
- `www/` מכיל רק עמוד גיבוי מקומי בעברית ("לא הצלחנו להתחבר" עם כפתור "נסו שוב"), שמוצג כשהטעינה מהשרת נכשלת.

| סביבה | כתובת האפליקציה | שרת ההתחברות |
|-------|------------------|---------------|
| dev   | https://dev.gotcha.co.il | auth-dev.gotcha.co.il |
| prod (ברירת מחדל) | https://app.gotcha.co.il | auth.gotcha.co.il |

זהות האפליקציה: appId `il.co.gotcha.app`, שם `GOTCHA`.

## מבנה התיקייה

```
mobile/
  capacitor.config.js        כל ההגדרות. בחירת סביבה לפי GOTCHA_ENV
  package.json               גרסאות Capacitor נעולות (exact)
  www/index.html             עמוד הגיבוי (offline). www/env.js נוצר אוטומטית ולא נכנס ל-git
  docs/
    apple-app-site-association   תבנית ל-Universal Links (iOS). לא פרוס
    assetlinks.json              תבנית ל-App Links (Android). לא פרוס
  android/                   פרויקט Android Studio
    app/src/main/AndroidManifest.xml
    app/src/main/java/il/co/gotcha/app/MainActivity.java            שמירת cookies + רישום plugin
    app/src/main/java/il/co/gotcha/app/NavigationPolicyPlugin.java  מדיניות ניווט
  ios/App/                   פרויקט Xcode (Swift Package Manager, בלי CocoaPods)
    App/AppDelegate.swift              hooks של Push
    App/MainViewController.swift       רישום ה-plugin המקומי
    App/NavigationPolicyPlugin.swift   מדיניות ניווט (מקבילה ל-Android)
    App/App.entitlements               aps-environment + associated domains
    App/Info.plist                     scheme gotcha://
```

למה `capacitor.config.js` ולא `.ts`: ה-CLI של Capacitor טוען קובץ `.ts` רק אם חבילת `typescript` מותקנת בפרויקט, והיא לא חלק מהחבילות שאושרו ל-mobile/. הקובץ עדיין מקבל בדיקת טיפוסים מלאה דרך JSDoc ו-`tsconfig.json` (checkJs).

## מה צריך (דרישות מוקדמות)

- **Node.js 22 ומעלה.** ה-CLI של Capacitor 8 מסרב לרוץ על גרסה ישנה יותר.
- **iOS:** מחשב Mac עם Xcode עדכני (16 ומעלה). אין צורך ב-CocoaPods: הפרויקט משתמש ב-Swift Package Manager, ו-Xcode מוריד את החבילות לבד.
- **Android:** Android Studio (או Android SDK + JDK 21). compileSdk/targetSdk 36, minSdk 24.
- **חשבונות:** Apple Developer Program, Google Play Console.
- **Firebase:** פרויקט Firebase עם אפליקציית Android (package `il.co.gotcha.app`), ואם שולחים גם ל-iOS דרך FCM, גם אפליקציית iOS (bundle `il.co.gotcha.app`).
- **APNs:** מפתח `.p8` מ-Apple Developer (Keys, עם Apple Push Notifications service). אם ה-backend שולח ל-iOS דרך FCM, מעלים את ה-.p8 ל-Firebase (Project settings, Cloud Messaging, Apple app configuration).

### קבצי Firebase (לא נכנסים ל-git)

| קובץ | מיקום | הערה |
|------|-------|------|
| `google-services.json` | `mobile/android/app/google-services.json` | חובה ל-Push ב-Android. בלי הקובץ הבנייה עוברת, אבל Push לא יעבוד. |
| `GoogleService-Info.plist` | `mobile/ios/App/App/GoogleService-Info.plist` | נדרש **רק** אם מוסיפים את Firebase SDK ל-iOS (ראו "Push" למטה). צריך גם לגרור אותו ל-Xcode (Add Files to "App"). |

שני הקבצים רשומים ב-`mobile/.gitignore`.

## בנייה: dev מול prod

הסביבה נבחרת בזמן `cap sync`, והכתובות נכתבות לתוך הפרויקטים הנייטיב. **אחרי כל החלפת סביבה מריצים sync מחדש.**

```bash
cd mobile
npm ci

# dev
GOTCHA_ENV=dev npx cap sync        # או: npm run sync:dev

# prod (ברירת מחדל, גם בלי המשתנה)
GOTCHA_ENV=prod npx cap sync       # או: npm run sync:prod
```

ערך אחר מ-`dev` או `prod` עוצר את הבנייה עם שגיאה, כדי שטעות הקלדה לא תשלח גרסת prod שמצביעה ל-dev.

בסביבת dev גם נפתח debugging של ה-WebView (Safari Web Inspector / chrome://inspect). ב-prod הוא סגור.

שימו לב: לשתי הסביבות אותו appId, ולכן אי אפשר להתקין dev ו-prod על אותו מכשיר במקביל.

## הרצה על מכשיר

### Android

```bash
cd mobile
GOTCHA_ENV=dev npx cap sync android
npx cap open android          # פותח את Android Studio, ומשם Run על מכשיר מחובר
# או מהטרמינל:
npx cap run android
```

### iOS (על Mac)

```bash
cd mobile
npm ci
GOTCHA_ENV=dev npx cap sync ios
npx cap open ios
```

ב-Xcode:
1. בוחרים את ה-target `App`, לשונית Signing & Capabilities, ובוחרים Team.
2. מוודאים שמופיעים Push Notifications ו-Associated Domains (הם מוגדרים כבר ב-`App.entitlements`; Xcode צריך רק Team שמאפשר אותם).
3. File, Packages, Resolve Package Versions (אם Xcode לא עשה זאת לבד).
4. בוחרים מכשיר ולוחצים Run.

## שחרור לבדיקות

### TestFlight (iOS)

1. ב-App Store Connect יוצרים אפליקציה עם bundle id `il.co.gotcha.app`.
2. מעלים מספר גרסה: `MARKETING_VERSION` (למשל 1.0.0) ו-`CURRENT_PROJECT_VERSION` (מספר בנייה, עולה בכל העלאה) ב-Xcode, תחת General.
3. `GOTCHA_ENV=prod npx cap sync ios`, ואז ב-Xcode: יעד Any iOS Device, Product, Archive.
4. ב-Organizer: Distribute App, App Store Connect, Upload.
5. ב-App Store Connect, TestFlight: מוסיפים בודקים פנימיים. בארכיון של App Store ה-`aps-environment` הופך ל-production לפי ה-provisioning profile.

### Play Internal Testing (Android)

1. יוצרים upload keystore (פעם אחת, ושומרים אותו במקום בטוח, לא ב-git):
   `keytool -genkey -v -keystore gotcha-upload.jks -keyalg RSA -keysize 2048 -validity 10000 -alias upload`
2. מעלים `versionCode` (מספר, עולה בכל העלאה) ו-`versionName` ב-`android/app/build.gradle`.
3. `GOTCHA_ENV=prod npx cap sync android`, ואז ב-Android Studio: Build, Generate Signed App Bundle (AAB).
4. ב-Play Console: יוצרים אפליקציה, Testing, Internal testing, Create release, מעלים את ה-AAB, ומוסיפים בודקים.
5. מפעילים Play App Signing. את טביעת ה-SHA-256 של מפתח החתימה של Play (וגם של מפתח ההעלאה) מכניסים ל-`assetlinks.json`.

## החוזה מול צד הווב

הקליפה לא מוסיפה לווב שום קוד. Capacitor מזריק לדף את `window.Capacitor`, ומתחתיו `window.Capacitor.Plugins.<Name>` לכל plugin נייטיב. הדף יכול לקרוא להם ישירות, בלי להתקין חבילות npm של Capacitor בווב.

### זיהוי שהדף רץ בתוך האפליקציה

```js
const cap = window.Capacitor;
const inApp = !!cap && cap.isNativePlatform && cap.isNativePlatform();
const platform = inApp ? cap.getPlatform() : 'web';   // 'ios' | 'android' | 'web'
```

ב-Android ה-bridge מוזרק רק לדפים של origin האפליקציה. ב-iOS הוא מוזרק לכל דף שנטען ב-WebView (כולל דפי ההתחברות). הדף צריך לבדוק את `inApp` לפני כל קריאה.

### Plugins שזמינים

| Plugin | שימוש מהווב |
|--------|-------------|
| `PushNotifications` | הרשאה, רישום, token, אירועי התראות |
| `App` | `appUrlOpen` (deep links), `appStateChange`, `backButton` (Android) |
| `Browser` | `Browser.open({ url })` לפתיחת קישור בדפדפן בתוך האפליקציה (SFSafariViewController / Custom Tabs) |
| `SplashScreen` | `SplashScreen.hide()` (המסך נסגר לבד אחרי 1.5 שניות גם בלי קריאה) |
| `StatusBar` / `SystemBars` | צבע וסגנון שורת הסטטוס (ברירת מחדל: רקע לבן, טקסט כהה) |

שיטות של plugins מחזירות Promise. `addListener` מחזיר אובייקט עם `remove()`. `await` עובד בכל מקרה.

### Push: מה הדף עושה

```js
const Push = window.Capacitor.Plugins.PushNotifications;

// 1. מאזינים קודם, ורק אחר כך register. אירוע registration ב-iOS לא נשמר למאזין שנרשם מאוחר.
await Push.addListener('registration', async ({ value }) => {
  await fetch('/api/...', {            // ה-endpoint של ה-backend: החלטה של צד הווב
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: value,
      platform: window.Capacitor.getPlatform(),                      // 'ios' | 'android'
      provider: window.Capacitor.getPlatform() === 'ios' ? 'apns' : 'fcm',
    }),
  });
});
await Push.addListener('registrationError', (err) => { /* לוג */ });

// 2. הרשאה (ב-Android 13+ זו הרשאת POST_NOTIFICATIONS; ב-iOS חלון המערכת)
let { receive } = await Push.checkPermissions();
if (receive === 'prompt' || receive === 'prompt-with-rationale') {
  ({ receive } = await Push.requestPermissions());
}
if (receive === 'granted') await Push.register();

// 3. התראה שהגיעה כשהאפליקציה פתוחה
await Push.addListener('pushNotificationReceived', (notification) => { /* למשל רענון ה-inbox */ });

// 4. המשתמש לחץ על התראה
await Push.addListener('pushNotificationActionPerformed', ({ actionId, notification }) => {
  const link = notification.data && notification.data.link;   // למשל '/m/inbox/<id>'
  if (typeof link === 'string' && link.startsWith('/m/')) {
    location.assign(`/${currentLocale}${link}`);              // '/he/m/inbox/<id>'
  }
});
```

**חשוב על ה-token ב-iOS:** ה-plugin מחזיר ב-iOS את ה-**APNs device token** (מחרוזת hex), לא FCM token. ב-Android הוא מחזיר FCM token. לכן יש שתי אפשרויות ל-backend:
- **(א) מומלץ ל-v1, בלי שינוי בקליפה:** iOS נשלח ישירות ל-APNs עם מפתח ה-.p8; Android נשלח דרך FCM.
- **(ב)** הכל דרך FCM: צריך להוסיף ל-iOS את FirebaseMessaging (חבילת SPM של Firebase), להמיר APNs token ל-FCM token ב-AppDelegate, ולהוסיף `GoogleService-Info.plist`. זו תלות חדשה ודורשת אישור.

לכן השדה `provider` בדוגמה למעלה.

### מבנה ה-payload של Push

התוכן שהמשתמש רואה: `title`, `body`. המידע לאפליקציה: `data.link`, נתיב **בלי** locale שמתחיל ב-`/m/`.

```jsonc
{ "title": "הודעה חדשה", "body": "דנה: היי, אפשר עזרה?", "data": { "link": "/m/inbox/<conversationId>" } }
```

איך זה נראה בכל ספק:

```jsonc
// FCM (Android), HTTP v1
{ "message": { "token": "<fcm token>",
  "notification": { "title": "...", "body": "..." },
  "data": { "link": "/m/inbox/<id>" } } }

// APNs (iOS), ישירות
{ "aps": { "alert": { "title": "...", "body": "..." }, "sound": "default" },
  "link": "/m/inbox/<id>" }
```

בשני המקרים הדף מקבל את הערך ב-`notification.data.link`. ערכי data ב-FCM הם תמיד מחרוזות. לחיצה על התראה כשהאפליקציה סגורה לגמרי עדיין מגיעה למאזין `pushNotificationActionPerformed`, בתנאי שהוא נרשם מוקדם בטעינת הדף.

### Deep links

- Scheme: `gotcha://`. למשל `gotcha://m/inbox/<id>`.
- Universal links / App links: `https://app.gotcha.co.il/he/m/...` (ו-dev), רק נתיבי `/<locale>/m/`. עובד רק אחרי פריסת הקבצים מ-`mobile/docs` (ראו למטה).
- הדף מאזין:

```js
window.Capacitor.Plugins.App.addListener('appUrlOpen', ({ url }) => {
  const u = new URL(url);
  // gotcha://m/inbox/123 -> host 'm', pathname '/inbox/123'
  const path = u.protocol === 'gotcha:' ? `/${u.host}${u.pathname}` : u.pathname.replace(/^\/(he|en)/, '');
  if (path.startsWith('/m/')) location.assign(`/${currentLocale}${path}${u.search}`);
});
```

### מדיניות ניווט (מה נשאר באפליקציה ומה נפתח בדפדפן)

| יעד | התנהגות |
|-----|---------|
| origin האפליקציה, `/<locale>/m/...` | נשאר ב-WebView |
| origin האפליקציה, `/api/auth/...` | נשאר (התחברות, callback, התנתקות) |
| שרת ההתחברות (auth / auth-dev), כל נתיב | נשאר |
| origin האפליקציה, כל נתיב אחר | נפתח בדפדפן של המערכת |
| כל host אחר | נפתח בדפדפן של המערכת |
| `target="_blank"` / `window.open` (iOS) | נפתח בדפדפן של המערכת |

המימוש: ה-host נבדק ע"י `server.allowNavigation` של Capacitor. את כלל הנתיבים מוסיף plugin נייטיב קטן, `NavigationPolicy`, שמשתמש ב-hook הרשמי של Capacitor (`shouldOverrideLoad`) בשתי הפלטפורמות. ההגדרות שלו ב-`plugins.NavigationPolicy` ב-`capacitor.config.js`.

מה הווב צריך לדעת:
1. **רק ניווט אמיתי עובר דרך הכלל.** מעבר מסכים בצד הלקוח (`router.push`, `<Link>` של Next.js, `history.pushState`) לא מגיע לנייטיב בכלל. קישור ממסך מובייל למסך שאינו `/m/` צריך להיות ניווט מלא (`location.assign`, או `<a>` רגיל בלי client routing), או `Browser.open({ url })`. אחרת המסך הדסקטופי ייפתח בתוך האפליקציה.
2. **אחרי התחברות חוזרים לנתיב `/m/`.** אם ה-callback מפנה לנתיב שאינו `/m/` (למשל `/he/home`), הוא ייפתח בדפדפן, והמשתמש ייתקע. ה-`returnTo` חייב להישאר בתוך `/<locale>/m/`.
3. **דפדפן המערכת לא משתף את ה-session.** דף שנפתח בחוץ (למשל תשלום או הגדרות) ידרוש התחברות שם.
4. אם ההתחברות תעבור פעם ל-host נוסף (למשל Google), מוסיפים אותו ל-`authHosts` ול-`allowNavigation`, או עוברים להתחברות דרך דפדפן מערכת (ASWebAuthenticationSession / Custom Tabs).

### עמוד הגיבוי (offline)

כשהטעינה של דף ראשי נכשלת, Capacitor מציג את `www/index.html`. ב-Android זה קורה **גם בשגיאת HTTP** (למשל 404 או 500 לדף ראשי), לא רק בניתוק רשת. לכן הנוסח כללי. הכפתור "נסו שוב" חוזר ל-`/he/m/inbox` של הסביבה, וגם חזרת רשת (`online`) מנסה שוב לבד. ב-Android לעמוד הזה אין גישה ל-plugins.

### שוליים בטוחים (safe area)

ב-Android 15+ האפליקציה תמיד edge-to-edge. `SystemBars.insetsHandling: 'css'` מזריק לדף משתני CSS `--safe-area-inset-top/right/bottom/left`, ו-`env(safe-area-inset-*)` עובד כש-viewport מכיל `viewport-fit=cover`. מסכי `/m/` צריכים לרפד לפיהם את הסרגל העליון והטאבים התחתונים.

## שמירת ה-session (cookies)

ה-session הוא cookie עם תאריך תפוגה מפורש, והוא צריך לשרוד סגירה של האפליקציה ואתחול של המכשיר.

- **iOS:** ה-WebView משתמש ב-`WKWebsiteDataStore.default()`, שהוא persistent. שום הגדרה לא מחליפה אותו ב-non-persistent, ו-`limitsNavigationsToAppBoundDomains` כבוי. cookie שנקבע ע"י השרת (`Set-Cookie`, HttpOnly) נשמר עד התפוגה שלו. מגבלת 7 הימים של ITP חלה רק על cookies שנכתבים מ-JavaScript.
- **Android:** `CookieManager` של ה-WebView כותב לדיסק רק מדי פעם, ו-Capacitor לא קורא ל-`flush()` (רק כש-CapacitorCookies פעיל, והוא כבוי כאן בכוונה). לכן `MainActivity` קורא ל-`CookieManager.getInstance().flush()` ב-`onPause` וב-`onStop`. בלי זה, התחברות ואחריה סגירה מהירה של האפליקציה עלולות לאבד את ה-session.
- `CapacitorCookies` ו-`CapacitorHttp` כבויים: ה-cookies נשארים במאגר של ה-WebView עצמו.

## אייקונים ומסך פתיחה

כרגע יש placeholders של Capacitor.

- **אייקון Android:** `android/app/src/main/res/mipmap-*/ic_launcher*.png` ו-`mipmap-anydpi-v26/` (adaptive). הכי פשוט: Android Studio, קליק ימני על `res`, New, Image Asset.
- **אייקון התראה Android:** אייקון לבן על רקע שקוף, למשל `res/drawable/ic_stat_gotcha.png`, ואז ב-`AndroidManifest.xml` בתוך `<application>`:
  `<meta-data android:name="com.google.firebase.messaging.default_notification_icon" android:resource="@drawable/ic_stat_gotcha" />`. בלי זה Android מציג ריבוע לבן.
- **אייקון iOS:** `ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png` (1024x1024, בלי שקיפות).
- **מסך פתיחה:** Android ב-`res/drawable*/splash.png`; iOS ב-`Assets.xcassets/Splash.imageset/`. הרקע לבן והציור ממורכז, כך שהוא נראה אותו דבר ב-RTL וב-LTR. לא לשים טקסט בתמונה.
- כלי אופציונלי ליצירת כל הגדלים ממקור אחד: `@capacitor/assets`. זו תלות חדשה, ולכן לא הותקנה.

## Universal Links ו-App Links (הגדרה, לא פרוס)

1. **iOS:** ממלאים Team ID ב-`docs/apple-app-site-association` (במקום `TEAMID`), ומגישים אותו בכתובת `https://app.gotcha.co.il/.well-known/apple-app-site-association` (וגם ב-dev): HTTPS, `Content-Type: application/json`, בלי redirect, בלי סיומת. ה-entitlements כבר כוללים `applinks:app.gotcha.co.il` ו-`applinks:dev.gotcha.co.il`.
2. **Android:** ממלאים ב-`docs/assetlinks.json` את טביעות ה-SHA-256 (Play Console, Setup, App signing), ומגישים בכתובת `https://app.gotcha.co.il/.well-known/assetlinks.json` (וגם ב-dev). ה-manifest כבר כולל `android:autoVerify="true"` לנתיבי `/he/m/` ו-`/en/m/` בשני ה-hosts.
3. בדיקה: `adb shell pm get-app-links il.co.gotcha.app` ב-Android; ב-iOS לחיצה על קישור מ-Notes.

## מה נבדק ומה לא

- נבדק על Linux: `npx cap add android`, `npx cap add ios` (SPM), `npx cap sync` ל-dev ול-prod (הכתובת הנכונה נכתבת לשני הפרויקטים), `cap doctor` ל-Android, ובדיקת טיפוסים של `capacitor.config.js`.
- **לא נבדק:** בנייה וקומפילציה בפועל (אין כאן Android SDK, JDK או Xcode), הרצה על מכשיר, Push מקצה לקצה, ו-Universal/App Links.

## מה הבעלים צריך לספק

1. Apple Developer: Team ID, יצירת App ID `il.co.gotcha.app` עם Push Notifications ו-Associated Domains, ומפתח APNs `.p8` (Key ID + Team ID).
2. Firebase: פרויקט, `google-services.json` ל-Android (ו-`GoogleService-Info.plist` רק אם בוחרים באפשרות ב' ל-iOS).
3. החלטה: Push ל-iOS ישירות דרך APNs (אפשרות א') או דרך FCM (אפשרות ב', דורש אישור לתלות Firebase ב-iOS).
4. Google Play Console: יצירת האפליקציה, upload keystore, טביעות SHA-256.
5. אייקון (1024x1024), אייקון התראה לבן ל-Android, ותמונת מסך פתיחה.
6. פריסת `apple-app-site-association` ו-`assetlinks.json` על app.gotcha.co.il ו-dev.gotcha.co.il (אחרי מילוי ה-placeholders).
7. בצד הווב: endpoint לשמירת push token, והחוזה שלמעלה (מאזינים, `returnTo` שנשאר ב-`/m/`, ניווט מלא ליציאה מ-`/m/`).
8. Mac עם Xcode ו-Node 22 לבנייה הראשונה של iOS.

</div>
