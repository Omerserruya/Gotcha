import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service | GOTCHA",
  description: "Terms of Service for GOTCHA WhatsApp Cloud Contact Center",
};

export default function TermsOfServicePage() {
  return (
    <div className="min-h-screen bg-white">
      {/* English Version */}
      <article dir="ltr" lang="en" className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12 sm:py-16">
        <header className="mb-12 border-b border-gray-200 pb-8">
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-3">Terms of Service</h1>
          <p className="text-sm text-gray-500">Last Updated: February 19, 2026</p>
          <p className="text-sm text-gray-500 mt-1">
            <span className="font-medium">[Company Name]</span> (&quot;we&quot;, &quot;us&quot;, &quot;our&quot;, or the &quot;Company&quot;)
          </p>
          <p className="text-sm text-gray-500">[Registered Address]</p>
          <p className="text-sm text-gray-500">[Website URL]</p>
        </header>

        <div className="prose prose-gray max-w-none prose-headings:text-gray-900 prose-p:text-gray-600 prose-li:text-gray-600 prose-a:text-blue-600">
          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">1. Acceptance of Terms</h2>
            <p>
              By accessing or using the GOTCHA cloud-based contact center platform (the &quot;Service&quot;), you agree to be bound by these Terms of Service (&quot;Terms&quot;). If you are using the Service on behalf of an organization, you represent and warrant that you have the authority to bind that organization to these Terms. If you do not agree to these Terms, you may not use the Service.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">2. Description of the Service</h2>
            <p>
              GOTCHA is a multi-tenant, multi-channel messaging platform that enables businesses to manage customer communications across WhatsApp, Facebook Messenger, and Instagram. The Service includes:
            </p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Agent dashboards for real-time conversation management</li>
              <li>Manager analytics and reporting tools</li>
              <li>Automated chatbot flows and message routing</li>
              <li>AI-assisted tools for agents (suggested replies, summaries, sentiment analysis)</li>
              <li>Self-service channel connection via Meta platform integrations</li>
              <li>Multi-tenant administration and user management</li>
            </ul>
            <p>
              The Service operates using Meta&apos;s WhatsApp Cloud API, Messenger Platform API, and Instagram Messaging API. Your use of these messaging channels is also subject to Meta&apos;s applicable terms and policies.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">3. Account Registration and Security</h2>
            <h3 className="text-lg font-medium mt-6 mb-3">3.1 Account Creation</h3>
            <p>
              To use the Service, you must create an account by providing accurate and complete information. Each organization operates within its own tenant, and the initial administrator is responsible for inviting and managing additional users (agents, managers).
            </p>
            <h3 className="text-lg font-medium mt-6 mb-3">3.2 Account Security</h3>
            <p>
              You are responsible for maintaining the confidentiality of your account credentials and for all activities that occur under your account. You must immediately notify us of any unauthorized use of your account or any other breach of security. We will not be liable for any loss arising from unauthorized use of your account.
            </p>
            <h3 className="text-lg font-medium mt-6 mb-3">3.3 User Roles</h3>
            <p>
              The Service supports role-based access: Administrators, Managers, and Agents. Each role has different levels of access and permissions. Administrators are responsible for assigning appropriate roles and permissions to users within their organization.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">4. Channel Connection and Meta Platform</h2>
            <h3 className="text-lg font-medium mt-6 mb-3">4.1 Connecting Channels</h3>
            <p>
              Administrators may connect messaging channels (WhatsApp, Messenger, Instagram) to their tenant through the Service&apos;s self-service interface. By connecting a channel, you authorize us to:
            </p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Receive and process incoming messages on your behalf</li>
              <li>Send messages through the connected channel on your behalf</li>
              <li>Access and store necessary platform credentials (access tokens, account IDs)</li>
              <li>Subscribe to webhook events for the connected accounts</li>
            </ul>

            <h3 className="text-lg font-medium mt-6 mb-3">4.2 Meta Platform Compliance</h3>
            <p>
              You are responsible for complying with all applicable Meta platform policies, including but not limited to the WhatsApp Business Policy, WhatsApp Commerce Policy, Facebook Platform Terms, and Instagram Platform Terms. Violations of Meta&apos;s policies may result in the suspension or termination of your connected channels by Meta, for which we bear no responsibility.
            </p>

            <h3 className="text-lg font-medium mt-6 mb-3">4.3 Disconnection</h3>
            <p>
              You may disconnect any channel at any time through the Service interface. Upon disconnection, we will unsubscribe from webhook events and clear stored credentials. Existing conversation history will be retained unless you request its deletion.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">5. Acceptable Use</h2>
            <p>You agree not to use the Service to:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Send unsolicited messages (spam) or engage in abusive messaging practices</li>
              <li>Violate any applicable law, regulation, or third-party rights</li>
              <li>Transmit any content that is illegal, harmful, threatening, abusive, harassing, defamatory, or otherwise objectionable</li>
              <li>Attempt to gain unauthorized access to the Service, other accounts, or connected systems</li>
              <li>Interfere with or disrupt the integrity or performance of the Service</li>
              <li>Use the Service for any purpose other than legitimate business communication</li>
              <li>Resell, sublicense, or redistribute the Service without our prior written consent</li>
              <li>Reverse engineer, decompile, or disassemble any part of the Service</li>
            </ul>
            <p>
              We reserve the right to suspend or terminate your account if we reasonably believe you are in violation of these terms.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">6. Data and Privacy</h2>
            <p>
              Your use of the Service is also governed by our <a href="/privacy-policy" className="text-blue-600 hover:underline">Privacy Policy</a>, which describes how we collect, use, and protect personal data. By using the Service, you acknowledge that you have read and understood our Privacy Policy.
            </p>
            <p>
              As a business customer, you are the data controller for the end-customer data processed through the Service. You are responsible for ensuring that you have the necessary legal basis for processing your customers&apos; personal data and for informing them about how their data is used.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">7. Intellectual Property</h2>
            <p>
              The Service, including all software, design, text, graphics, and other content, is the property of [Company Name] and is protected by applicable intellectual property laws. Your use of the Service does not grant you any ownership rights in the Service or its content.
            </p>
            <p>
              You retain ownership of all content and data that you submit through the Service. By using the Service, you grant us a limited license to process your content solely for the purpose of providing the Service.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">8. AI-Assisted Features</h2>
            <p>
              The Service includes AI-assisted features such as suggested replies, conversation summaries, and sentiment analysis. These features are provided as tools to assist agents and are not a substitute for human judgment. You acknowledge that:
            </p>
            <ul className="list-disc pl-6 space-y-1">
              <li>AI-generated content may not always be accurate or appropriate</li>
              <li>Agents are responsible for reviewing and approving AI-generated suggestions before sending them to customers</li>
              <li>Message content may be processed by third-party AI service providers to deliver these features</li>
              <li>We do not guarantee the accuracy, completeness, or suitability of AI-generated content</li>
            </ul>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">9. Service Availability and Support</h2>
            <h3 className="text-lg font-medium mt-6 mb-3">9.1 Availability</h3>
            <p>
              We strive to maintain high availability of the Service but do not guarantee uninterrupted access. The Service may be temporarily unavailable due to maintenance, updates, or circumstances beyond our control, including outages of third-party services (e.g., Meta platform, cloud infrastructure providers).
            </p>
            <h3 className="text-lg font-medium mt-6 mb-3">9.2 Modifications</h3>
            <p>
              We reserve the right to modify, update, or discontinue any part of the Service at any time. We will make reasonable efforts to notify you of material changes in advance.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">10. Limitation of Liability</h2>
            <p>
              To the maximum extent permitted by applicable law, [Company Name] shall not be liable for any indirect, incidental, special, consequential, or punitive damages, including but not limited to loss of profits, data, business opportunities, or goodwill, arising out of or in connection with your use of the Service.
            </p>
            <p>
              Our total aggregate liability for any claims arising under these Terms shall not exceed the total amount paid by you for the Service during the twelve (12) months preceding the event giving rise to the claim.
            </p>
            <p>
              We are not responsible for any actions taken by Meta Platforms, Inc. regarding your connected channels, including suspension, rate limiting, or termination of your WhatsApp, Messenger, or Instagram accounts.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">11. Indemnification</h2>
            <p>
              You agree to indemnify and hold harmless [Company Name], its officers, directors, employees, and agents from and against any claims, liabilities, damages, losses, and expenses arising out of or in connection with: (a) your use of the Service; (b) your violation of these Terms; (c) your violation of any applicable law or third-party rights; or (d) the content of messages sent through the Service by you or your users.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">12. Termination</h2>
            <p>
              Either party may terminate these Terms at any time by providing written notice. Upon termination:
            </p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Your access to the Service will be disabled</li>
              <li>All connected channels will be disconnected</li>
              <li>Your data will be retained for a period of 90 days, after which it will be permanently deleted unless otherwise required by law</li>
              <li>You may request an export of your data prior to termination</li>
            </ul>
            <p>
              We may immediately suspend or terminate your access to the Service if you breach these Terms, engage in prohibited activities, or if required by law.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">13. Governing Law and Disputes</h2>
            <p>
              These Terms shall be governed by and construed in accordance with the laws of [Jurisdiction], without regard to its conflict of laws provisions. Any disputes arising under these Terms shall be subject to the exclusive jurisdiction of the courts of [Jurisdiction].
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">14. Changes to These Terms</h2>
            <p>
              We may update these Terms from time to time. We will notify you of material changes by email or through the Service. Your continued use of the Service after such changes constitutes acceptance of the updated Terms. If you do not agree to the updated Terms, you must stop using the Service.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">15. Contact Us</h2>
            <p>If you have any questions about these Terms, please contact us:</p>
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-6 mt-4">
              <p><strong>[Company Name]</strong></p>
              <p className="text-gray-600">[Registered Address]</p>
              <p className="text-gray-600">Email: <strong>[Contact Email]</strong></p>
              <p className="text-gray-600">Website: [Website URL]</p>
            </div>
          </section>
        </div>
      </article>

      {/* Divider */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <hr className="border-gray-300 my-8" />
      </div>

      {/* Hebrew Version */}
      <article dir="rtl" lang="he" className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12 sm:py-16">
        <header className="mb-12 border-b border-gray-200 pb-8">
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-3">תנאי שימוש</h1>
          <p className="text-sm text-gray-500">עדכון אחרון: 19 בפברואר 2026</p>
          <p className="text-sm text-gray-500 mt-1">
            <span className="font-medium">[שם החברה]</span> (&quot;אנחנו&quot;, &quot;שלנו&quot;, או &quot;החברה&quot;)
          </p>
          <p className="text-sm text-gray-500">[כתובת רשומה]</p>
          <p className="text-sm text-gray-500">[כתובת אתר]</p>
        </header>

        <div className="prose prose-gray max-w-none prose-headings:text-gray-900 prose-p:text-gray-600 prose-li:text-gray-600 prose-a:text-blue-600">
          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">1. קבלת התנאים</h2>
            <p>
              בגישה או בשימוש בפלטפורמת מוקד השירות המבוססת ענן GOTCHA (להלן: &quot;השירות&quot;), אתם מסכימים להיות כפופים לתנאי שימוש אלה (&quot;התנאים&quot;). אם אתם משתמשים בשירות מטעם ארגון, אתם מצהירים ומתחייבים שיש לכם סמכות לחייב את הארגון בתנאים אלה. אם אינכם מסכימים לתנאים אלה, אינכם רשאים להשתמש בשירות.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">2. תיאור השירות</h2>
            <p>
              GOTCHA היא פלטפורמת תקשורת רב-ערוצית ורב-דיירית המאפשרת לעסקים לנהל תקשורת עם לקוחות דרך WhatsApp, Facebook Messenger ו-Instagram. השירות כולל:
            </p>
            <ul className="list-disc pr-6 space-y-1">
              <li>לוחות מחוונים לנציגים לניהול שיחות בזמן אמת</li>
              <li>כלי אנליטיקה ודיווח למנהלים</li>
              <li>תהליכי צ&apos;אטבוט אוטומטיים וניתוב הודעות</li>
              <li>כלי סיוע מבוססי בינה מלאכותית לנציגים (תשובות מוצעות, סיכומים, ניתוח סנטימנט)</li>
              <li>חיבור ערוצים בשירות עצמי דרך אינטגרציות פלטפורמת Meta</li>
              <li>ניהול רב-דיירי וניהול משתמשים</li>
            </ul>
            <p>
              השירות פועל באמצעות WhatsApp Cloud API, Messenger Platform API ו-Instagram Messaging API של Meta. השימוש שלכם בערוצי הודעות אלה כפוף גם לתנאים והמדיניות החלים של Meta.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">3. הרשמת חשבון ואבטחה</h2>
            <h3 className="text-lg font-medium mt-6 mb-3">3.1 יצירת חשבון</h3>
            <p>
              לשימוש בשירות, עליכם ליצור חשבון על ידי מסירת מידע מדויק ומלא. כל ארגון פועל בתוך הדייר שלו, ומנהל המערכת הראשוני אחראי להזמנת וניהול משתמשים נוספים (נציגים, מנהלים).
            </p>
            <h3 className="text-lg font-medium mt-6 mb-3">3.2 אבטחת חשבון</h3>
            <p>
              אתם אחראים לשמירה על סודיות פרטי ההזדהות של חשבונכם ולכל הפעילויות המתבצעות תחת חשבונכם. עליכם להודיע לנו מיד על כל שימוש בלתי מורשה בחשבונכם או כל פרצת אבטחה אחרת. לא נהיה אחראים להפסד הנובע משימוש בלתי מורשה בחשבונכם.
            </p>
            <h3 className="text-lg font-medium mt-6 mb-3">3.3 תפקידי משתמשים</h3>
            <p>
              השירות תומך בגישה מבוססת תפקידים: מנהלי מערכת, מנהלים ונציגים. לכל תפקיד רמות גישה והרשאות שונות. מנהלי מערכת אחראים להקצאת תפקידים והרשאות מתאימים למשתמשים בארגונם.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">4. חיבור ערוצים ופלטפורמת Meta</h2>
            <h3 className="text-lg font-medium mt-6 mb-3">4.1 חיבור ערוצים</h3>
            <p>
              מנהלי מערכת רשאים לחבר ערוצי הודעות (WhatsApp, Messenger, Instagram) לדייר שלהם דרך ממשק השירות העצמי. בחיבור ערוץ, אתם מאשרים לנו:
            </p>
            <ul className="list-disc pr-6 space-y-1">
              <li>לקבל ולעבד הודעות נכנסות מטעמכם</li>
              <li>לשלוח הודעות דרך הערוץ המחובר מטעמכם</li>
              <li>לגשת ולאחסן פרטי הזדהות נדרשים של הפלטפורמה (אסימוני גישה, מזהי חשבון)</li>
              <li>להירשם לאירועי webhook עבור החשבונות המחוברים</li>
            </ul>

            <h3 className="text-lg font-medium mt-6 mb-3">4.2 ציות לפלטפורמת Meta</h3>
            <p>
              אתם אחראים לציות לכל מדיניות פלטפורמת Meta החלה, לרבות מדיניות WhatsApp Business, מדיניות המסחר של WhatsApp, תנאי פלטפורמת Facebook ותנאי פלטפורמת Instagram. הפרות של מדיניות Meta עלולות לגרום להשעיה או סיום של הערוצים המחוברים שלכם על ידי Meta, ואיננו נושאים באחריות לכך.
            </p>

            <h3 className="text-lg font-medium mt-6 mb-3">4.3 ניתוק</h3>
            <p>
              תוכלו לנתק כל ערוץ בכל עת דרך ממשק השירות. עם הניתוק, נבטל את ההרשמה לאירועי webhook וננקה את פרטי ההזדהות המאוחסנים. היסטוריית שיחות קיימת תישמר אלא אם תבקשו את מחיקתה.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">5. שימוש מקובל</h2>
            <p>אתם מסכימים שלא להשתמש בשירות כדי:</p>
            <ul className="list-disc pr-6 space-y-1">
              <li>לשלוח הודעות בלתי רצויות (ספאם) או לעסוק בפרקטיקות הודעות פוגעניות</li>
              <li>להפר כל חוק, תקנה או זכויות צד שלישי החלים</li>
              <li>להעביר תוכן שהוא בלתי חוקי, מזיק, מאיים, פוגעני, מטריד, משמיץ או פסול בכל דרך אחרת</li>
              <li>לנסות לקבל גישה בלתי מורשית לשירות, לחשבונות אחרים או למערכות מחוברות</li>
              <li>להפריע או לשבש את שלמות או ביצועי השירות</li>
              <li>להשתמש בשירות לכל מטרה שאינה תקשורת עסקית לגיטימית</li>
              <li>למכור מחדש, להעניק רישיון משנה או להפיץ מחדש את השירות ללא הסכמתנו בכתב מראש</li>
              <li>לבצע הנדסה לאחור, לפרק או לפרק כל חלק מהשירות</li>
            </ul>
            <p>
              אנו שומרים את הזכות להשעות או לסיים את חשבונכם אם אנו סבורים באופן סביר שאתם מפרים תנאים אלה.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">6. מידע ופרטיות</h2>
            <p>
              השימוש שלכם בשירות כפוף גם ל<a href="/privacy-policy" className="text-blue-600 hover:underline">מדיניות הפרטיות</a> שלנו, המתארת כיצד אנו אוספים, משתמשים ומגנים על מידע אישי. בשימוש בשירות, אתם מאשרים שקראתם והבנתם את מדיניות הפרטיות שלנו.
            </p>
            <p>
              כלקוח עסקי, אתם בעלי השליטה במידע לקוחות הקצה המעובד דרך השירות. אתם אחראים לוודא שיש לכם את הבסיס החוקי הנדרש לעיבוד המידע האישי של לקוחותיכם ולהודיע להם על אופן השימוש במידע שלהם.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">7. קניין רוחני</h2>
            <p>
              השירות, כולל כל התוכנה, העיצוב, הטקסט, הגרפיקה ותכנים אחרים, הם רכושה של [שם החברה] ומוגנים על ידי חוקי קניין רוחני החלים. השימוש שלכם בשירות אינו מעניק לכם זכויות בעלות בשירות או בתוכנו.
            </p>
            <p>
              אתם שומרים על בעלות בכל התוכן והמידע שאתם מגישים דרך השירות. בשימוש בשירות, אתם מעניקים לנו רישיון מוגבל לעבד את התוכן שלכם אך ורק לצורך אספקת השירות.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">8. תכונות בסיוע בינה מלאכותית</h2>
            <p>
              השירות כולל תכונות בסיוע בינה מלאכותית כגון תשובות מוצעות, סיכומי שיחות וניתוח סנטימנט. תכונות אלו מסופקות ככלים לסיוע לנציגים ואינן תחליף לשיקול דעת אנושי. אתם מאשרים כי:
            </p>
            <ul className="list-disc pr-6 space-y-1">
              <li>תוכן שנוצר על ידי בינה מלאכותית עשוי שלא להיות תמיד מדויק או מתאים</li>
              <li>נציגים אחראים לבדוק ולאשר הצעות שנוצרו על ידי AI לפני שליחתן ללקוחות</li>
              <li>תוכן הודעות עשוי להיות מעובד על ידי ספקי שירותי AI צד שלישי לצורך אספקת תכונות אלו</li>
              <li>איננו מבטיחים את הדיוק, השלמות או ההתאמה של תוכן שנוצר על ידי AI</li>
            </ul>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">9. זמינות השירות ותמיכה</h2>
            <h3 className="text-lg font-medium mt-6 mb-3">9.1 זמינות</h3>
            <p>
              אנו שואפים לשמור על זמינות גבוהה של השירות אך אינם מבטיחים גישה ללא הפרעות. השירות עשוי להיות לא זמין באופן זמני עקב תחזוקה, עדכונים או נסיבות שאינן בשליטתנו, לרבות תקלות בשירותי צד שלישי (למשל, פלטפורמת Meta, ספקי תשתית ענן).
            </p>
            <h3 className="text-lg font-medium mt-6 mb-3">9.2 שינויים</h3>
            <p>
              אנו שומרים את הזכות לשנות, לעדכן או להפסיק כל חלק מהשירות בכל עת. נעשה מאמצים סבירים להודיע לכם מראש על שינויים מהותיים.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">10. הגבלת אחריות</h2>
            <p>
              במידה המרבית המותרת על פי החוק החל, [שם החברה] לא תהיה אחראית לכל נזק עקיף, מקרי, מיוחד, תוצאתי או עונשי, לרבות אך לא רק הפסד רווחים, מידע, הזדמנויות עסקיות או מוניטין, הנובע מ- או בקשר לשימוש שלכם בשירות.
            </p>
            <p>
              סך האחריות המצטברת שלנו לכל תביעה הנובעת מתנאים אלה לא תעלה על הסכום הכולל ששולם על ידכם עבור השירות במהלך שנים עשר (12) החודשים שקדמו לאירוע שגרם לתביעה.
            </p>
            <p>
              איננו אחראים לכל פעולה שתינקט על ידי Meta Platforms, Inc. בנוגע לערוצים המחוברים שלכם, לרבות השעיה, הגבלת קצב או סיום חשבונות ה-WhatsApp, Messenger או Instagram שלכם.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">11. שיפוי</h2>
            <p>
              אתם מסכימים לשפות ולהגן על [שם החברה], נושאי המשרה, הדירקטורים, העובדים והסוכנים שלה מפני כל תביעות, חבויות, נזקים, הפסדים והוצאות הנובעים מ- או בקשר ל: (א) השימוש שלכם בשירות; (ב) הפרת תנאים אלה על ידכם; (ג) הפרת כל חוק או זכויות צד שלישי על ידכם; או (ד) תוכן ההודעות שנשלחו דרך השירות על ידכם או משתמשיכם.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">12. סיום</h2>
            <p>
              כל צד רשאי לסיים תנאים אלה בכל עת על ידי מתן הודעה בכתב. עם הסיום:
            </p>
            <ul className="list-disc pr-6 space-y-1">
              <li>הגישה שלכם לשירות תושבת</li>
              <li>כל הערוצים המחוברים ינותקו</li>
              <li>המידע שלכם יישמר לתקופה של 90 יום, ולאחר מכן יימחק באופן קבוע אלא אם נדרש אחרת על פי חוק</li>
              <li>תוכלו לבקש ייצוא של המידע שלכם לפני הסיום</li>
            </ul>
            <p>
              אנו רשאים להשעות או לסיים את גישתכם לשירות באופן מיידי אם תפרו תנאים אלה, תעסקו בפעילויות אסורות, או אם נדרש על פי חוק.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">13. הדין החל וסכסוכים</h2>
            <p>
              תנאים אלה יהיו כפופים ויפורשו בהתאם לחוקי [תחום שיפוט], מבלי להתחשב בעקרונות ברירת הדין שלו. כל סכסוך הנובע מתנאים אלה יהיה כפוף לסמכות השיפוט הבלעדית של בתי המשפט של [תחום שיפוט].
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">14. שינויים בתנאים אלה</h2>
            <p>
              אנו עשויים לעדכן תנאים אלה מעת לעת. נודיע לכם על שינויים מהותיים באמצעות דוא&quot;ל או דרך השירות. המשך השימוש שלכם בשירות לאחר שינויים אלו מהווה קבלת התנאים המעודכנים. אם אינכם מסכימים לתנאים המעודכנים, עליכם להפסיק את השימוש בשירות.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">15. צרו קשר</h2>
            <p>אם יש לכם שאלות בנוגע לתנאים אלה, אנא פנו אלינו:</p>
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-6 mt-4">
              <p><strong>[שם החברה]</strong></p>
              <p className="text-gray-600">[כתובת רשומה]</p>
              <p className="text-gray-600">דוא&quot;ל: <strong>[דוא&quot;ל ליצירת קשר]</strong></p>
              <p className="text-gray-600">אתר: [כתובת אתר]</p>
            </div>
          </section>
        </div>
      </article>

      {/* Footer */}
      <footer className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8 border-t border-gray-200">
        <p className="text-center text-xs text-gray-400">
          &copy; {new Date().getFullYear()} [Company Name]. All rights reserved.
        </p>
      </footer>
    </div>
  );
}
