import { getTranslations } from 'next-intl/server';

import { ImportProgress } from '@/features/channels/ImportProgress';
import { KnowledgeReview } from '@/features/channels/KnowledgeReview';
import { loadHistoryImport, loadWhatsAppNumbers } from '@/features/channels/load-whatsapp';
import { WhatsAppNumbers } from '@/features/channels/WhatsAppNumbers';
import { pageMetadata } from '@/shell/page-metadata';
import { SettingsSection } from '@/shell/SettingsSection';

/**
 * Settings · WhatsApp numbers — screen 13.
 *
 * Separate from the channel list because a WhatsApp number has a lifecycle the
 * other channels do not: per-number health, repairs that belong to three
 * different parties, and an audit trail. Folding it into the list would
 * flatten all of that into one connected/disconnected badge — which is the
 * collapse the platform already paid for once, when a number receiving
 * customer messages reported as "0 working, 1 needs attention".
 *
 * **On this tenant the only card that renders is the unprofiled one**: the
 * workspace has one WhatsApp channel, connected before per-number health
 * existed, so `data` is empty and `unprofiled` has a single entry.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ 13e AND 13f WERE BUILT, TESTED, AND MOUNTED NOWHERE
 * ════════════════════════════════════════════════════════════════════════════
 * `ImportProgress` (13e) and `KnowledgeReview` (13f) each had a passing test
 * file and no importer; this page mounted only `WhatsAppNumbers` (13b). So
 * `settings-channels.spec.ts` photographed one third of the family and reported
 * green — and a partial screen produces the same kind of evidence as a finished
 * one, which is why nobody saw it.
 *
 * They are sections of this screen rather than screens of their own: all three
 * read `channels.whatsapp` and draw from the same stylesheet. `Dialog` is
 * unimported for an unrelated reason — it is not the missing wiring.
 *
 * ── AND THE THIRD, `ConnectNumbers`, IS DELIBERATELY STILL ABSENT ──
 * It takes an `inspection` — the second step of Meta's Embedded Signup, which
 * has no first step here. `signup/whatsapp-signup-flow.ts` is pure logic with
 * no component using it, so the flow is a launcher short. Mounting the picker
 * would mean either building that launcher — ending in the `connect` call
 * nothing here may fire — or feeding it a fabricated inspection on the screen
 * that attaches a real business's phone number. Reported, not improvised.
 *
 * All four reads degrade independently. Every one of these panels renders its
 * own absence, so a failed read never blanks a neighbour.
 */
export default async function Page() {
  const t = await getTranslations('channels.whatsapp');
  const nav = await getTranslations('navigation');
  const [numbers, history] = await Promise.all([loadWhatsAppNumbers(), loadHistoryImport()]);

  return (
    <SettingsSection
      title={t('title')}
      description={t('description')}
      // Until 13b is a panel over Channels (S2), its way back is drawn as 17b's is.
      back={{ href: '/settings/channels', label: nav('settings.channels') }}
    >
      <WhatsAppNumbers numbers={numbers} />

      {/*
        ★★ ONLY WHEN THERE IS AN IMPORT TO REPORT ON.
        `stage: 'unavailable'` is a real row whose status is `NOT_AVAILABLE` —
        the platform saying the import cannot be done. An empty list is nobody
        ever starting one, and rendering the first for the second would tell a
        workspace that never asked that we cannot import its history.
      */}
      {history.status !== null ? <ImportProgress status={history.status} /> : null}

      {/*
        13f. The suggestions belong to an IMPORT, not to the tenant —
        `knowledge-clustering.stage.ts` queries `where: { importId, tenantId }`
        — so without an import there is nothing to review, and this is absent
        for the same reason as the section above rather than for one of its own.

        `candidates === null` is a failed read and the panel is withheld: it
        has no unavailable state of its own, and an empty list would say the
        import produced no suggestions, which is a different fact.
      */}
      {history.status !== null && history.candidates !== null ? (
        <KnowledgeReview
          candidates={history.candidates}
          /*
            The server's own floor, passed through UNDEFAULTED. `bulkWouldTake`
            prefers each candidate's `bulkApprovable` and falls back to this;
            `undefined` there means it refuses to give a number rather than
            guessing one. A `?? 0` here — which a first draft had — would pass
            every confidence and count every unconflicted suggestion.
          */
          bulkMinConfidence={history.bulkMinConfidence}
        />
      ) : null}
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('settings.whatsapp');
