import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy | GOTCHA",
  description: "Privacy Policy for GOTCHA WhatsApp Cloud Contact Center",
};

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-white">
      {/* English Version */}
      <article dir="ltr" lang="en" className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12 sm:py-16">
        <header className="mb-12 border-b border-gray-200 pb-8">
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-3">Privacy Policy</h1>
          <p className="text-sm text-gray-500">Last Updated: February 15, 2026</p>
          <p className="text-sm text-gray-500 mt-1">
            <span className="font-medium">[Company Name]</span> (&quot;we&quot;, &quot;us&quot;, &quot;our&quot;, or the &quot;Company&quot;)
          </p>
          <p className="text-sm text-gray-500">[Registered Address]</p>
          <p className="text-sm text-gray-500">[Website URL]</p>
        </header>

        <div className="prose prose-gray max-w-none prose-headings:text-gray-900 prose-p:text-gray-600 prose-li:text-gray-600 prose-a:text-blue-600">
          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">1. Introduction</h2>
            <p>
              This Privacy Policy describes how [Company Name] collects, uses, stores, and protects personal data when you use our cloud-based WhatsApp contact center platform (the &quot;Service&quot;). The Service provides businesses with a multi-channel messaging solution that includes agent dashboards, manager analytics, message routing, AI-assisted agent tools, and chatbot automation, all powered by the WhatsApp Cloud API provided by Meta Platforms, Inc.
            </p>
            <p>
              We are committed to protecting the privacy and security of all personal data processed through our platform. This policy applies to all users of our Service, including end-customers who communicate via WhatsApp, agents, managers, and administrators.
            </p>
            <p>
              By using our Service, you acknowledge that you have read and understood this Privacy Policy. If you are a business customer using our platform, you are responsible for ensuring that your own end-users are informed about how their data is processed.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">2. Data We Collect</h2>
            <p>We collect and process the following categories of personal data:</p>

            <h3 className="text-lg font-medium mt-6 mb-3">2.1 End-Customer Data (WhatsApp Users)</h3>
            <ul className="list-disc pl-6 space-y-1">
              <li>Phone numbers (as provided via WhatsApp)</li>
              <li>WhatsApp display names and profile information</li>
              <li>Message content (text, images, documents, audio, video)</li>
              <li>Message metadata (timestamps, delivery status, read receipts)</li>
              <li>Conversation history and interaction records</li>
            </ul>

            <h3 className="text-lg font-medium mt-6 mb-3">2.2 Agent and Administrator Data</h3>
            <ul className="list-disc pl-6 space-y-1">
              <li>Full name, email address, and role designation</li>
              <li>Authentication credentials (securely hashed passwords)</li>
              <li>Activity logs (login times, conversation assignments, actions taken)</li>
              <li>Performance metrics (response times, resolution times, conversation volumes)</li>
            </ul>

            <h3 className="text-lg font-medium mt-6 mb-3">2.3 Business and Tenant Data</h3>
            <ul className="list-disc pl-6 space-y-1">
              <li>Organization name and identifier</li>
              <li>WhatsApp Business Account configuration data</li>
              <li>Chatbot flow definitions and automation configurations</li>
              <li>Auto-greeting templates and knowledge base content</li>
            </ul>

            <h3 className="text-lg font-medium mt-6 mb-3">2.4 Technical and Analytics Data</h3>
            <ul className="list-disc pl-6 space-y-1">
              <li>Aggregated conversation volume and traffic patterns</li>
              <li>Queue depth and wait time statistics</li>
              <li>System performance metrics</li>
              <li>Browser type, IP address, and device information (for platform access)</li>
            </ul>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">3. How We Use Your Data</h2>
            <p>We process personal data for the following purposes:</p>
            <ul className="list-disc pl-6 space-y-2">
              <li><strong>Service Delivery:</strong> To facilitate messaging between businesses and their customers via WhatsApp, including message routing, queue management, and conversation assignment.</li>
              <li><strong>AI-Assisted Features:</strong> To generate suggested replies, conversation summaries, and sentiment analysis for agents using artificial intelligence service providers. Message content may be processed by AI systems to provide these features.</li>
              <li><strong>Chatbot Automation:</strong> To execute automated conversation flows configured by business administrators, including welcome messages, department routing, and interactive menus.</li>
              <li><strong>Analytics and Reporting:</strong> To provide managers and administrators with operational insights, including agent performance metrics, conversation volumes, and response time analytics.</li>
              <li><strong>Account Management:</strong> To authenticate users, manage roles and permissions, and maintain platform security.</li>
              <li><strong>Service Improvement:</strong> To monitor system performance, identify issues, and improve the reliability and functionality of our platform.</li>
              <li><strong>Legal Compliance:</strong> To comply with applicable laws, regulations, and legal processes.</li>
            </ul>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">4. Legal Basis for Processing</h2>
            <p>We process personal data under the following legal bases in accordance with the General Data Protection Regulation (GDPR) and applicable data protection laws:</p>
            <ul className="list-disc pl-6 space-y-2">
              <li><strong>Contractual Necessity:</strong> Processing is necessary for the performance of our contract with business customers to provide the Service.</li>
              <li><strong>Legitimate Interest:</strong> Processing is necessary for our legitimate interests in operating, maintaining, and improving the Service, provided these interests are not overridden by the data subject&apos;s rights.</li>
              <li><strong>Consent:</strong> Where required, we obtain consent for specific processing activities. End-customers consent to data processing by initiating or continuing communication via WhatsApp with a business that uses our platform.</li>
              <li><strong>Legal Obligation:</strong> Processing is necessary to comply with legal obligations to which we are subject.</li>
            </ul>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">5. Data Sharing and Third-Party Services</h2>
            <p>We may share personal data with the following categories of third parties:</p>
            <ul className="list-disc pl-6 space-y-2">
              <li><strong>Meta Platforms, Inc.:</strong> Message content and phone numbers are transmitted via the WhatsApp Cloud API, which is operated by Meta. Meta&apos;s use of this data is governed by its own privacy policies and the WhatsApp Business Terms of Service.</li>
              <li><strong>Cloud Infrastructure Providers:</strong> We use reputable cloud hosting services to store and process data. All data is stored in secure, professionally managed data centers.</li>
              <li><strong>AI Service Providers:</strong> Message content may be processed by third-party AI service providers to generate suggestions, summaries, and analytical insights for agents. We select providers that maintain appropriate data protection standards.</li>
              <li><strong>Business Customers (Tenants):</strong> As a multi-tenant platform, the business customer that operates the WhatsApp number has access to conversation data, agent performance metrics, and analytics for their own tenant.</li>
            </ul>
            <p>
              We do not sell personal data to third parties. We do not share data across tenants. Each business customer&apos;s data is logically isolated from other customers on our platform.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">6. Data Retention</h2>
            <p>We retain personal data in accordance with the following principles:</p>
            <ul className="list-disc pl-6 space-y-2">
              <li><strong>Conversation Data:</strong> Message content and conversation records are retained for the duration of the business customer&apos;s subscription, plus a reasonable period thereafter (not exceeding 90 days) to facilitate service continuity and account recovery.</li>
              <li><strong>Agent and Administrator Data:</strong> Account data is retained for the duration of the user&apos;s active account. Upon account deletion, personal data is removed within 30 days, except where retention is required for legal or audit purposes.</li>
              <li><strong>Analytics Data:</strong> Aggregated and anonymized analytics data may be retained for up to 24 months for service improvement purposes.</li>
              <li><strong>Backup Data:</strong> Encrypted backups may retain data for up to 90 days beyond the primary deletion date for disaster recovery purposes.</li>
            </ul>
            <p>
              Business customers may request earlier deletion of their data by contacting us at privacy@gotcha.co.il.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">7. Data Security</h2>
            <p>We implement appropriate technical and organizational measures to protect personal data, including:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Encryption of data in transit using TLS/SSL protocols</li>
              <li>Authentication handled by a dedicated identity provider, so we never store your password. Sign-in supports two-factor authentication and passkeys</li>
              <li>Role-based access controls with principle of least privilege</li>
              <li>Multi-tenant data isolation at the application and database levels</li>
              <li>Regular security assessments and vulnerability monitoring</li>
              <li>Rate limiting and abuse prevention mechanisms</li>
              <li>Webhook signature verification for WhatsApp API communications</li>
              <li>Secure infrastructure deployed in professionally managed cloud environments</li>
            </ul>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">8. Your Rights</h2>
            <p>Under applicable data protection laws, including the GDPR, you have the following rights:</p>
            <ul className="list-disc pl-6 space-y-2">
              <li><strong>Right of Access:</strong> You may request a copy of the personal data we hold about you.</li>
              <li><strong>Right to Rectification:</strong> You may request that we correct inaccurate or incomplete personal data.</li>
              <li><strong>Right to Erasure:</strong> You may request the deletion of your personal data, subject to legal retention obligations.</li>
              <li><strong>Right to Restrict Processing:</strong> You may request that we limit the processing of your personal data in certain circumstances.</li>
              <li><strong>Right to Data Portability:</strong> You may request to receive your personal data in a structured, commonly used, and machine-readable format.</li>
              <li><strong>Right to Object:</strong> You may object to the processing of your personal data where we rely on legitimate interests.</li>
              <li><strong>Right to Withdraw Consent:</strong> Where processing is based on consent, you may withdraw your consent at any time.</li>
            </ul>
            <p>
              To exercise any of these rights, please contact us at <strong>privacy@gotcha.co.il</strong>. We will respond to your request within 30 days, as required by applicable law.
            </p>
            <p>
              If you are an end-customer who communicated with a business via WhatsApp, please direct your data rights requests to the business you communicated with, as they are the data controller for your conversation data. We will cooperate with the business to fulfill such requests.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">9. Data Deletion Instructions</h2>
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-6">
              <p className="font-medium text-gray-900 mb-3">How to Request Deletion of Your Data</p>
              <p>If you wish to have your data deleted from our system, you may do so through any of the following methods:</p>
              <ol className="list-decimal pl-6 space-y-2 mt-3">
                <li>
                  <strong>Email Request:</strong> Send an email to <strong>privacy@gotcha.co.il</strong> with the subject line &quot;Data Deletion Request&quot;. Include the phone number or email address associated with your data so we can locate and remove your records.
                </li>
                <li>
                  <strong>Business Contact:</strong> Contact the business you communicated with via WhatsApp and request that they delete your conversation data through their administrator dashboard.
                </li>
                <li>
                  <strong>Administrator Self-Service:</strong> Business administrators can delete conversations, agent accounts, and associated data directly through the platform&apos;s management interface.
                </li>
              </ol>
              <p className="mt-4">
                Upon receiving a valid deletion request, we will:
              </p>
              <ul className="list-disc pl-6 space-y-1 mt-2">
                <li>Delete or anonymize all personal data associated with the request within <strong>30 days</strong></li>
                <li>Remove the data from all active systems and databases</li>
                <li>Ensure the data is purged from backups within <strong>90 days</strong></li>
                <li>Confirm the deletion to the requestor via email</li>
              </ul>
              <p className="mt-4 text-sm text-gray-500">
                Note: Certain data may be retained where required by applicable law, regulation, or legitimate legal claims.
              </p>
            </div>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">10. International Data Transfers</h2>
            <p>
              Our Service operates using cloud infrastructure that may process data in various geographic locations. Where personal data is transferred outside the European Economic Area (EEA), we ensure appropriate safeguards are in place, such as Standard Contractual Clauses (SCCs) approved by the European Commission, or reliance on an adequacy decision.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">11. Children&apos;s Privacy</h2>
            <p>
              Our Service is not directed at individuals under the age of 16. We do not knowingly collect personal data from children. If we become aware that we have inadvertently collected personal data from a child, we will take steps to delete such data promptly.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">12. Changes to This Policy</h2>
            <p>
              We may update this Privacy Policy from time to time to reflect changes in our practices, technologies, legal requirements, or other factors. We will notify business customers of material changes via email or through the platform. The &quot;Last Updated&quot; date at the top of this policy indicates when it was last revised. Continued use of the Service after such changes constitutes acceptance of the updated policy.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">13. Contact Us</h2>
            <p>If you have any questions, concerns, or requests regarding this Privacy Policy or our data practices, please contact us:</p>
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-6 mt-4">
              <p><strong>[Company Name]</strong></p>
              <p className="text-gray-600">[Registered Address]</p>
              <p className="text-gray-600">Email: <strong>privacy@gotcha.co.il</strong></p>
              <p className="text-gray-600">Website: [Website URL]</p>
            </div>
            <p className="mt-4">
              You also have the right to lodge a complaint with your local data protection supervisory authority if you believe that our processing of your personal data violates applicable data protection laws.
            </p>
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
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-3">מדיניות פרטיות</h1>
          <p className="text-sm text-gray-500">עדכון אחרון: 15 בפברואר 2026</p>
          <p className="text-sm text-gray-500 mt-1">
            <span className="font-medium">[שם החברה]</span> (&quot;אנחנו&quot;, &quot;שלנו&quot;, או &quot;החברה&quot;)
          </p>
          <p className="text-sm text-gray-500">[כתובת רשומה]</p>
          <p className="text-sm text-gray-500">[כתובת אתר]</p>
        </header>

        <div className="prose prose-gray max-w-none prose-headings:text-gray-900 prose-p:text-gray-600 prose-li:text-gray-600 prose-a:text-blue-600">
          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">1. מבוא</h2>
            <p>
              מדיניות פרטיות זו מתארת כיצד [שם החברה] אוספת, משתמשת, מאחסנת ומגנה על מידע אישי בעת השימוש בפלטפורמת מוקד השירות שלנו המבוססת על WhatsApp Cloud API (להלן: &quot;השירות&quot;). השירות מספק לעסקים פתרון תקשורת רב-ערוצי הכולל לוחות מחוונים לנציגים, ניתוח נתונים למנהלים, ניתוב הודעות, כלי סיוע מבוססי בינה מלאכותית, ואוטומציה של צ&apos;אטבוטים &mdash; הכל באמצעות WhatsApp Cloud API של Meta Platforms, Inc.
            </p>
            <p>
              אנו מחויבים להגנה על הפרטיות והאבטחה של כל המידע האישי המעובד דרך הפלטפורמה שלנו. מדיניות זו חלה על כל משתמשי השירות, לרבות לקוחות קצה המתקשרים דרך WhatsApp, נציגים, מנהלים ומנהלי מערכת.
            </p>
            <p>
              בשימוש בשירות שלנו, אתם מאשרים שקראתם והבנתם מדיניות פרטיות זו. אם אתם לקוח עסקי המשתמש בפלטפורמה שלנו, אתם אחראים לוודא שמשתמשי הקצה שלכם מודעים לאופן עיבוד המידע שלהם.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">2. מידע שאנו אוספים</h2>
            <p>אנו אוספים ומעבדים את קטגוריות המידע האישי הבאות:</p>

            <h3 className="text-lg font-medium mt-6 mb-3">2.1 נתוני לקוחות קצה (משתמשי WhatsApp)</h3>
            <ul className="list-disc pr-6 space-y-1">
              <li>מספרי טלפון (כפי שסופקו דרך WhatsApp)</li>
              <li>שמות תצוגה ומידע פרופיל של WhatsApp</li>
              <li>תוכן הודעות (טקסט, תמונות, מסמכים, אודיו, וידאו)</li>
              <li>מטא-דאטה של הודעות (חותמות זמן, סטטוס משלוח, אישורי קריאה)</li>
              <li>היסטוריית שיחות ורישומי אינטראקציה</li>
            </ul>

            <h3 className="text-lg font-medium mt-6 mb-3">2.2 נתוני נציגים ומנהלי מערכת</h3>
            <ul className="list-disc pr-6 space-y-1">
              <li>שם מלא, כתובת דוא&quot;ל, וייעוד תפקיד</li>
              <li>פרטי הזדהות (סיסמאות מוצפנות באופן מאובטח)</li>
              <li>יומני פעילות (זמני התחברות, שיוך שיחות, פעולות שבוצעו)</li>
              <li>מדדי ביצועים (זמני תגובה, זמני פתרון, נפח שיחות)</li>
            </ul>

            <h3 className="text-lg font-medium mt-6 mb-3">2.3 נתוני עסק ודייר (Tenant)</h3>
            <ul className="list-disc pr-6 space-y-1">
              <li>שם ומזהה הארגון</li>
              <li>נתוני תצורת חשבון WhatsApp Business</li>
              <li>הגדרות תהליכי צ&apos;אטבוט ואוטומציה</li>
              <li>תבניות ברכה אוטומטית ותוכן בסיס ידע</li>
            </ul>

            <h3 className="text-lg font-medium mt-6 mb-3">2.4 נתונים טכניים ואנליטיים</h3>
            <ul className="list-disc pr-6 space-y-1">
              <li>נפח שיחות מצטבר ודפוסי תנועה</li>
              <li>סטטיסטיקות עומק תור וזמני המתנה</li>
              <li>מדדי ביצועי מערכת</li>
              <li>סוג דפדפן, כתובת IP ומידע על המכשיר (לגישה לפלטפורמה)</li>
            </ul>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">3. כיצד אנו משתמשים במידע שלכם</h2>
            <p>אנו מעבדים מידע אישי למטרות הבאות:</p>
            <ul className="list-disc pr-6 space-y-2">
              <li><strong>אספקת שירות:</strong> לאפשר תקשורת בהודעות בין עסקים ללקוחותיהם דרך WhatsApp, כולל ניתוב הודעות, ניהול תורים ושיוך שיחות.</li>
              <li><strong>תכונות בסיוע בינה מלאכותית:</strong> ליצירת תשובות מוצעות, סיכומי שיחות וניתוח סנטימנט לנציגים באמצעות ספקי שירותי בינה מלאכותית. תוכן הודעות עשוי להיות מעובד על ידי מערכות AI לצורך מתן תכונות אלו.</li>
              <li><strong>אוטומציית צ&apos;אטבוט:</strong> להפעלת תהליכי שיחה אוטומטיים שהוגדרו על ידי מנהלי העסק, כולל הודעות ברוכים הבאים, ניתוב למחלקות ותפריטים אינטראקטיביים.</li>
              <li><strong>אנליטיקה ודיווח:</strong> לספק למנהלים תובנות תפעוליות, כולל מדדי ביצועי נציגים, נפחי שיחות וניתוח זמני תגובה.</li>
              <li><strong>ניהול חשבון:</strong> לאימות משתמשים, ניהול תפקידים והרשאות, ושמירה על אבטחת הפלטפורמה.</li>
              <li><strong>שיפור השירות:</strong> לניטור ביצועי המערכת, זיהוי בעיות ושיפור האמינות והפונקציונליות של הפלטפורמה.</li>
              <li><strong>ציות חוקי:</strong> לציות לחוקים, תקנות והליכים משפטיים החלים.</li>
            </ul>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">4. בסיס חוקי לעיבוד</h2>
            <p>אנו מעבדים מידע אישי על פי הבסיסים החוקיים הבאים בהתאם לתקנת הגנת המידע הכללית (GDPR) וחוקי הגנת המידע החלים:</p>
            <ul className="list-disc pr-6 space-y-2">
              <li><strong>נחיצות חוזית:</strong> העיבוד נחוץ לביצוע החוזה שלנו עם לקוחות עסקיים לאספקת השירות.</li>
              <li><strong>אינטרס לגיטימי:</strong> העיבוד נחוץ לאינטרסים הלגיטימיים שלנו בהפעלה, תחזוקה ושיפור השירות, בתנאי שאינטרסים אלו אינם עולים על זכויות נושא המידע.</li>
              <li><strong>הסכמה:</strong> במקרים הנדרשים, אנו מקבלים הסכמה לפעילויות עיבוד ספציפיות. לקוחות קצה מסכימים לעיבוד מידע על ידי יזימת או המשך תקשורת דרך WhatsApp עם עסק המשתמש בפלטפורמה שלנו.</li>
              <li><strong>חובה חוקית:</strong> העיבוד נחוץ לציות לחובות חוקיות החלות עלינו.</li>
            </ul>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">5. שיתוף מידע ושירותי צד שלישי</h2>
            <p>אנו עשויים לשתף מידע אישי עם קטגוריות הצדדים השלישיים הבאות:</p>
            <ul className="list-disc pr-6 space-y-2">
              <li><strong>Meta Platforms, Inc.:</strong> תוכן הודעות ומספרי טלפון מועברים דרך WhatsApp Cloud API, המופעל על ידי Meta. השימוש של Meta במידע זה כפוף למדיניות הפרטיות שלה ולתנאי השירות של WhatsApp Business.</li>
              <li><strong>ספקי תשתית ענן:</strong> אנו משתמשים בשירותי אירוח ענן מוכרים לאחסון ועיבוד מידע. כל המידע מאוחסן במרכזי נתונים מאובטחים ומנוהלים באופן מקצועי.</li>
              <li><strong>ספקי שירותי בינה מלאכותית:</strong> תוכן הודעות עשוי להיות מעובד על ידי ספקי שירותי AI צד שלישי ליצירת הצעות, סיכומים ותובנות אנליטיות לנציגים. אנו בוחרים ספקים השומרים על תקני הגנת מידע מתאימים.</li>
              <li><strong>לקוחות עסקיים (דיירים):</strong> כפלטפורמה רב-דיירית, ללקוח העסקי המפעיל את מספר ה-WhatsApp יש גישה לנתוני שיחות, מדדי ביצועי נציגים ואנליטיקה עבור הדייר שלו.</li>
            </ul>
            <p>
              אנו לא מוכרים מידע אישי לצדדים שלישיים. אנו לא משתפים מידע בין דיירים. המידע של כל לקוח עסקי מבודד באופן לוגי מלקוחות אחרים בפלטפורמה שלנו.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">6. שמירת מידע</h2>
            <p>אנו שומרים מידע אישי בהתאם לעקרונות הבאים:</p>
            <ul className="list-disc pr-6 space-y-2">
              <li><strong>נתוני שיחות:</strong> תוכן הודעות ורישומי שיחות נשמרים למשך תקופת המנוי של הלקוח העסקי, בתוספת תקופה סבירה לאחר מכן (לא יותר מ-90 יום) לאפשר המשכיות שירות ושחזור חשבון.</li>
              <li><strong>נתוני נציגים ומנהלי מערכת:</strong> נתוני חשבון נשמרים למשך תקופת החשבון הפעיל. עם מחיקת החשבון, מידע אישי מוסר תוך 30 יום, למעט במקרים בהם נדרשת שמירה לצרכים משפטיים או ביקורת.</li>
              <li><strong>נתוני אנליטיקה:</strong> נתוני אנליטיקה מצטברים ואנונימיים עשויים להישמר עד 24 חודשים לצרכי שיפור השירות.</li>
              <li><strong>גיבויים:</strong> גיבויים מוצפנים עשויים לשמור מידע עד 30 יום מעבר לתאריך המחיקה הראשי לצרכי התאוששות מאסון.</li>
            </ul>
            <p>
              לקוחות עסקיים רשאים לבקש מחיקה מוקדמת של המידע שלהם על ידי פנייה אלינו בכתובת [דוא&quot;ל ליצירת קשר].
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">7. אבטחת מידע</h2>
            <p>אנו מיישמים אמצעים טכניים וארגוניים מתאימים להגנה על מידע אישי, כולל:</p>
            <ul className="list-disc pr-6 space-y-1">
              <li>הצפנת מידע בזמן העברה באמצעות פרוטוקולי TLS/SSL</li>
              <li>ההזדהות מתבצעת בשירות זהויות ייעודי, ולכן הסיסמה שלכם לעולם לא נשמרת אצלנו. ההתחברות תומכת באימות דו-שלבי ובמפתחות גישה</li>
              <li>בקרות גישה מבוססות תפקיד עם עיקרון ההרשאה המינימלית</li>
              <li>בידוד מידע רב-דיירי ברמת היישום ובסיס הנתונים</li>
              <li>הערכות אבטחה סדירות וניטור פגיעויות</li>
              <li>הגבלת קצב ומנגנוני מניעת שימוש לרעה</li>
              <li>אימות חתימת Webhook עבור תקשורת WhatsApp API</li>
              <li>תשתית מאובטחת שנפרסת בסביבות ענן מנוהלות באופן מקצועי</li>
            </ul>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">8. הזכויות שלכם</h2>
            <p>על פי חוקי הגנת המידע החלים, לרבות ה-GDPR, עומדות לכם הזכויות הבאות:</p>
            <ul className="list-disc pr-6 space-y-2">
              <li><strong>זכות גישה:</strong> תוכלו לבקש עותק של המידע האישי שאנו מחזיקים עליכם.</li>
              <li><strong>זכות תיקון:</strong> תוכלו לבקש שנתקן מידע אישי שגוי או חסר.</li>
              <li><strong>זכות מחיקה:</strong> תוכלו לבקש את מחיקת המידע האישי שלכם, בכפוף לחובות שמירה חוקיות.</li>
              <li><strong>זכות הגבלת עיבוד:</strong> תוכלו לבקש שנגביל את עיבוד המידע האישי שלכם בנסיבות מסוימות.</li>
              <li><strong>זכות ניידות מידע:</strong> תוכלו לבקש לקבל את המידע האישי שלכם בפורמט מובנה, נפוץ וקריא-מכונה.</li>
              <li><strong>זכות התנגדות:</strong> תוכלו להתנגד לעיבוד המידע האישי שלכם כאשר אנו מסתמכים על אינטרסים לגיטימיים.</li>
              <li><strong>זכות חזרה מהסכמה:</strong> כאשר העיבוד מבוסס על הסכמה, תוכלו לחזור בכם מההסכמה בכל עת.</li>
            </ul>
            <p>
              למימוש כל אחת מזכויות אלו, אנא פנו אלינו בכתובת <strong>[דוא&quot;ל ליצירת קשר]</strong>. נענה לבקשתכם תוך 30 יום, כנדרש בחוק החל.
            </p>
            <p>
              אם אתם לקוח קצה שתקשר עם עסק דרך WhatsApp, אנא הפנו את בקשות זכויות המידע שלכם לעסק שאיתו תקשרתם, שכן הוא בעל השליטה במידע השיחות שלכם. נשתף פעולה עם העסק למילוי בקשות כאלה.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">9. הוראות מחיקת מידע</h2>
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-6">
              <p className="font-medium text-gray-900 mb-3">כיצד לבקש מחיקת המידע שלכם</p>
              <p>אם ברצונכם שהמידע שלכם יימחק מהמערכת שלנו, תוכלו לעשות זאת באמצעות אחת מהדרכים הבאות:</p>
              <ol className="list-decimal pr-6 space-y-2 mt-3">
                <li>
                  <strong>בקשה בדוא&quot;ל:</strong> שלחו דוא&quot;ל לכתובת <strong>[דוא&quot;ל ליצירת קשר]</strong> עם נושא &quot;בקשת מחיקת מידע&quot;. כללו את מספר הטלפון או כתובת הדוא&quot;ל המשויכים למידע שלכם כדי שנוכל לאתר ולהסיר את הרשומות שלכם.
                </li>
                <li>
                  <strong>פנייה לעסק:</strong> צרו קשר עם העסק שאיתו תקשרתם דרך WhatsApp ובקשו שימחק את נתוני השיחה שלכם דרך לוח המחוונים של מנהל המערכת.
                </li>
                <li>
                  <strong>שירות עצמי למנהלים:</strong> מנהלי מערכת עסקיים יכולים למחוק שיחות, חשבונות נציגים ומידע משויך ישירות דרך ממשק הניהול של הפלטפורמה.
                </li>
              </ol>
              <p className="mt-4">
                עם קבלת בקשת מחיקה תקפה, אנו:
              </p>
              <ul className="list-disc pr-6 space-y-1 mt-2">
                <li>נמחק או ננטרל את כל המידע האישי הקשור לבקשה תוך <strong>30 יום</strong></li>
                <li>נסיר את המידע מכל המערכות ובסיסי הנתונים הפעילים</li>
                <li>נוודא שהמידע נמחק מגיבויים תוך <strong>90 יום</strong></li>
                <li>נאשר את המחיקה למבקש באמצעות דוא&quot;ל</li>
              </ul>
              <p className="mt-4 text-sm text-gray-500">
                הערה: מידע מסוים עשוי להישמר כאשר הדבר נדרש על פי חוק, תקנה או תביעות משפטיות לגיטימיות.
              </p>
            </div>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">10. העברות מידע בינלאומיות</h2>
            <p>
              השירות שלנו פועל באמצעות תשתית ענן שעשויה לעבד מידע במיקומים גיאוגרפיים שונים. כאשר מידע אישי מועבר מחוץ לאזור הכלכלי האירופי (EEA), אנו מוודאים שקיימים אמצעי הגנה מתאימים, כגון סעיפים חוזיים סטנדרטיים (SCCs) שאושרו על ידי הנציבות האירופית, או הסתמכות על החלטת הלימה.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">11. פרטיות ילדים</h2>
            <p>
              השירות שלנו אינו מיועד לאנשים מתחת לגיל 16. איננו אוספים ביודעין מידע אישי מילדים. אם נגלה שאספנו בשוגג מידע אישי מילד, ננקוט צעדים למחיקת מידע זה באופן מידי.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">12. שינויים במדיניות זו</h2>
            <p>
              אנו עשויים לעדכן מדיניות פרטיות זו מעת לעת כדי לשקף שינויים בפרקטיקות שלנו, בטכנולוגיות, בדרישות חוקיות או בגורמים אחרים. נודיע ללקוחות עסקיים על שינויים מהותיים באמצעות דוא&quot;ל או דרך הפלטפורמה. התאריך &quot;עדכון אחרון&quot; בראש מדיניות זו מציין מתי עודכנה לאחרונה. המשך השימוש בשירות לאחר שינויים אלו מהווה קבלת המדיניות המעודכנת.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4">13. צרו קשר</h2>
            <p>אם יש לכם שאלות, חששות או בקשות בנוגע למדיניות פרטיות זו או לנוהלי המידע שלנו, אנא פנו אלינו:</p>
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-6 mt-4">
              <p><strong>[שם החברה]</strong></p>
              <p className="text-gray-600">[כתובת רשומה]</p>
              <p className="text-gray-600">דוא&quot;ל: <strong>[דוא&quot;ל ליצירת קשר]</strong></p>
              <p className="text-gray-600">אתר: [כתובת אתר]</p>
            </div>
            <p className="mt-4">
              כמו כן, עומדת לכם הזכות להגיש תלונה לרשות הפיקוח להגנת מידע המקומית שלכם אם אתם סבורים שעיבוד המידע האישי שלכם מפר את חוקי הגנת המידע החלים.
            </p>
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
