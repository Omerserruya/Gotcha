"use client";

/**
 * Movement 3 - "Connect your source of truth" - extracted from setup/page.tsx.
 *
 * Extraction exists for two reasons:
 *  1. Regression isolation: this component once violated the Rules of Hooks
 *     (a `useState` declared after the `justConnected` early return), which
 *     crashed the whole wizard with "Rendered more hooks than during the
 *     previous render" the moment a Shopify OAuth return toggled that flag.
 *     ALL hooks now run unconditionally before any return - keep it that way.
 *  2. Testability: page.tsx may only export the route component; a separate
 *     module lets vitest render ConnectScreen across its render branches.
 */

import { useState } from "react";
import {
  type CoreSystemSlug,
  type BusinessDiscoveryRecord,
  type DiscoveryRecommendation,
} from "@/lib/api";

export const SYSTEMS: Array<{
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

export type SystemDef = (typeof SYSTEMS)[number];

export function SystemTile({ he, s, large, picked, setPicked, shopDomain, setShopDomain, fireberryToken, setFireberryToken, airtableToken, setAirtableToken, connecting, onConnect, recommended }: {
  he: boolean; s: SystemDef; large?: boolean; picked: CoreSystemSlug | null; setPicked: (v: CoreSystemSlug | null) => void;
  shopDomain: string; setShopDomain: (v: string) => void; fireberryToken: string; setFireberryToken: (v: string) => void;
  airtableToken: string; setAirtableToken: (v: string) => void;
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
      {active && s.slug === "airtable" && (
        <div className="mt-2">
          <input value={airtableToken} onChange={(e) => setAirtableToken(e.target.value)} type="password" placeholder={he ? "Personal Access Token" : "Personal Access Token"} dir="ltr" className="w-full px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 outline-none" />
          <p className="text-[11px] text-gray-400 mt-1">{he ? "Airtable ← Developer hub ← Personal access tokens (הרשאות: data.records + schema.bases)" : "Airtable → Developer hub → Personal access tokens (scopes: data.records + schema.bases)"}</p>
        </div>
      )}
      {active && (
        <button type="button" onClick={() => onConnect(s.slug)} disabled={connecting || (s.slug === "shopify" && !shopDomain.trim()) || (s.slug === "fireberry" && !fireberryToken.trim()) || (s.slug === "airtable" && !airtableToken.trim())} className="mt-2 w-full py-2.5 bg-primary-500 hover:bg-primary-600 text-white text-sm font-medium rounded-xl transition disabled:opacity-50">
          {connecting ? (he ? "מתחבר…" : "Connecting…") : `${he ? "התחבר ל" : "Connect "}${s.name} →`}
        </button>
      )}
    </div>
  );
}

export function ConnectScreen(props: {
  he: boolean; systemQuery: string; setSystemQuery: (v: string) => void;
  picked: CoreSystemSlug | null; setPicked: (v: CoreSystemSlug | null) => void;
  shopDomain: string; setShopDomain: (v: string) => void; fireberryToken: string; setFireberryToken: (v: string) => void;
  airtableToken: string; setAirtableToken: (v: string) => void;
  connecting: boolean; skipping: boolean; onConnect: (slug: CoreSystemSlug) => void; onBack: () => void; onSkip: () => void;
  onRequestCrm: (name: string) => Promise<void>; justConnected: string | null; onContinueConnected: () => void;
  rec: DiscoveryRecommendation | null; disc: BusinessDiscoveryRecord | null;
}) {
  const { he, systemQuery, setSystemQuery, picked, setPicked, shopDomain, setShopDomain, fireberryToken, setFireberryToken, airtableToken, setAirtableToken, connecting, skipping, onConnect, onBack, onSkip, onRequestCrm, justConnected, onContinueConnected, rec, disc } = props;
  const recommendedSlugs = new Set((rec?.systems || []).map((s) => s.slug));

  // CRM-request ("couldn't find yours") mini-form state.
  const [crmReq, setCrmReq] = useState("");
  const [crmReqState, setCrmReqState] = useState<"idle" | "sending" | "done">("idle");
  const requestCrm = async () => {
    if (!crmReq.trim() || crmReqState === "sending") return;
    setCrmReqState("sending");
    try { await onRequestCrm(crmReq.trim()); setCrmReqState("done"); } catch { setCrmReqState("idle"); }
  };

  // The detected source of truth: an already-detected recommended system, or the
  // discovered store platform - whichever maps to a connectable system.
  // Computed BEFORE the `justConnected` return: the `showAll` hook below reads
  // it, and ALL hooks must run on every render (Rules of Hooks) - a hook after
  // that conditional return crashes the wizard when an OAuth return toggles it.
  const detectedFromRec = (rec?.systems || []).find((s) => s.alreadyDetected)?.slug?.toLowerCase();
  const platformSlug = disc?.technology?.platform?.slug?.toLowerCase();
  const detectedSlug = [detectedFromRec, platformSlug].find((sl) => SYSTEMS.some((x) => x.slug === sl)) as CoreSystemSlug | undefined;
  const primary = detectedSlug ? SYSTEMS.find((s) => s.slug === detectedSlug)! : null;

  // Show the full catalog when there's no detected primary OR when the caller
  // arrived with a specific system preselected (e.g. "Connect" on a Movement-5
  // recommendation) that isn't the primary card - its tile must be visible.
  const [showAll, setShowAll] = useState(!primary || (!!picked && picked !== primary.slug));

  // ✓ Connected - the success beat shown right after an OAuth round-trip so the
  // customer SEES the connection worked before moving on.
  if (justConnected) {
    const sys = SYSTEMS.find((s) => s.slug === justConnected);
    const nm = sys?.name || justConnected;
    return (
      <div dir={he ? "rtl" : "ltr"} className="animate-riseIn">
        <div className="flex items-center gap-3">
          <span className="w-12 h-12 rounded-2xl bg-emerald-50 border border-emerald-100 flex items-center justify-center text-emerald-500 text-2xl shrink-0">✓</span>
          {sys && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={sys.logo} alt={nm} className="w-9 h-9 object-contain" onError={(e) => { e.currentTarget.style.display = "none"; }} />
          )}
        </div>
        <h1 className="mt-5 text-4xl md:text-[44px] font-bold text-gray-900 tracking-tight leading-[1.08]">{he ? `${nm} מחובר!` : `${nm} is connected!`}</h1>
        <p className="text-lg text-gray-500 mt-3 leading-relaxed max-w-2xl">{he ? "מעולה - עכשיו אני יכול לראות את הלקוחות שלכם ולתעד כל שיחה. בואו נמשיך." : "Great - I can now see your customers and log every conversation. Let's keep going."}</p>
        <button type="button" onClick={onContinueConnected} className="mt-10 inline-flex items-center justify-center px-8 py-4 bg-primary-500 hover:bg-primary-600 text-white text-base font-semibold rounded-2xl transition shadow-lg shadow-primary-500/25">
          {he ? "המשך ←" : "Continue →"}
        </button>
      </div>
    );
  }

  const filtered = SYSTEMS.filter((s) => {
    const q = systemQuery.trim().toLowerCase();
    if (!q) return true;
    return s.name.toLowerCase().includes(q) || s.group.toLowerCase().includes(q) || s.slug.toLowerCase().includes(q);
  }).sort((a, b) => Number(recommendedSlugs.has(b.slug)) - Number(recommendedSlugs.has(a.slug)));

  const tileProps = { he, picked, setPicked, shopDomain, setShopDomain, fireberryToken, setFireberryToken, airtableToken, setAirtableToken, connecting, onConnect };

  return (
    <div dir={he ? "rtl" : "ltr"}>
      <h1 className="text-4xl md:text-[44px] font-bold text-gray-900 tracking-tight leading-[1.08]">{he ? "איפה אתם מנהלים את הלקוחות שלכם?" : "Where do you manage your customers?"}</h1>
      <p className="text-lg text-gray-500 mt-3 leading-relaxed max-w-2xl">{he ? "המערכת שמכילה את הלקוחות או ההזמנות שלכם - זה כל מה שצריך כדי שאתחיל לעבוד." : "The system that holds your customers or orders - that's all I need to get to work."}</p>

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

      {/* Couldn't find yours? Request a CRM we don't support yet - one click
          emails the team so we know to build it. */}
      <div className="mt-8 p-4 rounded-2xl border border-dashed border-gray-200 bg-white/60">
        {crmReqState === "done" ? (
          <p className="text-sm text-emerald-600 font-medium">{he ? "✓ תודה! רשמנו את הבקשה ונעדכן אתכם כשהחיבור יהיה מוכן." : "✓ Thanks! We've logged your request and will let you know when it's ready."}</p>
        ) : (
          <>
            <p className="text-sm font-semibold text-gray-800">{he ? "לא מצאתם את המערכת שלכם?" : "Can't find your system?"}</p>
            <p className="text-[13px] text-gray-500 mt-0.5">{he ? "כתבו לנו איזו מערכת/CRM אתם משתמשים ונוסיף לה תמיכה." : "Tell us which system/CRM you use and we'll add support for it."}</p>
            <div className="flex gap-1.5 mt-2.5">
              <input value={crmReq} onChange={(e) => setCrmReq(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") requestCrm(); }}
                placeholder={he ? "שם המערכת (למשל Priority, Monday)…" : "System name (e.g. Priority, Monday)…"}
                className="flex-1 px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-primary-200" />
              <button type="button" onClick={requestCrm} disabled={crmReqState === "sending" || !crmReq.trim()} className="text-xs font-semibold px-3.5 py-2 rounded-xl bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-40">
                {crmReqState === "sending" ? "…" : (he ? "ספרו לנו" : "Tell us")}
              </button>
            </div>
          </>
        )}
      </div>

      <div className="flex items-center justify-between mt-8">
        <button type="button" onClick={onBack} disabled={connecting || skipping} className="text-sm font-medium text-gray-500 hover:text-gray-700 disabled:opacity-50">{he ? "→ חזרה" : "← Back"}</button>
        <button type="button" onClick={onSkip} disabled={connecting || skipping} className="text-sm font-medium text-gray-500 hover:text-gray-700 disabled:opacity-50">{he ? "לא עכשיו - נשמר להמשך" : "Not now - saved for later"}</button>
      </div>
    </div>
  );
}
