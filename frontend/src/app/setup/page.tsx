"use client";

// Onboarding — AI-first, two-gate activation.
//
//   GATE 1  "We understood your business like this"  (auto website crawl →
//           editable confirmation card)
//   GATE 2  "Connect your main business system"      (ONE source of truth:
//           HubSpot / Salesforce / Zoho / Shopify → OAuth)
//
// Connecting one system IS the activation event. Everything else is
// non-linear in the Setup Hub afterwards. There is no fixed multi-step
// wizard beyond these two gates.

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  analyzeBusinessDomain,
  completeOnboarding,
  getOnboardingStatus,
  saveBusinessProfile,
  setCoreSystem,
  initIntegrationOAuth,
  connectApiKeyIntegration,
  airtableListBasesOnboarding,
  airtableListTablesOnboarding,
  airtableListFieldsOnboarding,
  saveAirtableMapping,
  type CoreSystemSlug,
  type AirtableMeta,
  type AirtableField,
} from "@/lib/api";

// After setup completes, land in the inbox — onboarding continues via the
// sidebar mission panel, not a dedicated home page.
const SETUP_HUB = "/conversations";

type Phase = "loading" | "understanding" | "connect" | "airtable_mapping" | "activating";

interface Understanding {
  name: string;
  industry: string;
  country: string;
  language: string;
  description: string;
}

const LANGS = [
  { value: "en", label: "English" },
  { value: "he", label: "עברית" },
  { value: "ar", label: "العربية" },
];

const SYSTEMS: Array<{
  slug: CoreSystemSlug;
  name: string;
  group: "CRM" | "Store" | "Database";
  value: [string, string]; // [en, he]
  logo: string;
}> = [
  { slug: "hubspot", name: "HubSpot", group: "CRM", value: ["Your deals & contacts live here", "העסקאות והאנשי-קשר שלכם נמצאים כאן"], logo: "https://cdn.worldvectorlogo.com/logos/hubspot.svg" },
  { slug: "salesforce", name: "Salesforce", group: "CRM", value: ["Your CRM records live here", "רשומות ה-CRM שלכם נמצאות כאן"], logo: "https://cdn.worldvectorlogo.com/logos/salesforce-2.svg" },
  { slug: "zoho_crm", name: "Zoho", group: "CRM", value: ["Your contacts & leads live here", "אנשי הקשר והלידים שלכם נמצאים כאן"], logo: "https://cdn.worldvectorlogo.com/logos/zoho-1.svg" },
  { slug: "fireberry", name: "Fireberry", group: "CRM", value: ["Your accounts & contacts live here", "החשבונות ואנשי הקשר שלכם נמצאים כאן"], logo: "https://www.fireberry.com/favicon.ico" },
  { slug: "airtable", name: "Airtable", group: "Database", value: ["Your contacts base lives here", "בסיס אנשי הקשר שלכם נמצא כאן"], logo: "https://cdn.worldvectorlogo.com/logos/airtable.svg" },
  { slug: "shopify", name: "Shopify", group: "Store", value: ["Your orders & customers live here", "ההזמנות והלקוחות שלכם נמצאים כאן"], logo: "https://cdn.worldvectorlogo.com/logos/shopify.svg" },
];

// Canonical fields the Airtable mapping wizard maps onto the tenant's columns.
const AIRTABLE_FIELDS: Array<{ key: "email" | "phone" | "display_name" | "stage" | "notes"; required: boolean; label: [string, string]; match: RegExp }> = [
  { key: "email", required: false, label: ["Email", "אימייל"], match: /e-?mail|מייל|דוא/i },
  { key: "phone", required: false, label: ["Phone", "טלפון"], match: /phone|tel|mobile|טלפון|נייד/i },
  { key: "display_name", required: true, label: ["Name", "שם"], match: /name|full.?name|שם/i },
  { key: "stage", required: false, label: ["Stage / Status", "שלב / סטטוס"], match: /stage|status|שלב|סטטוס/i },
  { key: "notes", required: false, label: ["Notes column", "עמודת הערות"], match: /note|comment|הערות/i },
];

export default function SetupPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <SetupContent />
    </Suspense>
  );
}

function LoadingScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="animate-spin w-8 h-8 border-4 border-primary-500 border-t-transparent rounded-full" />
    </div>
  );
}

function emailDomain(email?: string | null): string {
  const at = (email || "").split("@")[1] || "";
  if (!at || ["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com"].includes(at)) return "";
  return at;
}

function SetupContent() {
  const { user, token, isLoading } = useAuth();
  const { locale: uiLocale, setLocale } = useI18n();
  const he = uiLocale === "he";
  const router = useRouter();
  const search = useSearchParams();

  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState("");

  // Gate 1 — understanding
  const [domain, setDomain] = useState("");
  const [crawling, setCrawling] = useState(false);
  const [u, setU] = useState<Understanding>({ name: "", industry: "", country: "", language: uiLocale || "en", description: "" });
  const [savingProfile, setSavingProfile] = useState(false);
  const crawledOnce = useRef(false);

  // Gate 2 — connect
  const [picked, setPicked] = useState<CoreSystemSlug | null>(null);
  const [shopDomain, setShopDomain] = useState("");
  const [fireberryToken, setFireberryToken] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [skipping, setSkipping] = useState(false);

  // Airtable mapping (post-OAuth) state.
  const [atBases, setAtBases] = useState<AirtableMeta[]>([]);
  const [atTables, setAtTables] = useState<AirtableMeta[]>([]);
  const [atFields, setAtFields] = useState<AirtableField[]>([]);
  const [atBaseId, setAtBaseId] = useState("");
  const [atTableId, setAtTableId] = useState("");
  const [atMap, setAtMap] = useState<Record<string, string>>({});
  const [atCreateMissing, setAtCreateMissing] = useState(true);
  const [atBusy, setAtBusy] = useState(false);

  const finalize = useCallback(async (slug: string) => {
    if (!token) return;
    setPhase("activating");
    try {
      await setCoreSystem(token, slug as CoreSystemSlug).catch(() => { /* best-effort record */ });
      await completeOnboarding(token);
      router.replace(SETUP_HUB);
    } catch (err: any) {
      setError(err?.message || "Couldn't finish onboarding.");
      setPhase("connect");
    }
  }, [token, router]);

  const runCrawl = useCallback(async (dom: string) => {
    if (!token || !dom.trim()) return;
    setCrawling(true);
    setError("");
    try {
      const res = await analyzeBusinessDomain(token, dom.trim(), uiLocale);
      const data = res.data;
      if (data.ok && data.understanding) {
        const un = data.understanding;
        setU((prev) => ({
          name: un.name || prev.name,
          industry: un.industry || prev.industry,
          country: un.country || prev.country,
          language: un.language || prev.language,
          description: un.description || prev.description,
        }));
      } else if (data.ok && data.description) {
        setU((prev) => ({ ...prev, description: data.description! }));
      }
    } catch {
      /* keep card editable for manual entry */
    } finally {
      setCrawling(false);
    }
  }, [token, uiLocale]);

  // ── Boot ──
  useEffect(() => {
    if (isLoading) return;
    if (!user || !token) { router.push("/login?redirect=setup"); return; }
    if (user.role !== "ADMIN") { router.push("/conversations"); return; }

    getOnboardingStatus(token)
      .then((res) => {
        const data = res.data;
        if (data.tenant?.status === "ACTIVE") { router.replace(SETUP_HUB); return; }

        // Returned from an OAuth round-trip with a system connected → finish.
        const connectedSlug: string | null = data.coreSystemConnected || null;
        const stashed = (() => { try { return localStorage.getItem("onboarding.coreSystem"); } catch { return null; } })();

        // Airtable OAuth completed but mapping not saved yet (connectedSlug
        // stays null until fieldMap exists) → run the mapping wizard.
        if (search.get("connected") === "airtable" && !connectedSlug) {
          setPhase("airtable_mapping");
          loadAirtableBases();
          return;
        }

        if (data.businessProfileCompleted && connectedSlug) {
          finalize(stashed || connectedSlug);
          return;
        }

        // Hydrate Gate 1 from any saved profile.
        const bp = data.businessProfile;
        if (bp) {
          setU({
            name: bp.organizationName || data.tenant?.name || "",
            industry: bp.industry && bp.industry !== "Other" ? bp.industry : "",
            country: bp.country || "",
            language: bp.primaryLanguage || data.tenant?.defaultLocale || uiLocale || "en",
            description: bp.businessDescription || "",
          });
          if (bp.websiteDomain) setDomain(bp.websiteDomain);
        } else if (data.tenant?.name) {
          setU((prev) => ({ ...prev, name: data.tenant.name }));
        }

        if (data.businessProfileCompleted) {
          setPhase("connect");
        } else {
          setPhase("understanding");
          // Auto-crawl from the best available domain.
          const guess = bp?.websiteDomain || emailDomain(user.email);
          if (guess && !crawledOnce.current) {
            crawledOnce.current = true;
            setDomain(guess);
            runCrawl(guess);
          }
        }
      })
      .catch(() => setPhase("understanding"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, user, token]);

  async function confirmUnderstanding() {
    if (!token || !u.name.trim() || !u.description.trim()) return;
    setSavingProfile(true);
    setError("");
    try {
      await saveBusinessProfile(token, {
        organizationName: u.name.trim(),
        businessDescription: u.description.trim(),
        industry: u.industry.trim() || undefined,
        country: u.country.trim() || undefined,
        primaryLanguage: u.language || undefined,
        websiteDomain: domain.trim() || undefined,
        locale: u.language || undefined,
      });
      if (u.language && u.language !== uiLocale) { await setLocale(u.language as any).catch(() => {}); }
      track("onboarding.business_confirmed");
      setPhase("connect");
    } catch (err: any) {
      setError(err?.message || "Couldn't save. Try again.");
    } finally {
      setSavingProfile(false);
    }
  }

  async function connect(slug: CoreSystemSlug) {
    if (!token) return;
    if (slug === "fireberry") { connectFireberry(); return; }
    if (slug === "shopify" && !shopDomain.trim()) { setPicked("shopify"); return; }
    setConnecting(true);
    setError("");
    try {
      try { localStorage.setItem("onboarding.coreSystem", slug); } catch { /* */ }
      // flow:"onboarding" tells the OAuth callback to redirect back to /setup
      // (not the marketplace) so we resume and finish activation here.
      const extra = {
        flow: "onboarding",
        ...(slug === "shopify" ? { shop: shopDomain.trim() } : {}),
      };
      const { url } = await initIntegrationOAuth(token, slug, extra);
      track("onboarding.core_system_picked", { slug });
      window.location.href = url; // full OAuth redirect; we resume on /setup return
    } catch (err: any) {
      setError(err?.message || "Couldn't start the connection. Check the system and try again.");
      setConnecting(false);
    }
  }

  // Fireberry — API-token connect (no OAuth). Paste token → connect → finish.
  async function connectFireberry() {
    if (!token) return;
    if (!fireberryToken.trim()) { setPicked("fireberry"); return; }
    setConnecting(true);
    setError("");
    try {
      await connectApiKeyIntegration(token, "fireberry", { tokenid: fireberryToken.trim() });
      track("onboarding.core_system_picked", { slug: "fireberry" });
      await finalize("fireberry");
    } catch (err: any) {
      setError(err?.message || "Couldn't connect Fireberry. Check your token and try again.");
      setConnecting(false);
    }
  }

  // ── Airtable mapping wizard (post-OAuth) ──
  async function loadAirtableBases() {
    if (!token) return;
    setAtBusy(true);
    setError("");
    try {
      const r = await airtableListBasesOnboarding(token);
      setAtBases(r.data || []);
    } catch (e: any) {
      setError(e?.message || "Couldn't load Airtable bases.");
    } finally {
      setAtBusy(false);
    }
  }

  async function pickAirtableBase(baseId: string) {
    setAtBaseId(baseId); setAtTableId(""); setAtTables([]); setAtFields([]); setAtMap({});
    if (!token || !baseId) return;
    setAtBusy(true);
    try {
      const r = await airtableListTablesOnboarding(token, baseId);
      setAtTables(r.data || []);
    } catch (e: any) {
      setError(e?.message || "Couldn't load tables.");
    } finally {
      setAtBusy(false);
    }
  }

  async function pickAirtableTable(tableId: string) {
    setAtTableId(tableId); setAtFields([]);
    if (!token || !atBaseId || !tableId) return;
    setAtBusy(true);
    try {
      const r = await airtableListFieldsOnboarding(token, atBaseId, tableId);
      const fields = r.data || [];
      setAtFields(fields);
      // Auto-suggest the mapping by matching column names; the user confirms.
      const suggested: Record<string, string> = {};
      for (const cf of AIRTABLE_FIELDS) {
        const hit = fields.find((f) => cf.match.test(f.name));
        if (hit) suggested[cf.key] = hit.name;
      }
      setAtMap(suggested);
    } catch (e: any) {
      setError(e?.message || "Couldn't load columns.");
    } finally {
      setAtBusy(false);
    }
  }

  async function saveAirtableMappingAndFinish() {
    if (!token || !atBaseId || !atTableId) return;
    if (!atMap.display_name) { setError(he ? "בחרו עמודת שם" : "Pick the Name column"); return; }
    if (!atMap.email && !atMap.phone) { setError(he ? "בחרו עמודת אימייל או טלפון" : "Pick an Email or Phone column"); return; }
    setAtBusy(true);
    setError("");
    try {
      await saveAirtableMapping(token, {
        baseId: atBaseId,
        tableId: atTableId,
        fieldMap: { email: atMap.email, phone: atMap.phone, display_name: atMap.display_name, stage: atMap.stage },
        notesField: atMap.notes || undefined,
        createMissing: atCreateMissing,
      });
      track("onboarding.core_system_picked", { slug: "airtable" });
      await finalize("airtable");
    } catch (e: any) {
      setError(e?.message || "Couldn't save mapping.");
      setAtBusy(false);
    }
  }

  // "Not now" — finish onboarding without a connected core system. The user
  // can connect one later from the Setup Hub.
  async function skipConnect() {
    if (!token) return;
    setSkipping(true);
    setError("");
    try {
      try { localStorage.removeItem("onboarding.coreSystem"); } catch { /* */ }
      track("onboarding.core_system_skipped");
      setPhase("activating");
      await completeOnboarding(token, { skipCoreSystem: true });
      router.replace(SETUP_HUB);
    } catch (err: any) {
      setError(err?.message || "Couldn't finish onboarding.");
      setPhase("connect");
      setSkipping(false);
    }
  }

  if (phase === "loading" || isLoading) return <LoadingScreen />;

  if (phase === "activating") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin w-12 h-12 border-4 border-primary-500 border-t-transparent rounded-full mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-gray-900">{he ? "מכינים את סביבת העבודה…" : "Building your AI workspace…"}</h2>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-8">
      <div className="max-w-xl w-full">
        <GateDots phase={phase} />

        {error && <div className="mb-4 p-3 rounded-xl bg-red-50 text-red-600 text-sm">{error}</div>}

        {/* ── GATE 1 — Understanding ── */}
        {phase === "understanding" && (
          <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-7 space-y-5">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">
                {crawling ? (he ? "קוראים את האתר שלכם…" : "Reading your website…") : (he ? "ככה הבנו את העסק שלכם:" : "We understood your business like this:")}
              </h1>
              <p className="text-sm text-gray-500 mt-1">
                {he ? "בדקו, תקנו אם צריך, ואשרו. אפשר לערוך כל שדה." : "Check it, fix anything that's off, and confirm. Every field is editable."}
              </p>
            </div>

            {/* Domain row — lets the user retry the crawl on a different domain. */}
            <div className="flex gap-2">
              <input
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="acme.com"
                className="flex-1 px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition text-sm"
              />
              <button
                type="button"
                onClick={() => runCrawl(domain)}
                disabled={crawling || !domain.trim()}
                className="px-4 py-2.5 bg-gray-900 text-white text-sm font-medium rounded-xl hover:bg-gray-800 transition disabled:opacity-50"
              >
                {crawling ? (he ? "סורק…" : "Reading…") : (he ? "סרוק שוב" : "Re-read")}
              </button>
            </div>

            <div className={"space-y-3 transition " + (crawling ? "opacity-40 pointer-events-none" : "")}>
              <Field label={he ? "שם העסק" : "Business name"} value={u.name} onChange={(v) => setU({ ...u, name: v })} required />
              <Field label={he ? "תחום" : "Industry"} value={u.industry} onChange={(v) => setU({ ...u, industry: v })} placeholder={he ? "למשל: מסחר אלקטרוני / אופנה" : "e.g. E-commerce / Fashion"} />
              <div className="grid grid-cols-2 gap-3">
                <Field label={he ? "מדינה" : "Country"} value={u.country} onChange={(v) => setU({ ...u, country: v })} placeholder={he ? "ישראל" : "Israel"} />
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{he ? "שפה ראשית" : "Primary language"}</label>
                  <select
                    value={u.language}
                    onChange={(e) => setU({ ...u, language: e.target.value })}
                    className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition text-sm"
                  >
                    {LANGS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{he ? "מה אתם עושים" : "What you do"}<span className="text-red-400 ml-1">*</span></label>
                <textarea
                  value={u.description}
                  onChange={(e) => setU({ ...u, description: e.target.value })}
                  rows={3}
                  maxLength={2000}
                  placeholder={he ? "תיאור קצר של העסק" : "A short description of the business"}
                  className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition text-sm resize-none"
                />
              </div>
            </div>

            <button
              type="button"
              onClick={confirmUnderstanding}
              disabled={savingProfile || crawling || !u.name.trim() || !u.description.trim()}
              className="w-full py-3 bg-primary-500 hover:bg-primary-600 text-white font-medium rounded-xl transition disabled:opacity-50 shadow-lg shadow-primary-500/25"
            >
              {savingProfile ? (he ? "שומר…" : "Saving…") : (he ? "נכון — ממשיכים" : "Looks right →")}
            </button>
          </div>
        )}

        {/* ── GATE 2 — Connect core system ── */}
        {phase === "connect" && (
          <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-7 space-y-5">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">{he ? "חברו את מערכת הליבה שלכם" : "Connect your main business system"}</h1>
              <p className="text-sm text-gray-500 mt-1">
                {he ? "זו תהיה מקור האמת של Gotcha על הלקוחות שלכם. בוחרים אחת — את השאר אפשר לחבר אחר כך." : "This becomes Gotcha's source of truth about your customers. Pick one — the rest come later."}
              </p>
            </div>

            <div className="grid sm:grid-cols-2 gap-3">
              {SYSTEMS.map((s) => {
                const active = picked === s.slug;
                return (
                  <div key={s.slug}>
                    <button
                      type="button"
                      onClick={() => setPicked(s.slug)}
                      className={
                        "w-full text-left p-4 rounded-2xl border transition " +
                        (active
                          ? "border-primary-400 ring-2 ring-primary-200 bg-primary-50/40"
                          : "border-gray-200 hover:border-primary-300 hover:bg-primary-50/20")
                      }
                    >
                      <div className="flex items-center gap-3 mb-2">
                        <div className="w-10 h-10 rounded-xl bg-white border border-gray-100 p-1.5 flex items-center justify-center">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={s.logo} alt={s.name} className="w-full h-full object-contain" />
                        </div>
                        <div>
                          <div className="font-semibold text-gray-900">{s.name}</div>
                          <div className="text-[10px] uppercase tracking-wide text-gray-400">{s.group}</div>
                        </div>
                      </div>
                      <p className="text-sm text-gray-600">{s.value[he ? 1 : 0]}</p>
                    </button>

                    {active && s.slug === "shopify" && (
                      <input
                        value={shopDomain}
                        onChange={(e) => setShopDomain(e.target.value)}
                        placeholder="my-store.myshopify.com"
                        className="mt-2 w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 outline-none"
                      />
                    )}

                    {active && s.slug === "fireberry" && (
                      <div className="mt-2">
                        <input
                          value={fireberryToken}
                          onChange={(e) => setFireberryToken(e.target.value)}
                          type="password"
                          placeholder={he ? "טוקן API (tokenid)" : "API token (tokenid)"}
                          className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 outline-none"
                        />
                        <p className="text-[11px] text-gray-400 mt-1">
                          {he ? "Fireberry ← הגדרות ← אינטגרציה ← API ← הטוקן שלי" : "Fireberry → Settings → Integration → API Forms → My Token"}
                        </p>
                      </div>
                    )}

                    {active && (
                      <button
                        type="button"
                        onClick={() => connect(s.slug)}
                        disabled={connecting || (s.slug === "shopify" && !shopDomain.trim()) || (s.slug === "fireberry" && !fireberryToken.trim())}
                        className="mt-2 w-full py-2.5 bg-primary-500 hover:bg-primary-600 text-white text-sm font-medium rounded-xl transition disabled:opacity-50"
                      >
                        {connecting ? (he ? "מתחבר…" : "Connecting…") : `${he ? "התחבר ל" : "Connect "}${s.name} →`}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            <p className="text-xs text-gray-400 text-center">
              {he ? "בוחרים מערכת אחת כדי שה-AI יכיר את הלקוחות שלכם. ערוצים ואינטגרציות נוספות — בהמשך, מתוך מרכז ההתקנה." : "Pick one system so the AI knows your customers. Channels and other integrations come later, from the Setup Hub."}
            </p>

            <div className="flex items-center justify-between pt-1">
              <button
                type="button"
                onClick={() => { setError(""); setPhase("understanding"); }}
                disabled={connecting || skipping}
                className="text-sm font-medium text-gray-500 hover:text-gray-700 transition disabled:opacity-50"
              >
                {he ? "→ חזרה" : "← Back"}
              </button>
              <button
                type="button"
                onClick={skipConnect}
                disabled={connecting || skipping}
                className="text-sm font-medium text-gray-500 hover:text-gray-700 transition disabled:opacity-50"
              >
                {skipping ? (he ? "מסיים…" : "Finishing…") : (he ? "לא עכשיו — דלג" : "Not now — skip")}
              </button>
            </div>
          </div>
        )}

        {/* ── Airtable mapping (post-OAuth) ── */}
        {phase === "airtable_mapping" && (
          <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-7 space-y-5">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">{he ? "מיפוי ה-Airtable שלכם" : "Map your Airtable"}</h1>
              <p className="text-sm text-gray-500 mt-1">
                {he ? "בחרו את הבסיס והטבלה של אנשי הקשר, ומפו את העמודות שלכם." : "Pick your contacts base + table, then map your columns."}
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{he ? "בסיס" : "Base"}</label>
              <select
                value={atBaseId}
                onChange={(e) => pickAirtableBase(e.target.value)}
                disabled={atBusy}
                className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-200 focus:border-primary-300 outline-none text-sm"
              >
                <option value="">{he ? "בחרו בסיס…" : "Select a base…"}</option>
                {atBases.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>

            {atBaseId && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{he ? "טבלת אנשי קשר" : "Contacts table"}</label>
                <select
                  value={atTableId}
                  onChange={(e) => pickAirtableTable(e.target.value)}
                  disabled={atBusy}
                  className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-200 focus:border-primary-300 outline-none text-sm"
                >
                  <option value="">{he ? "בחרו טבלה…" : "Select a table…"}</option>
                  {atTables.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
            )}

            {atTableId && atFields.length > 0 && (
              <div className="space-y-3">
                <p className="text-xs text-gray-400">{he ? "מפו לפחות אימייל או טלפון, ושם. הצענו ניחוש — תקנו אם צריך." : "Map at least Email or Phone, plus Name. We pre-filled a guess — fix anything that's off."}</p>
                {AIRTABLE_FIELDS.map((cf) => (
                  <div key={cf.key}>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      {cf.label[he ? 1 : 0]}{cf.required && <span className="text-red-400 ml-1">*</span>}
                    </label>
                    <select
                      value={atMap[cf.key] || ""}
                      onChange={(e) => setAtMap({ ...atMap, [cf.key]: e.target.value })}
                      className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-200 focus:border-primary-300 outline-none text-sm"
                    >
                      <option value="">{he ? "— ללא —" : "— none —"}</option>
                      {atFields.map((f) => <option key={f.id} value={f.name}>{f.name}</option>)}
                    </select>
                  </div>
                ))}
                <label className="flex items-center gap-2 text-sm text-gray-600">
                  <input type="checkbox" checked={atCreateMissing} onChange={(e) => setAtCreateMissing(e.target.checked)} />
                  {he ? "צרו עבורי עמודות הערות/מזהה אם חסרות" : "Create Notes / ID columns for me if missing"}
                </label>
              </div>
            )}

            <button
              type="button"
              onClick={saveAirtableMappingAndFinish}
              disabled={atBusy || !atTableId}
              className="w-full py-3 bg-primary-500 hover:bg-primary-600 text-white font-medium rounded-xl transition disabled:opacity-50 shadow-lg shadow-primary-500/25"
            >
              {atBusy ? (he ? "שומר…" : "Saving…") : (he ? "סיום ←" : "Finish setup →")}
            </button>
            <div className="text-center">
              <button
                type="button"
                onClick={() => { setError(""); setPhase("connect"); }}
                disabled={atBusy}
                className="text-sm font-medium text-gray-500 hover:text-gray-700 transition disabled:opacity-50"
              >
                {he ? "→ חזרה" : "← Back"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, required }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; required?: boolean }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}{required && <span className="text-red-400 ml-1">*</span>}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition text-sm"
      />
    </div>
  );
}

function GateDots({ phase }: { phase: Phase }) {
  const gates: Phase[] = ["understanding", "connect"];
  const idx = gates.indexOf(phase);
  if (idx < 0) return null;
  return (
    <div className="flex items-center justify-center gap-2 mb-5">
      {gates.map((_, i) => (
        <div key={i} className={"h-1.5 rounded-full transition-all " + (i < idx ? "bg-primary-500 w-8" : i === idx ? "bg-primary-400 w-10" : "bg-gray-200 w-2")} />
      ))}
    </div>
  );
}

function track(event: string, props?: Record<string, unknown>) {
  try {
    const w = window as unknown as { analytics?: { track?: (e: string, p?: unknown) => void } };
    w.analytics?.track?.(event, props);
  } catch { /* best-effort */ }
}
