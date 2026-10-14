/**
 * /api/contacts/unsubscribe/:token - the https half of List-Unsubscribe on
 * marketing email (RFC 2369 / RFC 8058, 2026-10-14). Public: the token is the
 * only identity (signed, see packages/shared/src/lib/list-unsubscribe.ts).
 *
 *   POST  one-click (RFC 8058): opts the contact out of marketing on that
 *         channel at once. Mail providers send `List-Unsubscribe=One-Click`;
 *         the confirm page's button posts here too.
 *   GET   a confirm page with that button. A GET never unsubscribes: mail
 *         scanners and link previews fetch every link in a message.
 *
 * The same writes as a "הסר" / STOP reply: the channel added to
 * Contact.optOutChannels (read by every marketing gate; an opt-out always
 * wins), an append-only consent withdrawal and an audit entry, with source
 * "list_unsubscribe". Already opted out is not an error.
 *
 * Mounted before the authenticated /api/contacts routers.
 */
import express, { Router, Request, Response } from "express";
import { prisma, auditSystem, AuditAction } from "@chatcenter/shared";
// Deep import: the pure rule, because this service's tests mock the barrel.
import { verifyUnsubscribeToken } from "@chatcenter/shared/src/lib/list-unsubscribe";

const router = Router();
router.use("/unsubscribe", express.urlencoded({ extended: false, limit: "2kb" }));

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};

function page(title: string, body: string): string {
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#f6f6f8;color:#16161d;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
main{background:#fff;border-radius:16px;padding:32px 28px;max-width:420px;margin:16px;box-shadow:0 2px 12px rgba(0,0,0,.06);text-align:center}
h1{font-size:20px;margin:0 0 8px}p{margin:6px 0;line-height:1.5}.en{direction:ltr;color:#55556a;font-size:14px}
button{margin-top:18px;background:#16161d;color:#fff;border:0;border-radius:10px;padding:12px 22px;font-size:16px;cursor:pointer}</style></head>
<body><main>${body}</main></body></html>`;
}

const CONFIRM = (action: string) => page("הסרה מרשימת התפוצה", `<h1>הסרה מרשימת התפוצה</h1>
<p>לא נשלח לך עוד הודעות שיווקיות בערוץ הזה.</p><p class="en">Unsubscribe: you will not get marketing messages on this channel again.</p>
<form method="post" action="${action}"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button type="submit">הסירו אותי · Unsubscribe</button></form>`);

const DONE = page("הוסרת", `<h1>הוסרת מרשימת התפוצה</h1><p>לא נשלח לך עוד הודעות שיווקיות.</p>
<p class="en">You're unsubscribed. We won't send you marketing messages again.</p>`);

const INVALID = page("קישור לא תקין", `<h1>הקישור אינו תקין</h1><p>אפשר להסיר את עצמך בתשובה "הסר" להודעה.</p>
<p class="en">This link is not valid. You can also reply STOP to the message.</p>`);

/** The opt-out itself. False when the token names no contact of that tenant. */
export async function unsubscribeByToken(token: string): Promise<{ ok: boolean; alreadyOptedOut?: boolean }> {
  const subject = verifyUnsubscribeToken(token);
  if (!subject) return { ok: false };
  const channel = subject.channel.toUpperCase();
  const contact = await prisma.contact.findFirst({
    where: { id: subject.contactId, tenantId: subject.tenantId },
    select: { id: true, optOutChannels: true },
  });
  if (!contact) return { ok: false };
  const current = Array.isArray(contact.optOutChannels) ? (contact.optOutChannels as unknown[]).map((x) => String(x).toUpperCase()) : [];
  const alreadyOptedOut = current.includes(channel);
  if (!alreadyOptedOut) {
    await prisma.contact.update({
      where: { id: contact.id },
      data: { optOutChannels: [...current, channel], optedOutAt: new Date() } as any,
    });
  }
  await prisma.consentRecord.create({
    data: {
      tenantId: subject.tenantId, subjectType: "contact", subjectId: contact.id,
      purpose: `marketing_${channel.toLowerCase()}`, granted: false, source: "list_unsubscribe",
      evidence: { channel },
    },
  }).catch((err: any) => console.warn(`[unsubscribe] consent record failed contact=${contact.id}: ${err?.message}`));
  await auditSystem(subject.tenantId, AuditAction.CONSENT_WITHDRAWN, { type: "contact", id: contact.id }, {
    purpose: `marketing_${channel.toLowerCase()}`, source: "list_unsubscribe", channel, alreadyOptedOut,
  });
  console.log(`[unsubscribe] contact=${contact.id} channel=${channel} ${alreadyOptedOut ? "already opted out" : "opted out"}`);
  return { ok: true, alreadyOptedOut };
}

router.get("/unsubscribe/:token", (req: Request, res: Response) => {
  const token = String(req.params.token ?? "");
  if (!verifyUnsubscribeToken(token)) { res.status(404).set(PAGE_HEADERS).send(INVALID); return; }
  res.status(200).set(PAGE_HEADERS).send(CONFIRM(`/api/contacts/unsubscribe/${encodeURIComponent(token)}`));
});

router.post("/unsubscribe/:token", async (req: Request, res: Response) => {
  try {
    const r = await unsubscribeByToken(String(req.params.token ?? ""));
    if (!r.ok) { res.status(404).set(PAGE_HEADERS).send(INVALID); return; }
    res.status(200).set(PAGE_HEADERS).send(DONE);
  } catch (err) {
    console.error("[unsubscribe] failed:", (err as Error)?.message);
    res.status(500).set(PAGE_HEADERS).send(page("שגיאה", `<h1>משהו השתבש</h1><p>נסו שוב, או השיבו "הסר" להודעה.</p><p class="en">Something went wrong. Try again, or reply STOP to the message.</p>`));
  }
});

export default router;
