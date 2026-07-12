"use client";

// Onboarding — "Hiring an intelligence, not installing software" (Bible v1).
//
// Seven movements, one continuous experience. The AI works before the customer
// works: it discovers the business, reflects it back, assesses its own
// readiness, recommends who to hire, asks the ONE thing it can't infer, asks
// for the keys with reasons, and arrives prepared.
//
//   1 Discovery      — watched 5-domain scan (the moat; protect the first 10s)
//   2 Review         — reflect the report back; confidence + honest gaps; edit
//   3 Health         — "can I help you yet?"  ✓ found / ⚠ missing
//   4 Recommendation — "here's who I'd hire first, and why"
//   5 One Question   — the single earned question: your primary goal
//   6 Grant Access   — give your AI the keys (the source-of-truth system)
//   7 Ready          — a prepared employee + missions → into the app
//
// Movement 6 keeps the existing source-of-truth connect (incl. the Airtable
// OAuth round-trip) — connecting one system IS the activation event.

import { Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  discoverBusiness,
  discoverPlan,
  getBusinessDiscovery,
  patchBusinessDiscovery,
  getBusinessHealth,
  correctDiscovery,
  getRecommendations,
  resolveRecommendation,
  type RecommendationRow,
  employeeChat,
  type EmployeePersona,
  teachGap,
  saveOnboardingGoal,
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
  getKnowledgeBases,
  createKnowledgeBase,
  uploadKnowledgeFile,
  getKnowledgeIntegrations,
  initGoogleDriveOAuth,
  getDriveFiles,
  syncDriveFiles,
  type AirtableMeta,
  type AirtableField,
  type BusinessDiscoveryRecord,
  type HealthReport,
  type DiscoveryRecommendation,
  type DiscoveryGap,
} from "@/lib/api";

// After setup completes, land in the inbox — onboarding continues via the
// sidebar mission panel, not a dedicated home page.
const SETUP_HUB = "/conversations";

type Phase =
  | "loading"
  | "domain"        // Movement 1a — the one thing we can't infer: your domain
  | "discovering"
  | "review"        // Movement 2 — "Here's what I learned" (merged review + health)
  | "connect"       // Movement 3 — connect your source of truth
  | "goal"          // Movement 4 — your primary goal
  | "integrations"  // Movement 5 — recommended integrations
  | "knowledge"     // Movement 6 — knowledge I'd love to learn
  | "recommendation"// Movement 7 — meet who I'd hire first
  | "tune"          // Movement 8 — create & tune (chat before deploy)
  | "airtable_mapping"
  | "ready"         // Movement 9 — ready · connect channels
  | "activating";

const SYSTEMS: Array<{
  slug: CoreSystemSlug;
  name: string;
  group: "CRM" | "Store" | "Database";
  value: [string, string];
  logo: string;
}> = [
  { slug: "hubspot", name: "HubSpot", group: "CRM", value: ["so I know who your customers are", "כדי שאדע מי הלקוחות שלכם"], logo: "https://cdn.worldvectorlogo.com/logos/hubspot.svg" },
  { slug: "salesforce", name: "Salesforce", group: "CRM", value: ["so I know your accounts & pipeline", "כדי שאכיר את החשבונות והפייפליין שלכם"], logo: "https://cdn.worldvectorlogo.com/logos/salesforce-2.svg" },
  { slug: "zoho_crm", name: "Zoho", group: "CRM", value: ["so I know your contacts & leads", "כדי שאכיר את אנשי הקשר והלידים"], logo: "https://cdn.worldvectorlogo.com/logos/zoho-1.svg" },
  { slug: "fireberry", name: "Fireberry", group: "CRM", value: ["so I know your accounts & contacts", "כדי שאכיר את החשבונות ואנשי הקשר"], logo: "https://www.google.com/s2/favicons?domain=fireberry.com&sz=64" },
  { slug: "airtable", name: "Airtable", group: "Database", value: ["so I know your contacts base", "כדי שאכיר את בסיס אנשי הקשר"], logo: "https://cdn.simpleicons.org/airtable/FCB400" },
  { slug: "shopify", name: "Shopify", group: "Store", value: ["so I can answer 'where's my order' myself", "כדי שאענה על 'איפה ההזמנה שלי' בעצמי"], logo: "https://cdn.worldvectorlogo.com/logos/shopify.svg" },
];

const AIRTABLE_FIELDS: Array<{ key: "email" | "phone" | "display_name" | "stage" | "notes"; required: boolean; label: [string, string]; match: RegExp }> = [
  { key: "email", required: false, label: ["Email", "אימייל"], match: /e-?mail|מייל|דוא/i },
  { key: "phone", required: false, label: ["Phone", "טלפון"], match: /phone|tel|mobile|טלפון|נייד/i },
  { key: "display_name", required: true, label: ["Name", "שם"], match: /name|full.?name|שם/i },
  { key: "stage", required: false, label: ["Stage / Status", "שלב / סטטוס"], match: /stage|status|שלב|סטטוס/i },
  { key: "notes", required: false, label: ["Notes column", "עמודת הערות"], match: /note|comment|הערות/i },
];

// The single earned question (Movement 4) — large cards. Icons are neutral
// glyph names (one icon language across the flow, no emoji).
const GOALS: Array<{ slug: string; label: [string, string]; desc: [string, string]; icon: string }> = [
  { slug: "customer_support", label: ["Customer Support", "תמיכת לקוחות"], desc: ["Answer questions, resolve issues", "לענות על שאלות ולפתור בעיות"], icon: "chat" },
  { slug: "sales", label: ["Sales", "מכירות"], desc: ["Turn conversations into revenue", "להפוך שיחות להכנסות"], icon: "trend" },
  { slug: "lead_qualification", label: ["Lead Qualification", "סינון לידים"], desc: ["Qualify and route new leads", "לסנן ולנתב לידים חדשים"], icon: "target" },
  { slug: "operations", label: ["Operations", "תפעול"], desc: ["Bookings, orders, logistics", "הזמנות, פגישות, לוגיסטיקה"], icon: "sliders" },
  { slug: "internal_assistant", label: ["Internal Assistant", "עוזר פנימי"], desc: ["Help your team get answers", "לעזור לצוות שלכם למצוא תשובות"], icon: "compass" },
  { slug: "other", label: ["Something else", "משהו אחר"], desc: ["Tell me what matters most", "ספרו לי מה הכי חשוב"], icon: "star" },
];

export default function SetupPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <SetupContent />
    </Suspense>
  );
}

// The in-canvas movements (everything after the full-screen ceremony) in flow
// order — used for transition direction.
const TRANSITION_BAND: Phase[] = ["review", "connect", "airtable_mapping", "goal", "integrations", "knowledge", "recommendation", "tune", "ready"];

// Directional movement transitions: the leaving screen slips out the way
// you're going (up when moving forward, down when going back) for 160ms, then
// the next one rises in from the opposite edge — nine screens that read as one
// continuous document instead of a slideshow.
function useMovementTransition(phase: Phase): { shown: Phase; leaving: boolean; forward: boolean } {
  const [shown, setShown] = useState<Phase>(phase);
  const [leaving, setLeaving] = useState(false);
  const fwd = useRef(true);
  useEffect(() => {
    if (phase === shown) return;
    const from = TRANSITION_BAND.indexOf(shown);
    const to = TRANSITION_BAND.indexOf(phase);
    fwd.current = from < 0 || to < 0 || to >= from;
    if (from < 0 || to < 0) { setShown(phase); return; } // entering/leaving the band — swap instantly
    setLeaving(true);
    const t = setTimeout(() => { setShown(phase); setLeaving(false); }, 160);
    return () => clearTimeout(t);
  }, [phase, shown]);
  return { shown, leaving, forward: fwd.current };
}

// Movements where a bare Enter advances (requirement already met). Connect,
// tune, and ready are deliberately excluded — those are decisions.
const ENTER_PHASES = new Set<Phase>(["review", "goal", "integrations", "knowledge", "recommendation"]);

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
  const { shown, leaving, forward } = useMovementTransition(phase);

  // Discovery / review state
  const [domain, setDomain] = useState("");
  const [disc, setDisc] = useState<BusinessDiscoveryRecord | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const scannedOnce = useRef(false);

  // Health / recommendation
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [healthGaps, setHealthGaps] = useState<DiscoveryGap[]>([]);
  const [rec, setRec] = useState<DiscoveryRecommendation | null>(null);

  // Whether a scan is actively in flight (drives the full-screen ceremony),
  // and the short "every stage landed" beat before the briefing takes over.
  const [scanActive, setScanActive] = useState(false);
  const [scanComplete, setScanComplete] = useState(false);
  // Business-typed loader steps for the ceremony (Movement 1). Localized labels.
  const [loaderSteps, setLoaderSteps] = useState<string[] | null>(null);

  // Goal (Movement 5)
  const [goal, setGoal] = useState("");
  const [goalDetail, setGoalDetail] = useState("");
  const [savingGoal, setSavingGoal] = useState(false);

  // Connect (Movement 6) — unchanged source-of-truth logic
  const [picked, setPicked] = useState<CoreSystemSlug | null>(null);
  const [shopDomain, setShopDomain] = useState("");
  const [fireberryToken, setFireberryToken] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [systemQuery, setSystemQuery] = useState("");

  // Airtable mapping (post-OAuth)
  const [atBases, setAtBases] = useState<AirtableMeta[]>([]);
  const [atTables, setAtTables] = useState<AirtableMeta[]>([]);
  const [atFields, setAtFields] = useState<AirtableField[]>([]);
  const [atBaseId, setAtBaseId] = useState("");
  const [atTableId, setAtTableId] = useState("");
  const [atMap, setAtMap] = useState<Record<string, string>>({});
  const [atCreateMissing, setAtCreateMissing] = useState(true);
  const [atBusy, setAtBusy] = useState(false);

  // ── Discovery scan (Movement 1) ──
  const runScan = useCallback(async (dom: string) => {
    if (!token || !dom.trim() || scanActive) return;
    setError("");
    setScanComplete(false);
    setPhase("discovering");
    setScanActive(true);
    // Get the business-typed plan first (fast, no LLM) so the ceremony shows the
    // REAL focus areas for this kind of business while the deep scan runs.
    discoverPlan(token, dom.trim(), uiLocale)
      .then((p) => { const steps = p.data?.steps?.map((s) => s.label) || null; if (steps?.length) setLoaderSteps(steps); })
      .catch(() => { /* the ceremony falls back to its generic hints */ });
    try {
      const res = await discoverBusiness(token, dom.trim(), uiLocale);
      if (res.data.ok && res.data.discovery) {
        // Let the final stage visibly land before the briefing takes over.
        const d = res.data.discovery;
        setScanActive(false);
        setScanComplete(true);
        setTimeout(() => { setDisc(d); setPhase("review"); }, 1100);
      } else if (res.data.reason === "fetch_failed" || res.data.reason === "invalid_domain") {
        // Couldn't read the site at all — back to the front door, honestly.
        setScanActive(false);
        setError(he ? "לא הצלחתי לקרוא את האתר הזה. בדקו את הכתובת ונסו שוב." : "I couldn't read that site. Check the address and try again.");
        setPhase(disc ? "review" : "domain");
      } else {
        // The deep synthesis failed — the deterministic findings were preserved
        // server-side, so land on the (editable) review with what we KNOW.
        setScanActive(false);
        setError(he ? "לא הצלחתי להשלים את הניתוח המעמיק — הנה מה שכן מצאתי." : "I couldn't finish the deep analysis — here's what I did find.");
        const fresh = await getBusinessDiscovery(token).catch(() => null);
        if (fresh?.data.discovery) setDisc(fresh.data.discovery);
        setPhase("review");
      }
    } catch (err: any) {
      setScanActive(false);
      setError(err?.message || "Scan failed.");
      setPhase(disc ? "review" : "domain");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, uiLocale, he, disc, scanActive]);

  // Teach a gap inline (Movement 3) — persists knowledge + refreshes health/gaps.
  const teachGapInline = useCallback(async (label: string, method: "text" | "url", value: string): Promise<boolean> => {
    if (!token) return false;
    try {
      const res = await teachGap(token, label, method, value);
      if (!res.data.ok) return false;
      setDisc((prev) => (prev ? { ...prev, gaps: (prev.gaps || []).filter((g) => g.label !== label) } : prev));
      setHealthGaps((prev) => prev.filter((g) => g.label !== label));
      await loadHealth();
      return true;
    } catch { return false; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const loadHealth = useCallback(async () => {
    if (!token) return;
    try {
      const res = await getBusinessHealth(token);
      setHealth(res.data.health);
      setHealthGaps(res.data.gaps || []);
    } catch { /* non-blocking */ }
  }, [token]);

  // Per-item correction (Movement 2): remove / mark-incorrect / ignore a detected
  // channel, tool, platform, or gap. Optimistic local removal + persist so the AI
  // "learns immediately" and never re-surfaces it.
  const correctItem = useCallback(async (target: "channel" | "tool" | "platform" | "gap", action: "remove" | "incorrect" | "ignore", key: string) => {
    if (!token) return;
    setDisc((prev) => {
      if (!prev) return prev;
      if (target === "channel") return { ...prev, communication: { channels: (prev.communication?.channels || []).filter((c) => c.type !== key) } };
      if (target === "gap") return { ...prev, gaps: (prev.gaps || []).filter((g) => g.label !== key) };
      const t = prev.technology;
      if (!t) return prev;
      if (target === "platform") return { ...prev, technology: { ...t, platform: null } };
      return { ...prev, technology: { ...t, tools: (t.tools || []).filter((x) => x.slug !== key), legacy: (t.legacy || []).filter((x) => x.slug !== key), tracking: (t.tracking || []).filter((x) => x.slug !== key) } };
    });
    if (target === "gap") setHealthGaps((prev) => prev.filter((g) => g.label !== key));
    await correctDiscovery(token, target, action, key).catch(() => {});
  }, [token]);

  // Load readiness (health + gaps) as soon as the merged understanding document
  // is shown, so "can I help you yet?" is woven into the same screen.
  useEffect(() => {
    if (phase === "review" && token) loadHealth();
  }, [phase, token, loadHealth]);

  // Persist a resume checkpoint on each movement transition (fire-and-forget),
  // so a reload during movements 6-9 returns to that movement instead of
  // falling back to integrations (P0). Only the review→ready band is resumable.
  useEffect(() => {
    if (!token) return;
    const RESUMABLE = ["connect", "goal", "integrations", "knowledge", "recommendation", "tune", "ready"];
    if (RESUMABLE.includes(phase)) patchBusinessDiscovery(token, { progress: phase }).catch(() => {});
  }, [phase, token]);

  // Enter advances any movement whose requirement is already met (the real
  // Typeform signature). Inputs/buttons keep their own Enter behavior, and
  // decision screens (connect, tune, ready) are deliberately excluded so a
  // stray Enter can never connect, deploy, or complete anything.
  useEffect(() => {
    const b = disc?.business || {};
    const canConfirm = !!(b.name || "").trim() && !!((b.summary || b.valueProp) || "").trim();
    const actions: Partial<Record<Phase, (() => void) | null>> = {
      review: disc && canConfirm && !savingProfile ? confirmReview : null,
      goal: goal && !savingGoal ? submitGoal : null,
      integrations: () => setPhase("knowledge"),
      knowledge: () => { setRec(disc?.recommendation || rec); setPhase("recommendation"); },
      recommendation: () => setPhase("tune"),
    };
    const fn = actions[phase];
    if (!fn) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t && t.closest("input, textarea, select, button, a, [contenteditable]")) return;
      e.preventDefault();
      fn();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, disc, goal, savingGoal, savingProfile, rec]);

  // ── Boot / resume ──
  useEffect(() => {
    if (isLoading) return;
    if (!user || !token) { router.push("/login?redirect=setup"); return; }
    if (user.role !== "ADMIN") { router.push("/conversations"); return; }

    (async () => {
      try {
        const statusRes = await getOnboardingStatus(token);
        const data = statusRes.data;
        if (data.tenant?.status === "ACTIVE") { router.replace(SETUP_HUB); return; }

        const connectedSlug: string | null = data.coreSystemConnected || null;

        // Airtable OAuth returned but mapping not saved → run the mapping wizard.
        if (search.get("connected") === "airtable" && !connectedSlug) {
          setPhase("airtable_mapping");
          loadAirtableBases();
          return;
        }

        // Load any persisted discovery so every movement re-hydrates on refresh
        // and after an OAuth round-trip.
        const discRes = await getBusinessDiscovery(token).catch(() => null);
        const d = discRes?.data.discovery || null;
        if (d) { setDisc(d); if (d.recommendation) setRec(d.recommendation); if (d.primaryGoal) setGoal(d.primaryGoal); }
        if (d?.websiteDomain) setDomain(d.websiteDomain);

        // Resume-within-band (P0): a persisted `progress` checkpoint lets a reload
        // during movements 6-9 return to that movement instead of falling back to
        // integrations. Derived gates still guard the coarse stage; unknown/stale
        // progress simply falls through to the base derivation.
        const RESUME_BAND: Phase[] = ["integrations", "knowledge", "recommendation", "tune", "ready"];
        const resumeBand = (base: Phase): Phase => {
          const p = (d?.progress || "") as Phase;
          return RESUME_BAND.includes(p) && RESUME_BAND.indexOf(p) >= RESUME_BAND.indexOf(base) ? p : base;
        };

        // Returned from OAuth having connected the source of truth (Movement 3)
        // → continue to the primary-goal question (Movement 4).
        if (connectedSlug) {
          try { localStorage.setItem("onboarding.coreSystem", connectedSlug); } catch { /* */ }
          await loadHealth();
          setPhase(d?.primaryGoal ? resumeBand("integrations") : "goal");
          return;
        }

        const profileDone = !!data.businessProfileCompleted;
        if (d?.status === "COMPLETE") {
          // Movement order: review → connect(source) → goal → integrations → …
          if (!profileDone) { setPhase("review"); return; }
          if (!connectedSlug && !d.primaryGoal) { setPhase("connect"); return; }
          if (!d.primaryGoal) { setPhase("goal"); return; }
          setPhase(resumeBand("integrations"));
          return;
        }

        // First run — scan from the best available domain (suggested from the
        // email domain, so the only "ask" is a confirmation, not a question).
        const guess = d?.websiteDomain || data.businessProfile?.websiteDomain || emailDomain(user.email);
        if (guess && !scannedOnce.current) {
          scannedOnce.current = true;
          setDomain(guess);
          runScan(guess);
        } else {
          setPhase("domain");
        }
      } catch {
        setPhase("domain");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, user, token]);

  // ── Movement 2 → confirm the portrait, save profile, go to health ──
  async function confirmReview() {
    if (!token || !disc) return;
    const b = disc.business || {};
    // U-4: the render falls back to valueProp when summary is empty, so accept
    // either here (and in the button's disabled state) — text visible ⇒ button live.
    if (!b.name?.trim() || !((b.summary || b.valueProp) || "").trim()) {
      setError(he ? "מלאו שם ותיאור קצר" : "Fill in a name and a short description");
      return;
    }
    setSavingProfile(true);
    setError("");
    try {
      // Persist user corrections to the discovery, then mirror the confirmed
      // understanding onto BusinessProfile (the activation gate reads it).
      await patchBusinessDiscovery(token, { business: b as Record<string, unknown>, brand: (disc.brand || {}) as Record<string, unknown> }).catch(() => {});
      const lang = (disc.brand?.languages?.[0] as string) || uiLocale;
      await saveBusinessProfile(token, {
        organizationName: b.name!.trim(),
        businessDescription: (b.summary || b.valueProp || "").trim(),
        industry: b.industry?.trim() || undefined,
        country: b.country?.trim() || undefined,
        primaryLanguage: lang || undefined,
        websiteDomain: (disc.websiteDomain || domain || "").trim() || undefined,
        locale: lang || undefined,
      });
      setRec(disc?.recommendation || null);
      setPhase("connect"); // Movement 3 — connect your source of truth
    } catch (err: any) {
      setError(err?.message || "Couldn't save. Try again.");
    } finally {
      setSavingProfile(false);
    }
  }

  // Edit a business field on the in-memory discovery.
  function editBiz(key: string, val: string) {
    setDisc((prev) => (prev ? { ...prev, business: { ...(prev.business || {}), [key]: val } } : prev));
  }

  // ── Movement 5 → save the one answer, go to grant access ──
  async function submitGoal() {
    if (!token || !goal) return;
    if (goal === "other" && !goalDetail.trim()) return; // "something else" needs the something
    setSavingGoal(true);
    setError("");
    try {
      await saveOnboardingGoal(token, goal, goal === "other" ? goalDetail : undefined);
      setPhase("integrations"); // Movement 5 — recommended integrations
    } catch (err: any) {
      setError(err?.message || "Couldn't save. Try again.");
    } finally {
      setSavingGoal(false);
    }
  }

  // ── Movement 6 — connect (unchanged source-of-truth logic) ──
  async function connect(slug: CoreSystemSlug) {
    if (!token) return;
    if (slug === "fireberry") { connectFireberry(); return; }
    if (slug === "shopify" && !shopDomain.trim()) { setPicked("shopify"); return; }
    setConnecting(true);
    setError("");
    try {
      try { localStorage.setItem("onboarding.coreSystem", slug); } catch { /* */ }
      const extra = { flow: "onboarding", ...(slug === "shopify" ? { shop: shopDomain.trim() } : {}) };
      const { url } = await initIntegrationOAuth(token, slug, extra);
      window.location.href = url; // full OAuth redirect; we resume on /setup return
    } catch (err: any) {
      setError(err?.message || "Couldn't start the connection. Check the system and try again.");
      setConnecting(false);
    }
  }

  async function connectFireberry() {
    if (!token) return;
    if (!fireberryToken.trim()) { setPicked("fireberry"); return; }
    setConnecting(true);
    setError("");
    try {
      await connectApiKeyIntegration(token, "fireberry", { tokenid: fireberryToken.trim() });
      try { localStorage.setItem("onboarding.coreSystem", "fireberry"); } catch { /* */ }
      await setCoreSystem(token, "fireberry").catch(() => {});
      await loadHealth();
      setPhase("goal");
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

  async function saveAirtableMappingAndReady() {
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
      try { localStorage.setItem("onboarding.coreSystem", "airtable"); } catch { /* */ }
      await setCoreSystem(token, "airtable").catch(() => {});
      await loadHealth();
      setPhase("goal");
    } catch (e: any) {
      setError(e?.message || "Couldn't save mapping.");
      setAtBusy(false);
    }
  }

  // "Not now" — the source of truth stays a persisted recommendation; move on.
  async function skipConnect() {
    if (!token) return;
    try { localStorage.removeItem("onboarding.coreSystem"); } catch { /* */ }
    await loadHealth();
    setPhase("goal");
  }

  // ── Movement 7 — finish: connect-if-any, activate, into the app ──
  async function finishOnboarding() {
    if (!token) return;
    setPhase("activating");
    setError("");
    try {
      const stashed = (() => { try { return localStorage.getItem("onboarding.coreSystem"); } catch { return null; } })();
      if (stashed) { await setCoreSystem(token, stashed as CoreSystemSlug).catch(() => {}); }
      await completeOnboarding(token, { skipCoreSystem: !stashed });
      router.replace(SETUP_HUB);
    } catch (err: any) {
      setError(err?.message || "Couldn't finish onboarding.");
      setPhase("ready");
    }
  }

  if (phase === "loading" || isLoading) return <LoadingScreen />;

  // Movement 1a — the front door: one question, zero noise, no loader.
  if (phase === "domain") {
    return <DomainScreen he={he} domain={domain} setDomain={setDomain} onScan={() => runScan(domain)} error={error} />;
  }

  // Movement 1b — the investigation owns the whole screen and FREEZES the
  // flow. Stages appear and land as the REAL scan advances (polled state).
  if (phase === "discovering") {
    return <ScanScreen he={he} token={token} domain={domain} hints={loaderSteps} complete={scanComplete} />;
  }

  if (phase === "activating") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#fafafa]">
        <div className="text-center animate-riseIn">
          <div className="animate-spin w-12 h-12 border-4 border-primary-500 border-t-transparent rounded-full mx-auto mb-5" />
          <h2 className="text-2xl font-bold text-gray-900 tracking-tight">{he ? "מכינים את העובד שלכם…" : "Getting your employee ready…"}</h2>
        </div>
      </div>
    );
  }

  return (
    // The breathing document frame (Bible Law 11): wide, calm, generous
    // whitespace, a single reading column — never a narrow centered card.
    <div className="min-h-screen bg-[#fafafa] px-6 py-8 md:py-12">
      <div className="max-w-4xl w-full mx-auto">
        <MovementRail phase={phase} he={he} />
        {error && <div className="mb-6 p-3.5 rounded-2xl bg-amber-50 border border-amber-100 text-amber-700 text-sm">{error}</div>}
        <div key={shown} className={leaving ? (forward ? "animate-leaveUp" : "animate-leaveDown") : (forward ? "animate-riseIn" : "animate-riseDown")}>

        {/* Movement 2 — Here's what I learned (merged review + health) */}
        {shown === "review" && disc && (
          <LearnedScreen he={he} disc={disc} health={health} gaps={healthGaps} editBiz={editBiz} onCorrect={correctItem} onTeach={teachGapInline} onConfirm={confirmReview} saving={savingProfile} onRescan={() => runScan(domain)} />
        )}

        {/* Movement 3 — Connect your source of truth (big primary card) */}
        {shown === "connect" && (
          <ConnectScreen
            he={he} systemQuery={systemQuery} setSystemQuery={setSystemQuery}
            picked={picked} setPicked={setPicked} shopDomain={shopDomain} setShopDomain={setShopDomain}
            fireberryToken={fireberryToken} setFireberryToken={setFireberryToken}
            connecting={connecting} skipping={skipping} onConnect={connect}
            onBack={() => { setError(""); setPhase("review"); }} onSkip={skipConnect}
            rec={disc?.recommendation || null} disc={disc}
          />
        )}

        {/* Movement 4 — Your primary goal */}
        {shown === "goal" && <GoalScreen he={he} goal={goal} setGoal={setGoal} goalDetail={goalDetail} setGoalDetail={setGoalDetail} onContinue={submitGoal} saving={savingGoal} onBack={() => setPhase("connect")} />}

        {/* Movement 5 — Recommended integrations */}
        {shown === "integrations" && token && (
          <IntegrationsScreen
            he={he} token={token} disc={disc}
            onConnectSystem={(slug) => { setError(""); setPicked(slug); setPhase("connect"); }}
            onContinue={() => setPhase("knowledge")} onBack={() => setPhase("goal")}
          />
        )}

        {/* Movement 6 — Knowledge I'd love to learn */}
        {shown === "knowledge" && token && (
          <KnowledgeScreen he={he} token={token} gaps={disc?.gaps || []} onTeach={teachGapInline} onContinue={() => { setRec(disc?.recommendation || rec); setPhase("recommendation"); }} onBack={() => setPhase("integrations")} />
        )}

        {/* Movement 7 — Meet who I'd hire first */}
        {shown === "recommendation" && token && (
          <MeetScreen
            he={he} token={token} disc={disc} rec={disc?.recommendation || rec} health={health}
            onRename={(name) => setDisc((prev) => (prev?.recommendation ? { ...prev, recommendation: { ...prev.recommendation, employeeName: name } } : prev))}
            onContinue={() => setPhase("tune")} onBack={() => setPhase("knowledge")}
          />
        )}

        {/* Movement 8 — Create & tune the employee (chat before deploy) */}
        {shown === "tune" && token && (
          <TuneScreen he={he} token={token} rec={disc?.recommendation || rec} disc={disc} onContinue={() => setPhase("ready")} onBack={() => setPhase("recommendation")} />
        )}

        {shown === "airtable_mapping" && (
          <AirtableScreen
            he={he} atBases={atBases} atTables={atTables} atFields={atFields}
            atBaseId={atBaseId} atTableId={atTableId} atMap={atMap} setAtMap={setAtMap}
            atCreateMissing={atCreateMissing} setAtCreateMissing={setAtCreateMissing}
            atBusy={atBusy} onPickBase={pickAirtableBase} onPickTable={pickAirtableTable}
            onSave={saveAirtableMappingAndReady} onBack={() => { setError(""); setPhase("connect"); }}
          />
        )}

        {/* Movement 9 — Your employee is ready · connect channels */}
        {shown === "ready" && <ReadyScreen he={he} disc={disc} rec={disc?.recommendation || rec} health={health} onFinish={finishOnboarding} />}
        </div>

        {/* Quiet keyboard affordance — Enter advances wherever it's safe. */}
        {ENTER_PHASES.has(phase) && (
          <p className="fixed bottom-5 end-6 text-[11px] font-medium text-gray-300 select-none hidden md:block" aria-hidden>Enter ↵</p>
        )}
      </div>
    </div>
  );
}

// ─── Movement 1: Discovery ──────────────────────────────────
// ─── Confidence + channel visual language (shared) ──────────
function confLabel(he: boolean, c?: string): string {
  switch (c) {
    case "confirmed": return he ? "מאומת" : "Confirmed";
    case "likely": return he ? "סביר" : "Likely";
    case "low": return he ? "ביטחון נמוך" : "Low confidence";
    case "needs_verification": return he ? "דורש אימות" : "Needs verification";
    case "unknown": return he ? "לא בטוח" : "Couldn't determine";
    default: return "";
  }
}
function ConfidenceChip({ he, c }: { he: boolean; c?: string }) {
  if (!c) return null;
  const cls: Record<string, string> = {
    confirmed: "bg-emerald-50 text-emerald-600 border-emerald-100",
    likely: "bg-sky-50 text-sky-600 border-sky-100",
    low: "bg-amber-50 text-amber-600 border-amber-100",
    needs_verification: "bg-amber-50 text-amber-600 border-amber-100",
    unknown: "bg-gray-100 text-gray-500 border-gray-200",
  };
  return <span className={"text-[10px] px-1.5 py-0.5 rounded-full border font-medium " + (cls[c] || cls.unknown)}>{confLabel(he, c)}</span>;
}

// Channel visual identity: real brand marks (simpleicons, brand-colored — the
// same CDN the tech/system logos already use) with a neutral inline-SVG glyph
// for generic methods and as the always-works fallback.
// deriveHealth (auth) emits English labels; translate the known vocabulary so
// the readiness strip speaks the tenant's language.
function healthLabel(he: boolean, label: string): string {
  if (!he) return label;
  const MAP: Record<string, string> = {
    FAQ: "שאלות נפוצות", "Help Center": "מרכז עזרה", "Refund policy": "מדיניות החזרים",
    "Shipping policy": "מדיניות משלוחים", "Returns policy": "מדיניות החזרות",
    "No channels detected yet": "טרם זוהו ערוצים", "CRM not connected": "מערכת לקוחות לא מחוברת",
    "Customer system connected": "מערכת לקוחות מחוברת",
  };
  if (MAP[label]) return MAP[label];
  const m = label.match(/^(.+) detected$/);
  if (m) return `זוהה ${CHANNEL_META[m[1]!]?.label[1] || m[1]}`;
  return label;
}

const CHANNEL_META: Record<string, { icon: string; label: [string, string]; brand?: [string, string] }> = {
  whatsapp: { icon: "🟢", label: ["WhatsApp", "וואטסאפ"], brand: ["whatsapp", "25D366"] },
  instagram: { icon: "📸", label: ["Instagram", "אינסטגרם"], brand: ["instagram", "E4405F"] },
  facebook: { icon: "📘", label: ["Facebook", "פייסבוק"], brand: ["facebook", "0866FF"] },
  messenger: { icon: "💬", label: ["Messenger", "מסנג'ר"], brand: ["messenger", "00B2FF"] },
  telegram: { icon: "✈️", label: ["Telegram", "טלגרם"], brand: ["telegram", "26A5E4"] },
  email: { icon: "✉️", label: ["Email", "אימייל"] },
  phone: { icon: "📞", label: ["Phone", "טלפון"] },
  website_chat: { icon: "💬", label: ["Website chat", "צ'אט באתר"] },
  contact_form: { icon: "📝", label: ["Contact form", "טופס יצירת קשר"] },
  tiktok: { icon: "🎵", label: ["TikTok", "טיקטוק"], brand: ["tiktok", "000000"] },
  newsletter: { icon: "📧", label: ["Newsletter", "ניוזלטר"] },
  popup: { icon: "🔔", label: ["Website popup", "פופ-אפ באתר"] },
};

function ChannelIcon({ type, size = 20, provider }: { type: string; size?: number; provider?: string }) {
  const [failed, setFailed] = useState(false);
  // A detected mail platform (MX lookup) upgrades the generic email glyph to
  // the real provider mark — Gmail / Outlook — like any other platform.
  const brand: [string, string] | undefined =
    provider === "gmail" ? ["gmail", "EA4335"]
    : provider === "outlook" ? ["microsoftoutlook", "0078D4"]
    : CHANNEL_META[type]?.brand;
  if (brand && !failed) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={`https://cdn.simpleicons.org/${brand[0]}/${brand[1]}`} width={size} height={size} alt="" className="shrink-0 object-contain" onError={() => setFailed(true)} />;
  }
  return <GenericGlyph type={type} size={size} />;
}

// Minimal neutral glyphs for non-brand methods (and the offline fallback).
function GenericGlyph({ type, size }: { type: string; size: number }) {
  const common = {
    width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
    className: "text-gray-400 shrink-0",
  };
  switch (type) {
    case "email":
    case "newsletter":
      return <svg {...common} aria-hidden><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg>;
    case "phone":
    case "sms":
      return <svg {...common} aria-hidden><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" /></svg>;
    case "website_chat":
      return <svg {...common} aria-hidden><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" /></svg>;
    case "contact_form":
      return <svg {...common} aria-hidden><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M16 13H8" /><path d="M16 17H8" /></svg>;
    case "popup":
      return <svg {...common} aria-hidden><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></svg>;
    default:
      return <span style={{ fontSize: Math.max(size - 5, 11) }} className="leading-none">{CHANNEL_META[type]?.icon || "🔗"}</span>;
  }
}

// Neutral glyphs for the abstract categories (goals, knowledge sources) — one
// icon language across the flow instead of mixed emoji.
function Glyph({ name, size = 20, className = "text-primary-500" }: { name: string; size?: number; className?: string }) {
  const common = {
    width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
    className: className + " shrink-0",
  };
  switch (name) {
    case "chat": return <svg {...common} aria-hidden><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" /></svg>;
    case "trend": return <svg {...common} aria-hidden><polyline points="23 6 13.5 15.5 8.5 10.5 1 18" /><polyline points="17 6 23 6 23 12" /></svg>;
    case "target": return <svg {...common} aria-hidden><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" /></svg>;
    case "sliders": return <svg {...common} aria-hidden><line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" /><line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" /><line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" /><line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" /></svg>;
    case "compass": return <svg {...common} aria-hidden><circle cx="12" cy="12" r="10" /><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" /></svg>;
    case "star": return <svg {...common} aria-hidden><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>;
    case "book": return <svg {...common} aria-hidden><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" /></svg>;
    case "globe": return <svg {...common} aria-hidden><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>;
    case "file": return <svg {...common} aria-hidden><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M16 13H8" /><path d="M16 17H8" /></svg>;
    default: return null;
  }
}

// The one warning mark for honest gaps — replaces the ⚠ text char, which
// renders as an emoji picture on several platforms.
function WarnIcon({ className = "w-3.5 h-3.5 text-amber-500" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className + " shrink-0"} aria-hidden>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

// GOTCHA can actually operate in these. Everything else the scan finds
// (contact form, live chat, newsletter, popup, …) is a real discovery but an
// "other communication method", shown separately — never mixed in.
const PRIMARY_CHANNELS = new Set(["whatsapp", "instagram", "facebook", "messenger", "telegram", "email", "phone"]);

// Gaps that make sense as TEACH cards (knowledge you can hand over). A missing
// live-chat widget or CRM is a recommendation/mission, not teachable knowledge.
const TEACHABLE_GAP_DOMAINS = new Set(["knowledge", "business", "brand"]);
const PROVIDER_LABEL: Record<string, string> = { gmail: "Gmail", outlook: "Outlook" };

// ─── Movement 1a: The front door — one question, zero noise ──
// Light canvas like the rest of the flow. No loader exists on this screen:
// nothing spins until there is genuinely something to investigate.
// The real brand mark — identical to the landing page's Logo.
function Wordmark({ className = "h-7 w-auto" }: { className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/logo_icon.png" alt="GOTCHA" className={className} />;
}

function DomainScreen({ he, domain, setDomain, onScan, error }: { he: boolean; domain: string; setDomain: (v: string) => void; onScan: () => void; error: string }) {
  const canScan = !!domain.trim();
  return (
    <div className="min-h-screen bg-[#fafafa] flex flex-col" dir={he ? "rtl" : "ltr"}>
      <header className="px-6 md:px-10 py-6"><Wordmark /></header>
      <main className="flex-1 flex items-center px-6">
        <div className="w-full max-w-2xl mx-auto pb-24 animate-riseIn">
          <p className="text-[12px] font-semibold text-primary-500 uppercase tracking-[0.22em] mb-4">{he ? "גילוי עסקי" : "Business Discovery"}</p>
          <h1 className="text-4xl md:text-[52px] font-bold text-gray-900 tracking-tight leading-[1.06]">
            {he ? "איפה העסק שלכם חי באינטרנט?" : "Where does your business live online?"}
          </h1>
          <p className="text-lg text-gray-500 mt-4 leading-relaxed max-w-xl">
            {he ? "אני אקרא את האתר מקצה לקצה ואחזור עם כל מה שלמדתי — לפני שאשאל אתכם דבר." : "I'll read it end to end and come back with everything I learned — before asking you a single question."}
          </p>
          <div className="mt-10">
            <input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && canScan) onScan(); }}
              placeholder="yourbusiness.com"
              autoFocus
              dir="ltr"
              className={"w-full bg-transparent border-0 border-b-2 border-gray-200 focus:border-primary-400 outline-none text-2xl md:text-3xl font-medium text-gray-900 placeholder-gray-300 py-3 transition-colors " + (he ? "text-right" : "")}
            />
            {error && <p className="mt-3 text-sm text-amber-600">{error}</p>}
            <div className="flex items-center gap-4 mt-8">
              <button type="button" onClick={onScan} disabled={!canScan}
                className="inline-flex items-center justify-center px-8 py-4 bg-primary-500 hover:bg-primary-600 text-white text-base font-semibold rounded-2xl transition shadow-lg shadow-primary-500/25 disabled:opacity-40 disabled:shadow-none">
                {he ? "חקרו את העסק שלי ←" : "Investigate my business →"}
              </button>
              {canScan && <span className="text-xs text-gray-400 hidden md:block">{he ? "או הקישו Enter ↵" : "press Enter ↵"}</span>}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

// ─── Movement 1b: The investigation — stages land on REAL state ─
// The scan writes its phase onto the BusinessDiscovery row at genuine
// boundaries (homepage → pages → synthesis → done). We poll that row: a stage
// APPEARS the moment the engine actually enters it, and earns its check only
// when the next real phase begins. During synthesis the deterministic findings
// (channels, platform) surface live. No timer decides anything.
const SCAN_STAGES: Array<{ key: string; label: [string, string] }> = [
  { key: "homepage", label: ["Reading {domain}", "קורא את {domain}"] },
  { key: "pages", label: ["Exploring your pages — policies, FAQ, contact", "מסייר בעמודים שלכם — מדיניות, שאלות נפוצות, יצירת קשר"] },
  { key: "synthesis", label: ["Understanding your business in depth", "מבין את העסק שלכם לעומק"] },
];

function ScanScreen({ he, token, domain, hints, complete }: { he: boolean; token: string | null; domain: string; hints: string[] | null; complete: boolean }) {
  // `target` is the REAL phase from polling; `stageIdx` is what's displayed.
  // Display trails reality by a ≥450ms dwell per stage so a fast crawl doesn't
  // flash a stage in-and-done in the same frame. Completion is still driven
  // only by the real scan result — the dwell is presentation, never truth.
  const [target, setTarget] = useState(0);
  const [stageIdx, setStageIdx] = useState(0);
  const lastAdvance = useRef(0);
  const [live, setLive] = useState<{ channels: string[]; platform: string | null }>({ channels: [], platform: null });
  const [hintIdx, setHintIdx] = useState(0);

  useEffect(() => {
    if (stageIdx >= target) return;
    const wait = Math.max(0, 450 - (Date.now() - lastAdvance.current));
    const t = setTimeout(() => { lastAdvance.current = Date.now(); setStageIdx((i) => i + 1); }, wait);
    return () => clearTimeout(t);
  }, [target, stageIdx]);

  // Poll the real scan state (~1s). Monotonic — stages never move backwards,
  // and a stale pre-scan row (status ≠ SCANNING) is ignored.
  useEffect(() => {
    if (!token || complete) return;
    const t = setInterval(async () => {
      try {
        const r = await getBusinessDiscovery(token);
        const d = r.data.discovery;
        if (!d || d.status !== "SCANNING") return;
        const idx = SCAN_STAGES.findIndex((s) => s.key === d.scanPhase);
        if (idx >= 0) setTarget((m) => Math.max(m, idx));
        if (d.scanPhase === "synthesis") {
          const seen = new Set<string>();
          for (const c of d.communication?.channels || []) if (c?.type) seen.add(c.type);
          setLive({ channels: Array.from(seen), platform: d.technology?.platform?.name || null });
        }
      } catch { /* polling is best-effort; the POST result drives completion */ }
    }, 1000);
    return () => clearInterval(t);
  }, [token, complete]);

  // Rotate the business-typed focus hints while the deep synthesis runs. The
  // hints are flavor (what the engine is studying) — never checkmarks.
  useEffect(() => {
    if (!hints?.length || stageIdx < 2 || complete) return;
    const t = setInterval(() => setHintIdx((i) => (i + 1) % hints.length), 2400);
    return () => clearInterval(t);
  }, [hints, stageIdx, complete]);

  const visible = complete ? SCAN_STAGES.length : stageIdx + 1;
  const facts = live.platform || live.channels.length > 0;

  return (
    <div className="min-h-screen bg-[#fafafa] flex flex-col" dir={he ? "rtl" : "ltr"}>
      <header className="px-6 md:px-10 py-6"><Wordmark /></header>
      <main className="flex-1 flex items-center px-6">
        <div className="w-full max-w-xl mx-auto pb-24">
          <div className="flex items-center gap-4 mb-10 animate-riseIn">
            <span className="relative flex w-12 h-12 items-center justify-center shrink-0">
              <span className={"absolute inset-0 rounded-2xl bg-gradient-to-br from-primary-400 to-primary-600 " + (complete ? "" : "animate-pulseSoft")} />
              <span className="relative text-white text-xl font-bold">{complete ? "✓" : "◎"}</span>
            </span>
            <div className="min-w-0">
              <h1 className="text-2xl md:text-3xl font-bold text-gray-900 tracking-tight">
                {complete ? (he ? "סיימתי לקרוא" : "Done reading") : (he ? "חוקר את העסק שלכם" : "Investigating your business")}
              </h1>
              <p className="text-sm text-gray-400 font-medium truncate" dir="ltr">{domain}</p>
            </div>
          </div>

          <div className="space-y-4">
            {SCAN_STAGES.slice(0, visible).map((s, i) => {
              const done = complete || i < stageIdx;
              const active = !complete && i === stageIdx;
              return (
                <div key={s.key} className="animate-stageIn">
                  <div className="flex items-center gap-3.5">
                    <span className={"w-6 h-6 rounded-full flex items-center justify-center text-[12px] shrink-0 transition-colors " + (done ? "bg-emerald-500 text-white" : "bg-primary-100")}>
                      {done ? "✓" : <span className="w-2 h-2 rounded-full bg-primary-500 animate-pulseSoft inline-block" />}
                    </span>
                    <span className={"text-[16px] transition-colors " + (done ? "text-gray-500" : "text-gray-900 font-medium")}>
                      {s.label[he ? 1 : 0].replace("{domain}", domain)}
                    </span>
                  </div>
                  {active && s.key === "synthesis" && (
                    <div className="ms-[38px] mt-2.5 space-y-3">
                      {hints?.length ? (
                        <p key={hintIdx} className="text-sm text-gray-400 animate-stageIn">{hints[hintIdx]}…</p>
                      ) : null}
                      {facts && (
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400 mb-1.5">{he ? "נמצא עד כה" : "Found so far"}</p>
                          <div className="flex flex-wrap gap-1.5">
                            {live.platform && <LiveFact key="platform" icon="⚡" text={live.platform} />}
                            {live.channels.slice(0, 6).map((c) => (
                              <LiveFact key={c} type={c} text={CHANNEL_META[c]?.label[he ? 1 : 0] || c} />
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {complete && (
              <p className="ms-[38px] text-sm text-gray-400 animate-stageIn">{he ? "מכין את התדריך שלכם…" : "Preparing your briefing…"}</p>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function LiveFact({ text, icon, type }: { text: string; icon?: string; type?: string }) {
  return (
    <span className="animate-popIn inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-white border border-gray-150 text-gray-600 shadow-subtle">
      {type ? <ChannelIcon type={type} size={13} /> : icon ? <span className="text-[13px] leading-none">{icon}</span> : null}{text}
    </span>
  );
}

// ─── Movement 2: "Here's what I learned" — one merged understanding document ─
// The merge of Business Review + Business Health. Reads like an executive
// briefing: reading first, editing second, everything breathing and
// collapsible. Channels, other contact methods, and technologies are kept
// strictly separate. Readiness ("can I help you yet?") is woven in, and every
// gap is a contextual recommendation, not a warning.
type CorrectFn = (target: "channel" | "tool" | "platform" | "gap", action: "remove" | "incorrect" | "ignore", key: string) => void;

function CorrectMenu({ he, onCorrect }: { he: boolean; onCorrect: (action: "remove" | "incorrect" | "ignore") => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative shrink-0">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} className="w-6 h-6 rounded-md text-gray-300 hover:text-gray-600 hover:bg-gray-100 flex items-center justify-center text-sm leading-none" aria-label={he ? "תיקון" : "Correct"}>⋯</button>
      {open && (
        <>
          <button type="button" className="fixed inset-0 z-10 cursor-default" onClick={() => setOpen(false)} aria-hidden />
          <div role="menu" onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }} className={"absolute z-20 mt-1 w-40 rounded-xl border border-gray-150 bg-white shadow-lg py-1 " + (he ? "left-0" : "right-0")}>
            {([["incorrect", he ? "לא נכון" : "Mark incorrect"], ["remove", he ? "הסר" : "Remove"], ["ignore", he ? "התעלם" : "Ignore"]] as const).map(([act, label]) => (
              <button key={act} type="button" role="menuitem" onClick={() => { setOpen(false); onCorrect(act); }} className="w-full text-start px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 hover:text-gray-900">{label}</button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function LearnedScreen({ he, disc, health, gaps, editBiz, onCorrect, onTeach, onConfirm, saving, onRescan }: {
  he: boolean; disc: BusinessDiscoveryRecord; health: HealthReport | null; gaps: DiscoveryGap[];
  editBiz: (k: string, v: string) => void; onCorrect: CorrectFn; onTeach: (label: string, method: "text" | "url", value: string) => Promise<boolean>;
  onConfirm: () => void; saving: boolean; onRescan: () => void;
}) {
  const [editing, setEditing] = useState(false);
  // Calm-editing posture: the document reads clean by default; ONE toggle
  // reveals every per-item correction affordance (menus, chip ×) at once.
  const [correcting, setCorrecting] = useState(false);
  const b = disc.business || {};
  const brand = disc.brand || {};
  const allChannels = disc.communication?.channels || [];
  const channels = allChannels.filter((c) => PRIMARY_CHANNELS.has(c.type));
  const otherMethods = allChannels.filter((c) => !PRIMARY_CHANNELS.has(c.type));
  const tech = disc.technology || null;

  // Readiness woven in — a compact "can I help you yet?" strip.
  const allHealth = health ? [...health.knowledge, ...health.communication, ...health.tools] : [];
  const okCount = allHealth.filter((i) => i.ok).length;
  const readyPct = allHealth.length ? Math.round((okCount / allHealth.length) * 100) : 0;

  return (
    <div dir={he ? "rtl" : "ltr"}>
      {/* Executive header + summary — reading first. */}
      <div className="flex items-center justify-between gap-4 mb-3">
        <p className="text-[12px] font-semibold text-primary-500 uppercase tracking-[0.22em]">{he ? "הנה מה שלמדתי על העסק שלכם" : "Here's what I learned about your business"}</p>
        <button type="button" onClick={() => setCorrecting((v) => !v)} aria-pressed={correcting}
          className={"shrink-0 text-xs font-medium px-3 py-1.5 rounded-full border transition " + (correcting ? "border-primary-300 bg-primary-50 text-primary-600" : "border-gray-200 text-gray-400 hover:text-gray-600 hover:border-gray-300")}>
          {correcting ? (he ? "סיימתי לתקן ✓" : "Done correcting ✓") : (he ? "משהו לא מדויק?" : "Something off?")}
        </button>
      </div>
      <h1 className="text-4xl md:text-[44px] font-bold text-gray-900 tracking-tight leading-[1.08]">{b.name || (he ? "העסק שלכם" : "Your business")}</h1>
      {b.industry && <p className="text-sm text-gray-500 mt-1">{b.industry}{b.country ? ` · ${b.country}` : ""}</p>}

      {disc.report && (
        <div className="mt-5 max-w-[65ch] text-[15px] text-gray-700 leading-relaxed whitespace-pre-line">{disc.report}</div>
      )}

      {/* Readiness strip — woven in, a colleague's self-assessment (not a score). */}
      {health && allHealth.length > 0 && (
        <div className="mt-6 p-5 rounded-2xl bg-white border border-gray-150 shadow-subtle">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-semibold text-gray-800">{he ? "האם אני כבר יכול לעזור?" : "Can I help you yet?"}</span>
            <span className="text-xs text-gray-500">{he ? `${okCount} מתוך ${allHealth.length} מוכן` : `${okCount} of ${allHealth.length} ready`}</span>
          </div>
          <div className="h-1.5 rounded-full bg-gray-200 overflow-hidden"><div className="h-full bg-emerald-400 rounded-full transition-all" style={{ width: `${readyPct}%` }} /></div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3">
            {allHealth.slice(0, 8).map((it, i) => (
              <span key={i} className="text-xs flex items-center gap-1">{it.ok ? <span className="text-emerald-500">✓</span> : <WarnIcon className="w-3 h-3 text-amber-500" />}<span className={it.ok ? "text-gray-600" : "text-gray-500"}>{healthLabel(he, it.label)}</span></span>
            ))}
          </div>
        </div>
      )}

      <div className="mt-6 divide-y divide-gray-100">
        {/* What you do — read-first, Correct is secondary. */}
        <div className="py-2">
          <SectionHead he={he} title={he ? "מה אתם עושים" : "What you do"} onEdit={() => setEditing((v) => !v)} editing={editing} confidence={b.confidence} />
          {editing ? (
            <div className="space-y-3 mt-2">
              <Field label={he ? "שם העסק" : "Business name"} value={b.name || ""} onChange={(v) => editBiz("name", v)} required />
              <Field label={he ? "תחום" : "Industry"} value={b.industry || ""} onChange={(v) => editBiz("industry", v)} />
              <Field label={he ? "מדינה" : "Country"} value={b.country || ""} onChange={(v) => editBiz("country", v)} />
              <textarea value={b.summary || ""} onChange={(e) => editBiz("summary", e.target.value)} rows={3} maxLength={2000}
                className="w-full px-4 py-2.5 bg-white border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-200 outline-none text-sm resize-none" />
              <button type="button" onClick={onRescan} className="text-xs font-medium text-gray-400 hover:text-gray-600">{he ? "↻ לסרוק אתר אחר" : "↻ Re-scan a different site"}</button>
            </div>
          ) : (
            <p className="max-w-[65ch] text-[15px] text-gray-700 leading-relaxed mt-1">{b.summary || b.valueProp || "—"}</p>
          )}
          {!editing && (b.products || []).length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-3">{(b.products || []).slice(0, 8).map((p, i) => <Chip key={i} text={p} />)}</div>
          )}
        </div>

        {/* Communication channels — the ones GOTCHA can operate in. */}
        {channels.length > 0 && (
          <Collapsible he={he} title={he ? "ערוצי תקשורת" : "Communication channels"} defaultOpen>
            <div className="divide-y divide-gray-100">
              {channels.map((c, i) => {
                const meta = CHANNEL_META[c.type] || { icon: "🔗", label: [c.type, c.type] as [string, string] };
                // A found WhatsApp number IS a phone number customers can call
                // or message — surface it as the customer phone line, loudly.
                const phoneLine = (c.type === "whatsapp" || c.type === "phone") && !!c.identifier;
                return (
                  <div key={i} className="flex items-center gap-3.5 py-3 first:pt-1 last:pb-1">
                    <span className="w-9 h-9 rounded-xl bg-gray-50 flex items-center justify-center shrink-0">
                      <ChannelIcon type={c.type} size={19} provider={c.provider} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-gray-900 text-[15px]">{meta.label[he ? 1 : 0]}{c.provider && PROVIDER_LABEL[c.provider] ? ` (${PROVIDER_LABEL[c.provider]})` : ""}</span>
                        <ConfidenceChip he={he} c={c.confidence} />
                        {phoneLine && (
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-100 font-semibold">
                            {he ? "מספר טלפון ללקוחות" : "Customer phone line"}
                          </span>
                        )}
                      </div>
                      <div className="flex items-baseline gap-2 flex-wrap mt-0.5">
                        {c.identifier && <span className={"text-[13px] font-medium truncate " + (phoneLine ? "text-gray-800" : "text-gray-500")} dir="ltr">{c.identifier}</span>}
                        {c.purpose && <span className="text-xs text-gray-400 truncate">{c.purpose}</span>}
                      </div>
                    </div>
                    {correcting && <CorrectMenu he={he} onCorrect={(a) => onCorrect("channel", a, c.type)} />}
                  </div>
                );
              })}
            </div>
          </Collapsible>
        )}

        {/* Other communication methods — real discoveries, not GOTCHA channels. */}
        {otherMethods.length > 0 && (
          <Collapsible he={he} title={he ? "דרכי תקשורת נוספות שמצאתי" : "Other communication methods found"}>
            <div className="space-y-1.5">
              {otherMethods.map((c, i) => {
                const meta = CHANNEL_META[c.type] || { icon: "🔗", label: [c.type, c.type] as [string, string] };
                return (
                  <div key={i} className="flex items-center gap-2.5 py-1.5">
                    <ChannelIcon type={c.type} size={16} />
                    <span className="text-sm text-gray-700">{meta.label[he ? 1 : 0]}</span>
                    {c.identifier && <span className="text-xs text-gray-400 truncate" dir="ltr">{c.identifier}</span>}
                    <ConfidenceChip he={he} c={c.confidence} />
                    {correcting && <div className="ms-auto"><CorrectMenu he={he} onCorrect={(a) => onCorrect("channel", a, c.type)} /></div>}
                  </div>
                );
              })}
            </div>
          </Collapsible>
        )}

        {/* Technologies & systems — never mixed with communication. */}
        {tech && (tech.platform || tech.tools.length > 0 || tech.legacy.length > 0) && (
          <Collapsible he={he} title={he ? "טכנולוגיות ומערכות שזיהיתי" : "Technologies & systems you appear to use"} defaultOpen>
            {tech.platform && (
              <div className="flex items-center gap-3 p-3.5 rounded-xl border-2 border-primary-200 bg-primary-50/40">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`https://cdn.simpleicons.org/${tech.platform.slug}`} alt="" className="w-8 h-8 object-contain" onError={(e) => { e.currentTarget.style.display = "none"; }} />
                <div className="flex-1">
                  <div className="flex items-center gap-2"><span className="font-bold text-gray-900">{tech.platform.name}</span><ConfidenceChip he={he} c={tech.platform.confidence} /></div>
                  <div className="text-[11px] text-gray-500">{he ? "פלטפורמת הליבה שלכם" : "Your core platform"}</div>
                </div>
                {correcting && <CorrectMenu he={he} onCorrect={(a) => onCorrect("platform", a, tech.platform!.slug)} />}
              </div>
            )}
            {tech.tools.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2.5">
                {tech.tools.map((t, i) => (
                  <span key={i} className="group inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-white text-gray-700 border border-gray-150 shadow-subtle">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`https://cdn.simpleicons.org/${t.slug}`} alt="" className="w-3.5 h-3.5 object-contain" onError={(e) => { e.currentTarget.style.display = "none"; }} />
                    {t.name}
                    {correcting && <button type="button" onClick={() => onCorrect("tool", "remove", t.slug)} className="text-gray-300 hover:text-red-500 leading-none" aria-label={he ? "הסר" : "Remove"}>×</button>}
                  </span>
                ))}
              </div>
            )}
            {tech.legacy.length > 0 && (
              <p className="text-[11px] text-gray-400 mt-2">{he ? "זוהו גם (כנראה שרידים ישנים, לא הפלטפורמה הפעילה): " : "Also detected (likely legacy artifacts, not your active platform): "}{tech.legacy.map((l) => l.name).join(", ")}</p>
            )}
          </Collapsible>
        )}

        {/* Brand voice — one of the biggest assets, collapsible. */}
        {(brand.voice || brand.tone || brand.personality || (brand.vocabulary || []).length > 0) && (
          <Collapsible he={he} title={he ? "קול המותג" : "Brand voice"} confidence={brand.confidence}>
            <div className="space-y-2 text-sm">
              <BrandRow he={he} label={["Personality", "אישיות"]} value={brand.personality} />
              <BrandRow he={he} label={["Tone", "טון"]} value={brand.tone} />
              <BrandRow he={he} label={["Voice", "קול"]} value={brand.voice} />
              <BrandRow he={he} label={["Audience", "קהל"]} value={brand.audience} />
              <BrandRow he={he} label={["Positioning", "מיצוב"]} value={brand.positioning} />
              <BrandRow he={he} label={["CTA style", "סגנון קריאה לפעולה"]} value={brand.ctaStyle} />
              {(brand.vocabulary || []).length > 0 && <ChipRow he={he} label={["Preferred words", "מילים מועדפות"]} items={brand.vocabulary!} />}
              {(brand.forbiddenWords || []).length > 0 && <ChipRow he={he} label={["Avoids", "נמנע מ"]} items={brand.forbiddenWords!} tone="red" />}
              {(brand.languages || []).length > 0 && <ChipRow he={he} label={["Languages", "שפות"]} items={brand.languages!} />}
            </div>
          </Collapsible>
        )}

        {/* Contextual gaps → teach-me recommendations (not warnings). Only
            teachable domains — communication/technology gaps live in the
            recommendations & missions, not as teach cards. */}
        {gaps.filter((g) => TEACHABLE_GAP_DOMAINS.has(g.domain)).length > 0 && (
          <Collapsible he={he} title={he ? "מה שאשמח שתלמדו אותי" : "What I'd love you to teach me"} defaultOpen right={<span className="text-[11px] text-gray-400">{gaps.filter((g) => TEACHABLE_GAP_DOMAINS.has(g.domain)).length}</span>}>
            <div className="space-y-2.5">
              {gaps.filter((g) => TEACHABLE_GAP_DOMAINS.has(g.domain)).slice(0, 5).map((g) => <TeachCard key={g.id} he={he} gap={g} onTeach={onTeach} onDismiss={() => onCorrect("gap", "ignore", g.label)} />)}
            </div>
          </Collapsible>
        )}
      </div>

      <button type="button" onClick={onConfirm} disabled={saving || !(b.name || "").trim() || !((b.summary || b.valueProp) || "").trim()}
        className="mt-12 inline-flex items-center justify-center px-8 py-4 bg-primary-500 hover:bg-primary-600 text-white text-base font-semibold rounded-2xl transition disabled:opacity-50 shadow-lg shadow-primary-500/25">
        {saving ? (he ? "שומר…" : "Saving…") : (he ? "הכול מדויק — ממשיכים ←" : "This is accurate →")}
      </button>
    </div>
  );
}

function SectionHead({ he, title, onEdit, editing, confidence }: { he: boolean; title: string; onEdit?: () => void; editing?: boolean; confidence?: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide flex items-center gap-2">{title}<ConfidenceChip he={he} c={confidence} /></span>
      {onEdit && <button type="button" onClick={onEdit} className="text-xs font-medium text-gray-400 hover:text-primary-500">{editing ? (he ? "סיום" : "Done") : (he ? "תיקון" : "Correct")}</button>}
    </div>
  );
}
function BrandRow({ he, label, value }: { he: boolean; label: [string, string]; value?: string }) {
  if (!value) return null;
  return <div><span className="text-[11px] text-gray-400">{label[he ? 1 : 0]}: </span><span className="text-gray-700">{value}</span></div>;
}
function ChipRow({ he, label, items, tone }: { he: boolean; label: [string, string]; items: string[]; tone?: "red" }) {
  return (
    <div>
      <span className="text-[11px] text-gray-400">{label[he ? 1 : 0]}: </span>
      <span className="inline-flex flex-wrap gap-1 align-middle">{items.slice(0, 10).map((x, i) => (
        <span key={i} className={"text-[11px] px-2 py-0.5 rounded-full border " + (tone === "red" ? "bg-red-50 text-red-500 border-red-100" : "bg-gray-100 text-gray-600 border-gray-200")}>{x}</span>
      ))}</span>
    </div>
  );
}

function TeachCard({ he, gap, onTeach, onDismiss }: { he: boolean; gap: DiscoveryGap; onTeach: (label: string, method: "text" | "url", value: string) => Promise<boolean>; onDismiss?: () => void }) {
  const [mode, setMode] = useState<null | "url" | "text">(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  async function submit() {
    if (!value.trim()) return;
    setBusy(true);
    const ok = await onTeach(gap.label, mode!, value.trim());
    setBusy(false);
    if (ok) setDone(true);
  }
  if (dismissed) return null;
  if (done) return (
    <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-100 text-sm text-emerald-700 flex items-center gap-2"><span>✓</span>{he ? `למדתי את «${gap.label}». תודה!` : `Learned "${gap.label}". Thanks!`}</div>
  );
  return (
    <div className="p-4 rounded-xl border border-gray-150 bg-white shadow-subtle">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0"><WarnIcon /><span className="font-medium text-gray-800 text-sm truncate">{gap.label}</span></div>
        <div className="flex items-center gap-2 shrink-0">
          <ConfidenceChip he={he} c={gap.confidence} />
          {onDismiss && <button type="button" onClick={() => { setDismissed(true); onDismiss(); }} className="text-[11px] text-gray-400 hover:text-gray-600">{he ? "לא רלוונטי" : "Not relevant"}</button>}
        </div>
      </div>
      {gap.ask && <p className="text-xs text-gray-500 mt-1">{gap.ask}</p>}
      {!mode ? (
        <div className="flex gap-1.5 mt-2.5">
          <button type="button" onClick={() => setMode("url")} className="text-xs font-medium px-3 py-1.5 rounded-lg bg-white border border-gray-200 hover:border-primary-300">{he ? "נתינת קישור" : "Provide URL"}</button>
          <button type="button" onClick={() => setMode("text")} className="text-xs font-medium px-3 py-1.5 rounded-lg bg-white border border-gray-200 hover:border-primary-300">{he ? "הדבקת טקסט" : "Paste text"}</button>
        </div>
      ) : (
        <div className="mt-2.5 space-y-2">
          {mode === "url"
            ? <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://…" dir="ltr" className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-primary-200" />
            : <textarea value={value} onChange={(e) => setValue(e.target.value)} rows={3} placeholder={he ? "הדביקו כאן…" : "Paste it here…"} className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-primary-200 resize-none" />}
          <div className="flex gap-2">
            <button type="button" onClick={submit} disabled={busy || !value.trim()} className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50">{busy ? (he ? "לומד…" : "Learning…") : (he ? "למד את זה" : "Learn it")}</button>
            <button type="button" onClick={() => { setMode(null); setValue(""); }} className="text-xs font-medium px-3 py-1.5 rounded-lg text-gray-500 hover:text-gray-700">{he ? "ביטול" : "Cancel"}</button>
          </div>
        </div>
      )}
    </div>
  );
}

const ROLE_LABEL: Record<string, [string, string]> = {
  customer_support: ["Customer Support AI Employee", "עובד AI לתמיכה"],
  sales: ["Sales AI Employee", "עובד AI למכירות"],
  reception: ["Reception AI Employee", "עובד AI לקבלה"],
  conversation_intelligence: ["Conversation Intelligence", "מודיעין שיחות"],
};
const ROLE_MISSION: Record<string, [string, string]> = {
  customer_support: ["Answer customer questions accurately and flag what I'm unsure of", "לענות על שאלות לקוחות במדויק ולסמן את מה שאינני בטוח בו"],
  sales: ["Turn conversations into qualified opportunities and revenue", "להפוך שיחות להזדמנויות מכירה והכנסות"],
  reception: ["Greet, route, and book — so nothing falls through the cracks", "לקבל, לנתב ולתאם — כך ששום דבר לא ייפול בין הכיסאות"],
  conversation_intelligence: ["Read every conversation and surface what matters", "לקרוא כל שיחה ולהציף את מה שחשוב"],
};

// ─── Movement 5: Recommended integrations ───────────────────
// Only the critical recs first (grounded in discovery); the full catalog opens
// on demand. Skipping loses nothing — every rec persists in the living backlog.
function IntegrationsScreen({ he, token, disc, onConnectSystem, onContinue, onBack }: { he: boolean; token: string; disc: BusinessDiscoveryRecord | null; onConnectSystem: (slug: CoreSystemSlug) => void; onContinue: () => void; onBack: () => void }) {
  const [recs, setRecs] = useState<RecommendationRow[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    // ONLY genuinely connectable systems belong here. Channels get their own
    // moment (Movement 9 + the journey missions), detected-but-unsupported
    // tools live in the briefing's Technology section, and workflow ideas live
    // on Your Business — none of them earn a slot on a screen titled
    // "recommended integrations".
    getRecommendations(token, "OPEN")
      .then((r) => setRecs(r.data.recommendations.filter((x) => x.kind === "connect_system")))
      .catch(() => setRecs([]));
  }, [token]);
  const dismiss = async (id: string) => { setRecs((prev) => (prev || []).filter((r) => r.id !== id)); await resolveRecommendation(token, id, "dismiss").catch(() => {}); };
  const sorted = (recs || []).slice().sort((a, b) => b.priority - a.priority);
  const critical = sorted.slice(0, 3);
  const rest = sorted.slice(3);

  return (
    <div dir={he ? "rtl" : "ltr"}>
      <h1 className="text-4xl md:text-[44px] font-bold text-gray-900 tracking-tight leading-[1.08]">{he ? "אינטגרציות שאני ממליץ עליהן" : "Recommended integrations"}</h1>
      <p className="text-lg text-gray-500 mt-3 leading-relaxed max-w-2xl">{he ? "מבוסס על כל מה שגיליתי. אפשר לחבר עכשיו או בהמשך — הכול נשמר." : "Based on everything I found. Connect now or later — it's all saved to your list."}</p>

      {recs === null ? (
        <div className="py-10 text-center text-sm text-gray-400">{he ? "טוען…" : "Loading…"}</div>
      ) : sorted.length === 0 ? (
        <div className="py-8 text-sm text-gray-500">{he ? "אין המלצות קריטיות כרגע — אפשר להמשיך." : "No critical recommendations right now — you're good to continue."}</div>
      ) : (
        <div className="mt-6 space-y-2.5">
          {(showAll ? sorted : critical).map((r) => <RecRow key={r.id} he={he} rec={r} onDismiss={() => dismiss(r.id)} onConnect={onConnectSystem} />)}
          {!showAll && rest.length > 0 && (
            <button type="button" onClick={() => setShowAll(true)} className="text-sm font-medium text-primary-600 hover:text-primary-700 pt-1">
              {he ? `הצג את כל ${sorted.length} האינטגרציות →` : `Show all ${sorted.length} integrations →`}
            </button>
          )}
        </div>
      )}

      {/* Detected mail platform (MX lookup): the real provider, shown like any
          other platform. Mail connects one click after go-live, on Channels. */}
      {(disc?.communication?.channels || []).filter((c) => c.type === "email" && c.provider && PROVIDER_LABEL[c.provider]).slice(0, 2).map((c) => (
        <div key={c.identifier} className="mt-2.5 flex items-start gap-3 p-4 rounded-2xl border border-gray-150 bg-white shadow-subtle">
          <span className="w-9 h-9 rounded-xl bg-gray-50 flex items-center justify-center shrink-0">
            <ChannelIcon type="email" provider={c.provider} size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-gray-900 text-sm">{he ? `אימייל דרך ${PROVIDER_LABEL[c.provider!]}` : `Email via ${PROVIDER_LABEL[c.provider!]}`}</span>
              <span className="text-[9px] uppercase tracking-wide font-bold text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded-full">{he ? "זוהה אצלכם" : "detected"}</span>
              <EvidenceInfo he={he} evidence={{ source: "site_scan", detail: "identifier_found", identifier: c.identifier }} />
            </div>
            {c.identifier && <p className="text-xs text-gray-500 mt-0.5" dir="ltr">{c.identifier}</p>}
            <p className="text-[11px] text-gray-400 mt-1">{he ? "מתחבר בלחיצה אחת מיד אחרי ההפעלה — בעמוד הערוצים." : "One-click connect right after you go live — on the Channels page."}</p>
          </div>
        </div>
      ))}

      <div className="flex items-center justify-between mt-12">
        <button type="button" onClick={onBack} className="text-sm font-medium text-gray-500 hover:text-gray-700">{he ? "→ חזרה" : "← Back"}</button>
        <button type="button" onClick={onContinue} className="px-8 py-3.5 bg-primary-500 hover:bg-primary-600 text-white text-base font-semibold rounded-2xl transition shadow-lg shadow-primary-500/25">{he ? "המשך ←" : "Continue →"}</button>
      </div>
    </div>
  );
}

// A connectable-integration row: the system's real logo, an honest "how do I
// know this" ⓘ, and a REAL connect button that drops into the Movement-3 flow.
function RecRow({ he, rec, onDismiss, onConnect }: { he: boolean; rec: RecommendationRow; onDismiss: () => void; onConnect?: (slug: CoreSystemSlug) => void }) {
  const sys = SYSTEMS.find((s) => s.slug === rec.targetSlug);
  const connectable = !!sys && !!onConnect;
  return (
    <div className="flex items-start gap-3 p-4 rounded-2xl border border-gray-150 bg-white shadow-subtle">
      <span className="w-9 h-9 rounded-xl bg-gray-50 flex items-center justify-center shrink-0 relative">
        {sys ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={sys.logo} alt="" className="w-5 h-5 object-contain" onError={(e) => { e.currentTarget.style.display = "none"; }} />
        ) : (
          <span className="text-primary-400">◆</span>
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-gray-900 text-sm">{rec.title}</span>
          {rec.payload?.alreadyDetected && <span className="text-[9px] uppercase tracking-wide font-bold text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded-full">{he ? "זוהה אצלכם" : "detected"}</span>}
          <EvidenceInfo he={he} evidence={rec.payload?.evidence} />
        </div>
        {rec.reason && <p className="text-xs text-gray-500 mt-0.5">{rec.reason}</p>}
      </div>
      <div className="flex items-center gap-2.5 shrink-0">
        {connectable && (
          <button type="button" onClick={() => onConnect!(rec.targetSlug as CoreSystemSlug)}
            className="text-xs font-semibold px-3.5 py-1.5 rounded-lg bg-primary-500 text-white hover:bg-primary-600 transition">
            {he ? "התחברו ←" : "Connect →"}
          </button>
        )}
        <button type="button" onClick={onDismiss} className="text-[11px] text-gray-400 hover:text-gray-600">{he ? "לא רלוונטי" : "Not relevant"}</button>
      </div>
    </div>
  );
}

// ⓘ "How do I know this?" — the honest provenance of a recommendation, from
// the real scan log: a code fingerprint, an identifier found on a page, a
// checked absence, or an AI suggestion grounded in the business profile.
function EvidenceInfo({ he, evidence }: { he: boolean; evidence?: { source?: string; detail?: string; identifier?: string } | null }) {
  const [open, setOpen] = useState(false);
  if (!evidence?.source) return null;
  const text = (() => {
    if (evidence.source === "site_scan") {
      if (evidence.detail === "code_fingerprint") return he ? "זוהה בסריקת האתר שלכם — טביעת הקוד של הכלי נמצאה בעמודים שנקראו." : "Detected during your site scan — the tool's code fingerprint was found on the pages we read.";
      if (evidence.detail === "identifier_found") return he ? `נמצא באתר שלכם בסריקה${evidence.identifier ? `: ${evidence.identifier}` : ""}.` : `Found on your website during the scan${evidence.identifier ? `: ${evidence.identifier}` : ""}.`;
      if (evidence.detail === "absence_after_scan") return he ? "נבדק בסריקת האתר — לא נמצא, ולכן מומלץ." : "Checked during the site scan — not found, hence the recommendation.";
      return he ? "מבוסס על סריקת האתר שלכם." : "Based on your site scan.";
    }
    return he ? "המלצת AI על סמך פרופיל העסק שלכם — לא זוהה ישירות באתר." : "AI recommendation based on your business profile — not directly detected on your site.";
  })();
  return (
    <span className="relative inline-flex">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={he ? "איך מצאתי את זה?" : "How do I know this?"}
        className="w-4 h-4 rounded-full border border-gray-300 text-gray-400 hover:text-primary-600 hover:border-primary-300 text-[10px] leading-none flex items-center justify-center transition">
        i
      </button>
      {open && (
        <>
          <button type="button" className="fixed inset-0 z-10 cursor-default" onClick={() => setOpen(false)} aria-hidden />
          <span className={"absolute z-20 top-6 w-64 rounded-xl border border-gray-150 bg-white shadow-float p-3 text-[11px] leading-relaxed text-gray-600 " + (he ? "left-0" : "right-0")}>
            <span className="block font-semibold text-gray-800 mb-1">{he ? "איך אני יודע את זה?" : "How do I know this?"}</span>
            {text}
          </span>
        </>
      )}
    </span>
  );
}

// ─── Movement 6: Knowledge I'd love to learn ────────────────
// Real intake, three ways: teach-by-URL (help center / docs / policies), file
// upload (PDF/DOCX/TXT — straight into the tenant's first knowledge base), and
// Google Drive (OAuth → pick files → first sync + hourly auto-sync). Notion is
// the only honest "later". The wizard works against the tenant's first KB,
// created lazily under the same name the /teach endpoint uses.
const KB_URL_SOURCES: Array<{ key: string; label: [string, string]; icon: string }> = [
  { key: "help_center", label: ["Help Center", "מרכז עזרה"], icon: "book" },
  { key: "website_docs", label: ["Website docs", "מסמכי אתר"], icon: "globe" },
  { key: "policies", label: ["Policies", "מדיניות"], icon: "file" },
];

const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";

function KnowledgeScreen({ he, token, gaps, onTeach, onContinue, onBack }: {
  he: boolean; token: string; gaps: DiscoveryGap[]; onTeach: (label: string, method: "text" | "url", value: string) => Promise<boolean>; onContinue: () => void; onBack: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [addedKeys, setAddedKeys] = useState<Set<string>>(new Set());
  const [kbErr, setKbErr] = useState("");

  // The tenant's first knowledge base + its Drive integration (if connected).
  const [kbId, setKbId] = useState<string | null>(null);
  const [driveInt, setDriveInt] = useState<{ id: string } | null>(null);

  // File upload state
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadedCount, setUploadedCount] = useState(0);

  // Drive picker state
  const [pickerOpen, setPickerOpen] = useState(false);
  const [driveFiles, setDriveFiles] = useState<any[]>([]);
  const [driveStack, setDriveStack] = useState<Array<{ id: string; name: string }>>([]);
  const [driveSelected, setDriveSelected] = useState<Set<string>>(new Set());
  const [driveBusy, setDriveBusy] = useState(false);
  const [syncedCount, setSyncedCount] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await getKnowledgeBases(token);
        const kb = (r.data || [])[0];
        if (!alive || !kb?.id) return;
        setKbId(kb.id);
        const ints = await getKnowledgeIntegrations(token, kb.id).catch(() => null);
        if (!alive) return;
        const drive = (ints?.data || []).find((i: any) => i.provider === "google_drive");
        if (drive) {
          setDriveInt({ id: drive.id });
          const cfg = drive.config || {};
          if (Array.isArray(cfg.fileIds) && cfg.fileIds.length) setSyncedCount(cfg.fileIds.length);
        }
      } catch { /* tiles degrade to their connect states */ }
    })();
    return () => { alive = false; };
  }, [token]);

  async function ensureKb(): Promise<string | null> {
    if (kbId) return kbId;
    try {
      const created = await createKnowledgeBase(token, { name: "Company Knowledge", description: "Taught during onboarding" });
      const id = created.data?.id || null;
      if (id) setKbId(id);
      return id;
    } catch {
      setKbErr(he ? "לא הצלחתי להכין את מאגר הידע. נסו שוב." : "Couldn't prepare the knowledge base. Try again.");
      return null;
    }
  }

  async function addSource(key: string, label: string) {
    if (!url.trim()) return;
    setBusy(true);
    const ok = await onTeach(label, "url", url.trim());
    setBusy(false);
    if (ok) { setAddedKeys((p) => new Set(p).add(key)); setOpen(null); setUrl(""); }
  }

  async function onFilesChosen(files: FileList | null) {
    if (!files?.length || uploading) return;
    setKbErr("");
    setUploading(true);
    const id = await ensureKb();
    if (!id) { setUploading(false); return; }
    let ok = 0;
    for (const f of Array.from(files)) {
      try { await uploadKnowledgeFile(token, id, f, f.name); ok++; }
      catch (e: any) { setKbErr(e?.message || (he ? "העלאה נכשלה" : "Upload failed")); }
    }
    setUploadedCount((c) => c + ok);
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function connectDrive() {
    setKbErr("");
    const id = await ensureKb();
    if (!id) return;
    try {
      const { url: authUrl } = await initGoogleDriveOAuth(token, id, "onboarding");
      window.location.href = authUrl; // full OAuth redirect; we resume on /setup return
    } catch (e: any) {
      setKbErr(e?.message || (he ? "לא הצלחתי להתחיל את חיבור Google Drive." : "Couldn't start the Google Drive connection."));
    }
  }

  async function loadDrive(folderId?: string) {
    if (!driveInt) return;
    setDriveBusy(true);
    try {
      const r = await getDriveFiles(token, driveInt.id, folderId);
      setDriveFiles(r.data || []);
    } catch (e: any) {
      setKbErr(e?.message || (he ? "לא הצלחתי לקרוא מ-Drive." : "Couldn't read from Drive."));
    } finally {
      setDriveBusy(false);
    }
  }

  async function openPicker() { setPickerOpen(true); setDriveStack([]); setDriveSelected(new Set()); await loadDrive(); }
  async function enterFolder(f: any) { setDriveStack((s) => [...s, { id: f.id, name: f.name }]); await loadDrive(f.id); }
  async function backFolder() {
    const next = driveStack.slice(0, -1);
    setDriveStack(next);
    await loadDrive(next.length ? next[next.length - 1]!.id : undefined);
  }
  function toggleFile(id: string) {
    setDriveSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }
  async function syncSelected() {
    if (!driveInt || driveSelected.size === 0) return;
    setDriveBusy(true);
    try {
      await syncDriveFiles(token, driveInt.id, Array.from(driveSelected));
      setSyncedCount((c) => (c || 0) + driveSelected.size);
      setPickerOpen(false);
    } catch (e: any) {
      setKbErr(e?.message || (he ? "הסנכרון נכשל." : "Sync failed."));
    } finally {
      setDriveBusy(false);
    }
  }

  const tileCls = "rounded-2xl border border-gray-150 bg-white shadow-subtle p-4";

  return (
    <div dir={he ? "rtl" : "ltr"}>
      <h1 className="text-4xl md:text-[44px] font-bold text-gray-900 tracking-tight leading-[1.08]">{he ? "ידע שאשמח ללמוד" : "Knowledge I'd love to learn"}</h1>
      <p className="text-lg text-gray-500 mt-3 leading-relaxed max-w-2xl">{he ? "ככל שתלמדו אותי יותר, כך אענה מדויק יותר. הכול אופציונלי — ואפשר להוסיף בהמשך." : "The more you teach me, the more accurately I answer. All optional — you can add more later."}</p>

      {kbErr && <div className="mt-4 p-3 rounded-xl bg-amber-50 border border-amber-100 text-amber-700 text-sm">{kbErr}</div>}

      {/* Contextual gap asks — only genuinely teachable ones (knowledge/
          business/brand). Missing widgets & systems are recommendations. */}
      {gaps.filter((g) => TEACHABLE_GAP_DOMAINS.has(g.domain)).length > 0 && (
        <div className="mt-6 space-y-2.5">
          {gaps.filter((g) => TEACHABLE_GAP_DOMAINS.has(g.domain)).slice(0, 4).map((g) => <TeachCard key={g.id} he={he} gap={g} onTeach={onTeach} />)}
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-2.5 mt-4">
        {/* File upload — real, straight into the knowledge base. */}
        <div className={tileCls}>
          <div className="flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-lg bg-gray-50 flex items-center justify-center shrink-0"><Glyph name="file" size={16} className="text-gray-400" /></span>
            <div className="flex-1 min-w-0">
              <span className="font-medium text-gray-800 text-sm block">{he ? "קבצים (PDF, Word, טקסט)" : "Files (PDF, Word, text)"}</span>
              {uploadedCount > 0 && <span className="text-[11px] text-emerald-600">{he ? `${uploadedCount} קבצים נלמדו ✓` : `${uploadedCount} files learned ✓`}</span>}
            </div>
            <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading}
              className="text-xs font-medium text-primary-600 hover:text-primary-700 disabled:opacity-50">
              {uploading ? (he ? "מעלה…" : "Uploading…") : (he ? "העלו קבצים" : "Upload files")}
            </button>
            <input ref={fileRef} type="file" multiple accept=".pdf,.doc,.docx,.txt,.md,.csv" className="hidden" onChange={(e) => onFilesChosen(e.target.files)} />
          </div>
          <p className="text-[11px] text-gray-400 mt-2">{he ? "עד 10MB לקובץ. אני קורא ולומד אותם מיד." : "Up to 10MB per file. I read and learn them immediately."}</p>
        </div>

        {/* Google Drive — OAuth, pick files, first sync + hourly auto-sync. */}
        <div className={tileCls}>
          <div className="flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-lg bg-gray-50 flex items-center justify-center shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="https://cdn.simpleicons.org/googledrive" alt="" className="w-4 h-4 object-contain" onError={(e) => { e.currentTarget.style.display = "none"; }} />
            </span>
            <div className="flex-1 min-w-0">
              <span className="font-medium text-gray-800 text-sm block">Google Drive</span>
              {syncedCount !== null && <span className="text-[11px] text-emerald-600">{he ? `${syncedCount} קבצים מסונכרנים ✓ · מתעדכן כל שעה` : `${syncedCount} files synced ✓ · refreshes hourly`}</span>}
            </div>
            {!driveInt ? (
              <button type="button" onClick={connectDrive} className="text-xs font-medium text-primary-600 hover:text-primary-700">{he ? "התחברו" : "Connect"}</button>
            ) : (
              <button type="button" onClick={openPicker} disabled={driveBusy} className="text-xs font-medium text-primary-600 hover:text-primary-700 disabled:opacity-50">{he ? "בחרו קבצים" : "Pick files"}</button>
            )}
          </div>

          {pickerOpen && driveInt && (
            <div className="mt-3 rounded-xl border border-gray-150 bg-gray-50/60 p-2.5">
              <div className="flex items-center gap-2 mb-1.5 px-1">
                {driveStack.length > 0 && (
                  <button type="button" onClick={backFolder} disabled={driveBusy} className="text-[11px] font-medium text-gray-500 hover:text-gray-700">{he ? "→ חזרה" : "← Back"}</button>
                )}
                <span className="text-[11px] text-gray-400 truncate">{driveStack.length ? driveStack[driveStack.length - 1]!.name : (he ? "האחסון שלי" : "My Drive")}</span>
              </div>
              <div className="max-h-52 overflow-y-auto space-y-0.5">
                {driveBusy && driveFiles.length === 0 ? (
                  <p className="text-xs text-gray-400 p-2">{he ? "טוען…" : "Loading…"}</p>
                ) : driveFiles.length === 0 ? (
                  <p className="text-xs text-gray-400 p-2">{he ? "אין כאן קבצים." : "Nothing here."}</p>
                ) : driveFiles.map((f: any) => f.mimeType === DRIVE_FOLDER_MIME ? (
                  <button key={f.id} type="button" onClick={() => enterFolder(f)} disabled={driveBusy}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white text-start">
                    <span className="text-gray-400">▸</span><span className="text-sm text-gray-700 truncate">{f.name}</span>
                  </button>
                ) : (
                  <label key={f.id} className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white cursor-pointer">
                    <input type="checkbox" checked={driveSelected.has(f.id)} onChange={() => toggleFile(f.id)} />
                    <span className="text-sm text-gray-700 truncate">{f.name}</span>
                  </label>
                ))}
              </div>
              <div className="flex items-center justify-between mt-2 px-1">
                <button type="button" onClick={() => setPickerOpen(false)} className="text-[11px] text-gray-400 hover:text-gray-600">{he ? "ביטול" : "Cancel"}</button>
                <button type="button" onClick={syncSelected} disabled={driveBusy || driveSelected.size === 0}
                  className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50">
                  {driveBusy ? (he ? "מסנכרן…" : "Syncing…") : (he ? `סנכרנו ${driveSelected.size} קבצים` : `Sync ${driveSelected.size} files`)}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Teach-by-URL sources. */}
        {KB_URL_SOURCES.map((s) => {
          const added = addedKeys.has(s.key);
          return (
            <div key={s.key} className={tileCls}>
              <div className="flex items-center gap-2.5">
                <span className="w-8 h-8 rounded-lg bg-gray-50 flex items-center justify-center shrink-0"><Glyph name={s.icon} size={16} className="text-gray-400" /></span>
                <span className="font-medium text-gray-800 text-sm flex-1">{s.label[he ? 1 : 0]}</span>
                {added ? <span className="text-emerald-500 text-sm">✓</span>
                  : <button type="button" onClick={() => { setOpen(open === s.key ? null : s.key); setUrl(""); }} className="text-xs font-medium text-primary-600 hover:text-primary-700">{he ? "הוסף קישור" : "Add URL"}</button>}
              </div>
              {open === s.key && (
                <div className="mt-2.5 flex gap-1.5">
                  <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" dir="ltr" className="flex-1 px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-primary-200" />
                  <button type="button" onClick={() => addSource(s.key, s.label[0])} disabled={busy || !url.trim()} className="text-xs font-semibold px-3 py-2 rounded-lg bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50">{busy ? "…" : (he ? "למד" : "Learn")}</button>
                </div>
              )}
            </div>
          );
        })}

        {/* Notion — the one honest "later" (no connector yet). */}
        <div className={tileCls}>
          <div className="flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-lg bg-gray-50 flex items-center justify-center shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="https://cdn.simpleicons.org/notion" alt="" className="w-4 h-4 object-contain" onError={(e) => { e.currentTarget.style.display = "none"; }} />
            </span>
            <span className="font-medium text-gray-800 text-sm flex-1">Notion</span>
            <span className="text-[11px] text-gray-400">{he ? "בקרוב" : "coming soon"}</span>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between mt-12">
        <button type="button" onClick={onBack} className="text-sm font-medium text-gray-500 hover:text-gray-700">{he ? "→ חזרה" : "← Back"}</button>
        <button type="button" onClick={onContinue} className="px-8 py-3.5 bg-primary-500 hover:bg-primary-600 text-white text-base font-semibold rounded-2xl transition shadow-lg shadow-primary-500/25">{he ? "המשך ←" : "Continue →"}</button>
      </div>
    </div>
  );
}

// ─── Movement 7: Meet & shape who I'd hire first ─────────────
// The creation step: the employee arrives NAMED with an on-brand voice; the
// owner can rename them inline (persisted — /complete hires under this name)
// and sees exactly how they'll open a conversation.
function MeetScreen({ he, token, disc, rec, health, onRename, onContinue, onBack }: { he: boolean; token: string; disc: BusinessDiscoveryRecord | null; rec: DiscoveryRecommendation | null; health: HealthReport | null; onRename: (name: string) => void; onContinue: () => void; onBack: () => void }) {
  const role = rec?.employeeRole || "customer_support";
  const initialName = rec?.employeeName?.trim() || ROLE_LABEL[role]?.[he ? 1 : 0] || (he ? "עובד AI לתמיכה" : "Customer Support AI Employee");
  const [name, setName] = useState(initialName);
  const [savedTick, setSavedTick] = useState(false);
  const b = disc?.business || {};
  const brand = disc?.brand || {};
  const personality = brand.personality || brand.tone || brand.voice || (he ? "מקצועי, ברור ואדיב" : "professional, clear, and friendly");
  const mission = ROLE_MISSION[role]?.[he ? 1 : 0] || ROLE_MISSION.customer_support[he ? 1 : 0];
  const greeting = brand.greetingExample?.trim()
    || (he ? `היי! אני ${name} 😊 איך אפשר לעזור?` : `Hi! I'm ${name} 😊 how can I help?`);

  async function saveName() {
    const clean = name.trim();
    if (!clean || clean === rec?.employeeName) return;
    onRename(clean);
    setSavedTick(true);
    setTimeout(() => setSavedTick(false), 1600);
    await patchBusinessDiscovery(token, { employeeName: clean }).catch(() => {});
  }

  const knows: string[] = [];
  if (b.industry) knows.push(he ? `התחום שלכם: ${b.industry}` : `Your industry: ${b.industry}`);
  if ((b.products || []).length) knows.push(he ? `${b.products!.length} קווי מוצר` : `${b.products!.length} product lines`);
  if (brand.voice) knows.push(he ? "קול המותג שלכם" : "Your brand voice");
  (disc?.brand?.languages || []).length && knows.push(he ? `שפות: ${disc!.brand!.languages!.join(", ")}` : `Speaks ${disc!.brand!.languages!.join(", ")}`);
  (health?.knowledge || []).filter((i) => i.ok).forEach((i) => knows.push(healthLabel(he, i.label)));
  const needs = (disc?.gaps || []).slice(0, 3).map((g) => g.label);

  return (
    <div dir={he ? "rtl" : "ltr"}>
      <p className="text-[12px] font-semibold text-primary-500 uppercase tracking-[0.22em] mb-3">{he ? "הכירו את מי שהייתי שוכר קודם" : "Meet who I'd hire first"}</p>
      <div className="flex items-center gap-4">
        <div className="w-14 h-14 rounded-2xl bg-primary-500 text-white flex items-center justify-center text-xl font-bold shrink-0">{(name.trim() || "A").charAt(0)}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              maxLength={60}
              aria-label={he ? "שם העובד/ת" : "Employee name"}
              className="text-3xl md:text-4xl font-bold text-gray-900 tracking-tight bg-transparent border-b-2 border-transparent hover:border-gray-200 focus:border-primary-400 outline-none transition-colors min-w-0 w-full max-w-md"
            />
            {savedTick && <span className="text-emerald-500 text-sm shrink-0 animate-popIn">✓</span>}
          </div>
          <p className="text-base text-gray-500 mt-1">{he ? "העובד/ת ה-AI שלכם — אפשר לשנות את השם" : "Your AI teammate — click the name to change it"}</p>
        </div>
      </div>

      {/* How they'll sound: the real on-brand opener, as a chat bubble. */}
      <div className="mt-6 p-4 rounded-2xl bg-white border border-gray-150 shadow-subtle">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400 mb-2">{he ? "כך אפתח שיחה עם לקוח" : "How I'll open a conversation"}</p>
        <div className="flex justify-start">
          <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-es-md bg-primary-50 border border-primary-100 text-[15px] text-gray-800 leading-relaxed">{greeting}</div>
        </div>
      </div>

      <div className="mt-6 space-y-4">
        <MeetRow he={he} label={["Personality", "אישיות"]} value={personality} />
        <MeetRow he={he} label={["Mission", "משימה"]} value={mission} />
        {rec?.reason && <MeetRow he={he} label={["Why this teammate", "למה דווקא הוא/היא"]} value={rec.reason} />}
        {knows.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5">{he ? "מה כבר יודע/ת" : "What they already know"}</p>
            <div className="flex flex-wrap gap-1.5">{knows.slice(0, 8).map((k, i) => <span key={i} className="text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-100">{k}</span>)}</div>
          </div>
        )}
        {needs.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5">{he ? "מה עוד צריך/ה" : "What they still need"}</p>
            <ul className="space-y-1">{needs.map((n, i) => <li key={i} className="text-sm text-gray-600 flex items-start gap-2"><WarnIcon />{n}</li>)}</ul>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between mt-12">
        <button type="button" onClick={onBack} className="text-sm font-medium text-gray-500 hover:text-gray-700">{he ? "→ חזרה" : "← Back"}</button>
        <button type="button" onClick={onContinue} className="px-8 py-3.5 bg-primary-500 hover:bg-primary-600 text-white text-base font-semibold rounded-2xl transition shadow-lg shadow-primary-500/25">{he ? `בואו ניצור את ${name} ←` : `Create ${name} →`}</button>
      </div>
    </div>
  );
}
function MeetRow({ he, label, value }: { he: boolean; label: [string, string]; value: string }) {
  return (
    <div>
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-0.5">{label[he ? 1 : 0]}</p>
      <p className="max-w-[65ch] text-[15px] text-gray-700 leading-relaxed">{value}</p>
    </div>
  );
}

// ─── Movement 8: Create & tune the employee (chat before deploy) ─
const TONE_LABEL: Record<string, [string, string]> = {
  professional: ["Professional", "מקצועי"], friendly: ["Friendly", "ידידותי"], casual: ["Casual", "קליל"], formal: ["Formal", "רשמי"],
};
function TuneScreen({ he, token, rec, disc, onContinue, onBack }: { he: boolean; token: string; rec: DiscoveryRecommendation | null; disc: BusinessDiscoveryRecord | null; onContinue: () => void; onBack: () => void }) {
  const role = rec?.employeeRole || "customer_support";
  const name = rec?.employeeName?.trim() || ROLE_LABEL[role]?.[he ? 1 : 0] || (he ? "עובד AI לתמיכה" : "Customer Support AI Employee");
  // Rehydrate from the persisted transcript/persona so a reload mid-tune resumes
  // the conversation instead of silently discarding it (U-2).
  const seededTranscript = disc?.tuneTranscript && disc.tuneTranscript.length ? disc.tuneTranscript : null;
  const seededPersona = ((disc?.recommendation as any)?.tunedPersona as EmployeePersona | undefined) || null;
  const [messages, setMessages] = useState<Array<{ role: "user" | "assistant"; content: string }>>(
    seededTranscript || [
      {
        role: "assistant",
        // Open with the REAL on-brand greeting (learned from the site), then
        // the tune framing — the owner hears their own voice from turn one.
        content: disc?.brand?.greetingExample?.trim()
          ? `${disc.brand.greetingExample.trim()}\n\n${he ? "זו אני — ככה אפתח שיחות. רוצים לשנות משהו באופן שבו אני עובדת לפני שנתחיל?" : "That's me — how I'll open conversations. Want to change anything about how I work before we start?"}`
          : (he ? `שלום! אני ${name}. הוכנתי ומוכן להתחיל — אבל קודם, יש משהו שתרצו שאשנה באופן שבו אני עובד?` : `Hi! I'm ${name}. I'm set up and ready — but first, anything you'd like me to change about how I work?`),
      },
    ],
  );
  const [persona, setPersona] = useState<EmployeePersona>(seededPersona || { tone: "professional" });
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, busy]);

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    const next = [...messages, { role: "user" as const, content }];
    setMessages(next);
    setInput("");
    setBusy(true);
    try {
      const res = await employeeChat(token, next, persona, he ? "he" : "en");
      if (res.data.ok) {
        if (res.data.persona) setPersona(res.data.persona);
        setMessages((m) => [...m, { role: "assistant", content: res.data.reply || (he ? "בסדר!" : "Got it!") }]);
      } else {
        setMessages((m) => [...m, { role: "assistant", content: he ? "סליחה, לא הצלחתי להגיב כרגע." : "Sorry, I couldn't respond just now." }]);
      }
    } finally { setBusy(false); }
  }

  const chips = he ? ["תהיה יותר ידידותי", "התמקד יותר במכירות", "תהיה תמציתי יותר"] : ["Be friendlier", "Focus more on sales", "Be more concise"];

  return (
    <div dir={he ? "rtl" : "ltr"}>
      <h1 className="text-4xl md:text-[44px] font-bold text-gray-900 tracking-tight leading-[1.08]">{he ? `דברו עם ${name}` : `Chat with ${name}`}</h1>
      <p className="text-lg text-gray-500 mt-3 leading-relaxed max-w-2xl">{he ? "הכנתי אותו/ה עבורכם — עדיין לא הפעלתי. דברו איתו/ה וכוונו לפני שנתחיל." : "I've prepared them for you — not deployed yet. Talk to them and tune them before we start."}</p>

      {/* Live persona */}
      <div className="flex flex-wrap gap-1.5 mt-4">
        {persona.tone && <span className="text-[11px] px-2 py-0.5 rounded-full bg-primary-50 text-primary-600 border border-primary-100">{he ? "טון: " : "Tone: "}{TONE_LABEL[persona.tone]?.[he ? 1 : 0] || persona.tone}</span>}
        {persona.focus && <span className="text-[11px] px-2 py-0.5 rounded-full bg-primary-50 text-primary-600 border border-primary-100">{he ? "מיקוד: " : "Focus: "}{persona.focus}</span>}
        {(persona.instructions || []).slice(0, 3).map((ins, i) => <span key={i} className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 border border-gray-200">{ins}</span>)}
      </div>

      {/* Chat transcript */}
      <div className="mt-4 h-72 overflow-y-auto rounded-2xl border border-gray-100 bg-gray-50/50 p-4 space-y-3" aria-live="polite">
        {messages.map((m, i) => (
          <div key={i} className={"flex " + (m.role === "user" ? "justify-end" : "justify-start")}>
            <div className={"max-w-[80%] px-3.5 py-2 rounded-2xl text-sm leading-relaxed " + (m.role === "user" ? "bg-primary-500 text-white" : "bg-white border border-gray-150 text-gray-800")}>{m.content}</div>
          </div>
        ))}
        {busy && <div className="flex justify-start"><div className="px-3.5 py-2 rounded-2xl bg-white border border-gray-150 text-gray-400 text-sm">…</div></div>}
        <div ref={endRef} />
      </div>

      {/* Quick tuning chips */}
      <div className="flex flex-wrap gap-1.5 mt-3">
        {chips.map((c) => <button key={c} type="button" onClick={() => send(c)} disabled={busy} className="text-xs font-medium px-3 py-1.5 rounded-lg bg-white border border-gray-200 hover:border-primary-300 disabled:opacity-50">{c}</button>)}
      </div>

      {/* Composer */}
      <div className="flex gap-2 mt-3">
        <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") send(input); }} placeholder={he ? "כתבו הודעה…" : "Type a message…"} className="flex-1 px-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-primary-200" />
        <button type="button" onClick={() => send(input)} disabled={busy || !input.trim()} className="px-5 py-2.5 bg-gray-900 hover:bg-gray-800 text-white text-sm font-medium rounded-xl transition disabled:opacity-40">{he ? "שלח" : "Send"}</button>
      </div>

      <div className="flex items-center justify-between mt-12">
        <button type="button" onClick={onBack} className="text-sm font-medium text-gray-500 hover:text-gray-700">{he ? "→ חזרה" : "← Back"}</button>
        <button type="button" onClick={onContinue} className="px-8 py-3.5 bg-primary-500 hover:bg-primary-600 text-white text-base font-semibold rounded-2xl transition shadow-lg shadow-primary-500/25">{he ? `${name} מוכן/ה — לפריסה ←` : `${name} is ready — deploy →`}</button>
      </div>
    </div>
  );
}

// ─── Movement 5: One Question ───────────────────────────────
function GoalScreen({ he, goal, setGoal, goalDetail, setGoalDetail, onContinue, saving, onBack }: { he: boolean; goal: string; setGoal: (v: string) => void; goalDetail: string; setGoalDetail: (v: string) => void; onContinue: () => void; saving: boolean; onBack: () => void }) {
  // Arrow keys move the selection (Typeform-style); the global Enter advances.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
      const t = e.target as HTMLElement | null;
      if (t && t.closest("input, textarea, select")) return;
      e.preventDefault();
      const idx = GOALS.findIndex((g) => g.slug === goal);
      const delta = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
      setGoal(GOALS[(idx + delta + GOALS.length) % GOALS.length]!.slug);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goal, setGoal]);
  return (
    <div dir={he ? "rtl" : "ltr"}>
      <h1 className="text-4xl md:text-[44px] font-bold text-gray-900 tracking-tight leading-[1.08]">{he ? "מה הכי חשוב לכם עכשיו?" : "What's your primary goal?"}</h1>
      <p className="text-lg text-gray-500 mt-3 leading-relaxed max-w-2xl">{he ? "שאלה אחת — התשובה שלכם תעצב את כל השאר." : "One question — your answer shapes everything else."}</p>
      <div className="grid sm:grid-cols-2 gap-3 mt-6">
        {GOALS.map((g) => {
          const active = goal === g.slug;
          return (
            <button key={g.slug} type="button" onClick={() => setGoal(g.slug)}
              className={"flex items-start gap-3 p-6 rounded-3xl border text-start transition " + (active ? "border-primary-400 ring-2 ring-primary-200 bg-primary-50/40" : "border-gray-150 bg-white shadow-subtle hover:border-primary-300 hover:shadow-card")}>
              <span className="w-11 h-11 rounded-2xl bg-primary-50 flex items-center justify-center shrink-0"><Glyph name={g.icon} /></span>
              <span className="min-w-0">
                <span className="block font-semibold text-gray-900">{g.label[he ? 1 : 0]}</span>
                <span className="block text-xs text-gray-500 mt-0.5">{g.desc[he ? 1 : 0]}</span>
              </span>
            </button>
          );
        })}
      </div>

      {/* "Something else" earns its text box — tell me what matters most. */}
      {goal === "other" && (
        <div className="mt-4 animate-stageIn">
          <textarea
            value={goalDetail}
            onChange={(e) => setGoalDetail(e.target.value)}
            rows={3}
            maxLength={500}
            autoFocus
            placeholder={he ? "ספרו לי במילים שלכם — מה הכי חשוב שה-AI יעשה עבורכם?" : "Tell me in your own words — what matters most for your AI to do?"}
            className="w-full max-w-2xl px-4 py-3 bg-white border border-gray-200 rounded-2xl text-sm leading-relaxed outline-none focus:ring-2 focus:ring-primary-200 focus:border-primary-300 resize-none shadow-subtle"
          />
        </div>
      )}

      <div className="flex items-center justify-between mt-12">
        <button type="button" onClick={onBack} className="text-sm font-medium text-gray-500 hover:text-gray-700">{he ? "→ חזרה" : "← Back"}</button>
        <button type="button" onClick={onContinue} disabled={!goal || saving || (goal === "other" && !goalDetail.trim())} className="px-8 py-3.5 bg-primary-500 hover:bg-primary-600 text-white text-base font-semibold rounded-2xl transition shadow-lg shadow-primary-500/25 disabled:opacity-50">
          {saving ? (he ? "שומר…" : "Saving…") : (he ? "המשך ←" : "Continue →")}
        </button>
      </div>
    </div>
  );
}

// ─── Movement 3: Connect your source of truth ───────────────
// Lead with the strongest DETECTED system as one large primary card; a quiet
// "I use another platform" link reveals the full catalog only on intent.
type SystemDef = (typeof SYSTEMS)[number];

function SystemTile({ he, s, large, picked, setPicked, shopDomain, setShopDomain, fireberryToken, setFireberryToken, connecting, onConnect, recommended }: {
  he: boolean; s: SystemDef; large?: boolean; picked: CoreSystemSlug | null; setPicked: (v: CoreSystemSlug | null) => void;
  shopDomain: string; setShopDomain: (v: string) => void; fireberryToken: string; setFireberryToken: (v: string) => void;
  connecting: boolean; onConnect: (slug: CoreSystemSlug) => void; recommended?: boolean;
}) {
  const active = picked === s.slug;
  return (
    <div>
      <button type="button" onClick={() => setPicked(s.slug)}
        className={"w-full text-start rounded-2xl border transition relative " + (large ? "p-7 " : "p-5 ") + (active ? "border-primary-400 ring-2 ring-primary-200 bg-primary-50/40" : "border-gray-150 bg-white shadow-subtle hover:border-primary-300 hover:shadow-card")}>
        {recommended && <span className={"absolute top-3 text-[9px] uppercase tracking-wide font-bold text-primary-600 bg-primary-100 px-1.5 py-0.5 rounded-full " + (he ? "left-3" : "right-3")}>{he ? "זוהה אצלכם" : "Detected"}</span>}
        <div className={"flex items-center gap-3 " + (large ? "mb-3" : "mb-2")}>
          <div className={"rounded-xl bg-white border border-gray-100 p-1.5 flex items-center justify-center relative " + (large ? "w-14 h-14" : "w-10 h-10")}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={s.logo} alt={s.name} className="w-full h-full object-contain" onError={(e) => { const img = e.currentTarget; img.style.display = "none"; const fb = img.nextElementSibling as HTMLElement | null; if (fb) fb.style.display = "flex"; }} />
            <span className="absolute inset-0 hidden items-center justify-center text-sm font-bold text-gray-500">{s.name.charAt(0)}</span>
          </div>
          <div><div className={"font-semibold text-gray-900 " + (large ? "text-xl" : "")}>{s.name}</div><div className="text-[10px] uppercase tracking-wide text-gray-400">{s.group}</div></div>
        </div>
        <p className={"text-gray-600 " + (large ? "text-[15px]" : "text-sm")}>{he ? "חברו " : "Connect "}{s.name} {s.value[he ? 1 : 0]}</p>
      </button>
      {active && s.slug === "shopify" && (
        <input value={shopDomain} onChange={(e) => setShopDomain(e.target.value)} placeholder="my-store.myshopify.com" className="mt-2 w-full px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 outline-none" />
      )}
      {active && s.slug === "fireberry" && (
        <div className="mt-2">
          <input value={fireberryToken} onChange={(e) => setFireberryToken(e.target.value)} type="password" placeholder={he ? "טוקן API (tokenid)" : "API token (tokenid)"} className="w-full px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 outline-none" />
          <p className="text-[11px] text-gray-400 mt-1">{he ? "Fireberry ← הגדרות ← אינטגרציה ← API ← הטוקן שלי" : "Fireberry → Settings → Integration → API Forms → My Token"}</p>
        </div>
      )}
      {active && (
        <button type="button" onClick={() => onConnect(s.slug)} disabled={connecting || (s.slug === "shopify" && !shopDomain.trim()) || (s.slug === "fireberry" && !fireberryToken.trim())} className="mt-2 w-full py-2.5 bg-primary-500 hover:bg-primary-600 text-white text-sm font-medium rounded-xl transition disabled:opacity-50">
          {connecting ? (he ? "מתחבר…" : "Connecting…") : `${he ? "התחבר ל" : "Connect "}${s.name} →`}
        </button>
      )}
    </div>
  );
}

function ConnectScreen(props: {
  he: boolean; systemQuery: string; setSystemQuery: (v: string) => void;
  picked: CoreSystemSlug | null; setPicked: (v: CoreSystemSlug | null) => void;
  shopDomain: string; setShopDomain: (v: string) => void; fireberryToken: string; setFireberryToken: (v: string) => void;
  connecting: boolean; skipping: boolean; onConnect: (slug: CoreSystemSlug) => void; onBack: () => void; onSkip: () => void;
  rec: DiscoveryRecommendation | null; disc: BusinessDiscoveryRecord | null;
}) {
  const { he, systemQuery, setSystemQuery, picked, setPicked, shopDomain, setShopDomain, fireberryToken, setFireberryToken, connecting, skipping, onConnect, onBack, onSkip, rec, disc } = props;
  const recommendedSlugs = new Set((rec?.systems || []).map((s) => s.slug));

  // The detected source of truth: an already-detected recommended system, or the
  // discovered store platform — whichever maps to a connectable system.
  const detectedFromRec = (rec?.systems || []).find((s) => s.alreadyDetected)?.slug?.toLowerCase();
  const platformSlug = disc?.technology?.platform?.slug?.toLowerCase();
  const detectedSlug = [detectedFromRec, platformSlug].find((sl) => SYSTEMS.some((x) => x.slug === sl)) as CoreSystemSlug | undefined;
  const primary = detectedSlug ? SYSTEMS.find((s) => s.slug === detectedSlug)! : null;

  // Show the full catalog when there's no detected primary OR when the caller
  // arrived with a specific system preselected (e.g. "Connect" on a Movement-5
  // recommendation) that isn't the primary card — its tile must be visible.
  const [showAll, setShowAll] = useState(!primary || (!!picked && picked !== primary.slug));
  const filtered = SYSTEMS.filter((s) => {
    const q = systemQuery.trim().toLowerCase();
    if (!q) return true;
    return s.name.toLowerCase().includes(q) || s.group.toLowerCase().includes(q) || s.slug.toLowerCase().includes(q);
  }).sort((a, b) => Number(recommendedSlugs.has(b.slug)) - Number(recommendedSlugs.has(a.slug)));

  const tileProps = { he, picked, setPicked, shopDomain, setShopDomain, fireberryToken, setFireberryToken, connecting, onConnect };

  return (
    <div dir={he ? "rtl" : "ltr"}>
      <h1 className="text-4xl md:text-[44px] font-bold text-gray-900 tracking-tight leading-[1.08]">{he ? "בואו נחבר את מקור-האמת שלכם" : "Let's connect your source of truth"}</h1>
      <p className="text-lg text-gray-500 mt-3 leading-relaxed max-w-2xl">{he ? "מערכת אחת שמכילה את הלקוחות/ההזמנות שלכם — זה כל מה שצריך כדי להתחיל." : "The one system that holds your customers or orders — that's all I need to start."}</p>

      {primary && !showAll ? (
        <div className="mt-6 space-y-4">
          <SystemTile {...tileProps} s={primary} large recommended />
          <button type="button" onClick={() => setShowAll(true)} className="text-sm font-medium text-primary-600 hover:text-primary-700">
            {he ? "אני משתמש/ת בפלטפורמה / CRM אחר →" : "I use another platform / CRM →"}
          </button>
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          <input value={systemQuery} onChange={(e) => setSystemQuery(e.target.value)} placeholder={he ? "חיפוש מערכת…" : "Search systems…"} className="w-full px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 outline-none" />
          <div className="grid sm:grid-cols-2 gap-3">
            {filtered.map((s) => <SystemTile key={s.slug} {...tileProps} s={s} recommended={recommendedSlugs.has(s.slug)} />)}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mt-12">
        <button type="button" onClick={onBack} disabled={connecting || skipping} className="text-sm font-medium text-gray-500 hover:text-gray-700 disabled:opacity-50">{he ? "→ חזרה" : "← Back"}</button>
        <button type="button" onClick={onSkip} disabled={connecting || skipping} className="text-sm font-medium text-gray-500 hover:text-gray-700 disabled:opacity-50">{he ? "לא עכשיו — נשמר להמשך" : "Not now — saved for later"}</button>
      </div>
    </div>
  );
}

// ─── Airtable mapping (post-OAuth) ──────────────────────────
function AirtableScreen(props: {
  he: boolean; atBases: AirtableMeta[]; atTables: AirtableMeta[]; atFields: AirtableField[];
  atBaseId: string; atTableId: string; atMap: Record<string, string>; setAtMap: (v: Record<string, string>) => void;
  atCreateMissing: boolean; setAtCreateMissing: (v: boolean) => void; atBusy: boolean;
  onPickBase: (id: string) => void; onPickTable: (id: string) => void; onSave: () => void; onBack: () => void;
}) {
  const { he, atBases, atTables, atFields, atBaseId, atTableId, atMap, setAtMap, atCreateMissing, setAtCreateMissing, atBusy, onPickBase, onPickTable, onSave, onBack } = props;
  return (
    <div className="max-w-2xl space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{he ? "מיפוי ה-Airtable שלכם" : "Map your Airtable"}</h1>
        <p className="text-sm text-gray-500 mt-1">{he ? "בחרו את הבסיס והטבלה של אנשי הקשר, ומפו את העמודות." : "Pick your contacts base + table, then map your columns."}</p>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">{he ? "בסיס" : "Base"}</label>
        <select value={atBaseId} onChange={(e) => onPickBase(e.target.value)} disabled={atBusy} className="w-full px-4 py-2.5 bg-white border border-gray-200 rounded-xl outline-none text-sm">
          <option value="">{he ? "בחרו בסיס…" : "Select a base…"}</option>
          {atBases.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </div>
      {atBaseId && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{he ? "טבלת אנשי קשר" : "Contacts table"}</label>
          <select value={atTableId} onChange={(e) => onPickTable(e.target.value)} disabled={atBusy} className="w-full px-4 py-2.5 bg-white border border-gray-200 rounded-xl outline-none text-sm">
            <option value="">{he ? "בחרו טבלה…" : "Select a table…"}</option>
            {atTables.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
      )}
      {atTableId && atFields.length > 0 && (
        <div className="space-y-3">
          {AIRTABLE_FIELDS.map((cf) => (
            <div key={cf.key}>
              <label className="block text-sm font-medium text-gray-700 mb-1">{cf.label[he ? 1 : 0]}{cf.required && <span className="text-red-400 ml-1">*</span>}</label>
              <select value={atMap[cf.key] || ""} onChange={(e) => setAtMap({ ...atMap, [cf.key]: e.target.value })} className="w-full px-4 py-2.5 bg-white border border-gray-200 rounded-xl outline-none text-sm">
                <option value="">{he ? "- ללא -" : "- none -"}</option>
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
      <button type="button" onClick={onSave} disabled={atBusy || !atTableId} className="w-full py-3 bg-primary-500 hover:bg-primary-600 text-white font-medium rounded-xl transition disabled:opacity-50 shadow-lg shadow-primary-500/25">
        {atBusy ? (he ? "שומר…" : "Saving…") : (he ? "סיום ←" : "Finish →")}
      </button>
      <div className="text-center">
        <button type="button" onClick={onBack} disabled={atBusy} className="text-sm font-medium text-gray-500 hover:text-gray-700 disabled:opacity-50">{he ? "→ חזרה" : "← Back"}</button>
      </div>
    </div>
  );
}

// ─── Movement 7: Meet your AI Employee ──────────────────────
// The reveal. The employee is introduced as if it has ALREADY joined the
// company and prepared everything before its first day. Nothing is created
// yet — the real AIAgent is generated only when the owner clicks "bring them
// on board" (→ the existing /complete generation flow, server-side).
function employeeName(he: boolean, rec: DiscoveryRecommendation | null): string {
  const named = rec?.employeeName?.trim();
  if (named) return named;
  if (rec) return ROLE_LABEL[rec.employeeRole]?.[he ? 1 : 0] || rec.employeeName;
  return he ? "עובד AI לתמיכה" : "Customer Support AI Employee";
}

function deriveCapabilities(he: boolean, disc: BusinessDiscoveryRecord | null, health: HealthReport | null): string[] {
  const out: string[] = [];
  const b = disc?.business || {};
  const kn = disc?.knowledge || {};
  const tools = disc?.technology?.tools || [];
  const hasStore = tools.some((t) => ["shopify", "woocommerce", "magento", "bigcommerce", "wix"].includes(t.slug));
  const coreConnected = (health?.tools || []).some((t) => t.ok && /connected/i.test(t.label));
  if (disc?.brand?.voice) out.push(he ? "לענות בקול המותג שלכם" : "Reply in your brand voice");
  if (kn.hasFaq || Object.values(kn.policies || {}).some((p: any) => p?.found === true)) {
    out.push(he ? "לענות על שאלות נפוצות מהאתר שלכם" : "Answer common questions from your site");
  }
  if (hasStore || coreConnected) out.push(he ? "לענות על שאלות מוצר והזמנה" : "Answer product & order questions");
  if (coreConnected) out.push(he ? "לדעת מי הלקוחות שלכם" : "Know who your customers are");
  out.push(he ? "לסמן כל דבר שלא בטוח בו — במקום לנחש" : "Flag anything it's unsure of — instead of guessing");
  if (b.industry && out.length < 5) out.unshift(he ? `להבין את תחום ה${b.industry}` : `Understand your ${b.industry} space`);
  return out.slice(0, 5);
}

function ReadyScreen({ he, disc, rec, health, onFinish }: { he: boolean; disc: BusinessDiscoveryRecord | null; rec: DiscoveryRecommendation | null; health: HealthReport | null; onFinish: () => void }) {
  const name = employeeName(he, rec);
  const b = disc?.business || {};

  // Beat 2 — what it already learned (from the discovery, not a live agent).
  const learned: string[] = [];
  if (b.industry) learned.push(he ? `התחום: ${b.industry}` : `Your industry: ${b.industry}`);
  if ((b.products || []).length) learned.push(he ? `${b.products!.length} קווי מוצר` : `${b.products!.length} product lines`);
  if (disc?.brand?.voice) learned.push(he ? `קול מותג: ${disc.brand.voice}` : `Brand voice: ${disc.brand.voice}`);
  const langs = disc?.brand?.languages || [];
  if (langs.length) learned.push(he ? `שפות: ${langs.join(", ")}` : `Speaks ${langs.join(", ")}`);
  (health?.knowledge || []).filter((i) => i.ok).forEach((i) => learned.push(healthLabel(he, i.label)));

  const canDo = deriveCapabilities(he, disc, health);
  const channels = (disc?.communication?.channels || []).filter((c) => PRIMARY_CHANNELS.has(c.type));

  return (
    <div className="space-y-5" dir={he ? "rtl" : "ltr"}>
      {/* Movement 9 — your employee is ready */}
      <div className="flex items-center gap-3">
        <div className="w-12 h-12 rounded-2xl bg-emerald-500 text-white flex items-center justify-center text-lg font-bold shrink-0">✓</div>
        <div>
          <h1 className="text-3xl md:text-4xl font-bold text-gray-900 tracking-tight">{he ? `${name} מוכן/ה` : `${name} is ready`}</h1>
          <p className="text-base text-gray-500 mt-1">{he ? "כוונתם, יצרתם — עכשיו רק להפעיל." : "You met them, you tuned them — now let's put them to work."}</p>
        </div>
      </div>

      {/* Beat 2 — what I already learned */}
      {learned.length > 0 && (
        <RevealBlock title={he ? "מה שכבר למדתי" : "What I already learned"}>
          <div className="flex flex-wrap gap-1.5">
            {learned.slice(0, 7).map((k, i) => <span key={i} className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 border border-gray-200">{k}</span>)}
          </div>
        </RevealBlock>
      )}

      {/* What it can already do — a short readiness confirmation. */}
      {canDo.length > 0 && (
        <RevealBlock title={he ? "מה שאני כבר יכול לעשות" : "What they can already do"}>
          <ul className="space-y-1">
            {canDo.slice(0, 4).map((c, i) => <li key={i} className="text-sm text-gray-700 flex items-start gap-2"><span className="text-emerald-500">✓</span>{c}</li>)}
          </ul>
        </RevealBlock>
      )}

      {/* Movement 9 — the detected channels, connect now or later (skippable). */}
      {channels.length > 0 && (
        <div className="p-5 rounded-2xl bg-white border border-gray-150 shadow-subtle">
          <p className="text-sm font-semibold text-gray-800">{he ? "אלה הערוצים שזיהיתי" : "These are the channels I detected"}</p>
          <p className="text-xs text-gray-500 mt-0.5 mb-3">{he ? "אפשר לחבר עכשיו או בהמשך — שום דבר לא הולך לאיבוד." : "Connect them now or later — nothing is lost."}</p>
          <div className="space-y-1.5">
            {channels.map((c, i) => {
              const meta = CHANNEL_META[c.type] || { icon: "🔗", label: [c.type, c.type] as [string, string] };
              return (
                <div key={i} className="flex items-center gap-2.5">
                  <ChannelIcon type={c.type} size={16} />
                  <span className="text-sm text-gray-700">{meta.label[he ? 1 : 0]}</span>
                  {c.identifier && <span className="text-xs text-gray-400 truncate" dir="ltr">{c.identifier}</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <button type="button" onClick={onFinish} className="inline-flex items-center justify-center px-8 py-4 bg-primary-500 hover:bg-primary-600 text-white text-base font-semibold rounded-2xl transition shadow-lg shadow-primary-500/25">
        {he ? `הפעילו את ${name} ←` : `Put ${name} to work →`}
      </button>
      <p className="text-[12px] text-gray-400">{he ? "מה שלא חיברתם נשמר כהמלצה וממשיך לחכות לכם." : "Anything you skipped is saved as a recommendation and keeps waiting for you."}</p>
    </div>
  );
}

function RevealBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">{title}</p>
      {children}
    </div>
  );
}

// ─── Shared bits ────────────────────────────────────────────
function Field({ label, value, onChange, placeholder, required, confidence }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; required?: boolean; confidence?: number }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="block text-sm font-medium text-gray-700">{label}{required && <span className="text-red-400 ml-1">*</span>}</label>
        {typeof confidence === "number" && <span className="text-[10px] text-gray-400">{confidence}% {value ? "" : ""}</span>}
      </div>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="w-full px-4 py-2.5 bg-white border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-200 focus:bg-white outline-none transition text-sm" />
    </div>
  );
}

function Chip({ text }: { text: string }) {
  return <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 border border-gray-200 capitalize">{text}</span>;
}

// The progress rail — a hairline of real progress pinned to the top of the
// viewport plus a quiet wordmark row, instead of in-content dots.
function MovementRail({ phase, he }: { phase: Phase; he: boolean }) {
  const order: Phase[] = ["discovering", "review", "connect", "goal", "integrations", "knowledge", "recommendation", "tune", "ready"];
  const idx = order.indexOf(phase === "airtable_mapping" ? "connect" : phase);
  if (idx < 0) return null;
  const pct = ((idx + 1) / order.length) * 100;
  return (
    <>
      <div className="fixed top-0 inset-x-0 h-1 bg-gray-100 z-40" dir={he ? "rtl" : "ltr"} role="progressbar" aria-valuemin={1} aria-valuemax={order.length} aria-valuenow={idx + 1} aria-label={he ? "התקדמות ההגדרה" : "Setup progress"}>
        <div className="h-full bg-gradient-to-r from-primary-500 to-primary-300 transition-all duration-700 ease-out" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex items-center justify-between mb-10 md:mb-14" dir={he ? "rtl" : "ltr"}>
        <Wordmark />
        <span className="text-[11px] font-semibold tracking-[0.18em] text-gray-400">{idx + 1} / {order.length}</span>
      </div>
    </>
  );
}

// Collapsible section — the core of the "breathing document" (Bible Law 11):
// headline visible, detail expandable on demand. Reused across movements.
function Collapsible({ he, title, confidence, defaultOpen = false, right, children }: {
  he: boolean; title: string; confidence?: string; defaultOpen?: boolean; right?: ReactNode; children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-gray-100 last:border-0">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex items-center justify-between w-full py-3.5 group">
        <span className="text-sm font-semibold text-gray-800 flex items-center gap-2">
          {title}
          {confidence && <ConfidenceChip he={he} c={confidence} />}
        </span>
        <span className="flex items-center gap-3">
          {right}
          <span className={"text-gray-300 text-xs transition-transform group-hover:text-gray-500 " + (open ? "rotate-180" : "")}>▼</span>
        </span>
      </button>
      {open && <div className="pb-5 -mt-1">{children}</div>}
    </section>
  );
}
