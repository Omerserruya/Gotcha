'use client';

import {
  ArrowRight,
  ArrowUp,
  Globe,
  ImageIcon,
  MessageCircle,
  Pencil,
  Pipette,
  ShoppingBag,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  useEffect,
  useSyncExternalStore,
  useRef,
  useState,
  useTransition,
  type PointerEvent,
  type ReactNode,
} from 'react';

import {
  PALETTE,
  POPUP_DELAYS,
  WEBCHAT_TABS,
  WEBCHAT_LANGUAGES,
  fullHex,
  isHex,
  WIDGET_KINDS,
  type WebchatConfig,
  type WebchatTab,
  type WidgetKind,
} from '@/api/contracts/webchat';
import {
  WIDGET_PATH,
  isLive,
  platformOffer,
  type HandoffNumber,
  type ShopifyPlace,
  type WebsiteWidget,
  type WidgetAssignment,
  type WidgetInstall,
} from '@/api/contracts/website-widget';
import { UnavailableItem } from '@/design-system/primitives/unavailable/Unavailable';
import { connectWebChat } from '@/features/channels/actions';
import { ShopifyConnect } from '@/features/capabilities/ShopifyConnect';
import type { ShopifyAvailability } from '@/features/capabilities/load-capabilities';
import { Link, useRouter } from '@/i18n/navigation';

import { appPath } from '@/lib/base-path';
import { brandMark, initials, logoFit } from '@/lib/brand-mark';

import { hexToHsv, hsvToHex } from './colour';
import {
  IMAGE_SLOTS,
  IMAGE_TYPES,
  uploadWidgetImage,
  type ImageProblem,
  type ImageSlot,
} from './widget-image';
import type { ShopifyData } from './load-website-widget';
import { saveWebsiteWidget } from './website-widget-actions';
import styles from './Webchat.module.css';
import { WidgetAssignmentCard } from './WidgetAssignment';
import { WooPlugin } from './WooPlugin';

/** How long the editor waits after the last change before saving it. */
export const SAVE_AFTER_MS = 700;

type Saving = 'idle' | 'saving' | 'saved' | 'failed' | 'nowhere' | 'number' | 'kindNumber';

interface Setters {
  readonly colour: (hex: string) => void;
  readonly logo: (url: string | null) => void;
  readonly cover: (url: string | null) => void;
  readonly position: (side: 'left' | 'right') => void;
  readonly assistantName: (name: string) => void;
  readonly questions: (questions: readonly string[]) => void;
  readonly language: (language: WebchatConfig['appearance']['language']) => void;
  readonly popup: (patch: Partial<WebchatConfig['ux']['proactive']>) => void;
  /** W1: the widget's kind - its look follows; a WhatsApp widget with the number it uses. */
  readonly kind: (kind: WidgetKind, whatsapp: WebchatConfig['ux']['whatsapp']) => void;
  /** W1: the WhatsApp widget's greeting bubble (`ux.welcome.title`). */
  readonly greeting: (title: string) => void;
  readonly whatsapp: (patch: Partial<WebchatConfig['ux']['whatsapp']>) => void;
}

/**
 * 13g-13j - Settings · Channels · Website widget (design 6; one widget, design 7).
 *
 * ★★ ONE WIDGET, MANY PLACES (Omer, 2026-10-07): the web chat and Shopify's
 *   live chat are one embedded chat. A change is written to every place it
 *   is installed - the code snippet and each Shopify shop - by one route.
 *
 * ★★ NO SAVE BUTTON, AS THE DESIGN HAS NONE: a change is saved a moment
 *   after it is made, to the widget's own config route, and the preview on
 *   the right IS the change. The answer is what the route kept (it
 *   normalises); the line by the tabs says saving / saved / not saved. A
 *   colour or an image address is saved only once it is one the route would
 *   keep - a hex, an https address - so a half-typed value never is.
 *
 * ★ What the widget cannot do yet is drawn and says why: a brand scan,
 *   image upload, Continue on WhatsApp (stage B), deals, and products / cart
 *   anywhere but a Shopify shop whose catalogue answers. Who answers is read
 *   from the playbook, never chosen here: routing decides it in one place.
 */
export function WebchatSettings({
  initial,
  assigned,
  install,
  shopifyData,
  shopifyAvailability,
  business,
  tab,
  handoffNumbers = null,
  assignment = null,
}: {
  readonly initial: WebchatConfig;
  /**
   * Who answers, from the playbook, and whom to give it to (§4) - read on the
   * Conversation tab. `null`: not read; `'forbidden'`: not an admin.
   */
  readonly assignment?: WidgetAssignment | 'forbidden' | null;
  /**
   * Stage B's WhatsApp numbers for "Continue on WhatsApp". `null`: the service
   * is stage A - the look and the handoff are not there yet, and are not sent.
   */
  readonly handoffNumbers?: readonly HandoffNumber[] | null;
  /** Who answers the website per the playbook - read-only here. */
  readonly assigned: WebsiteWidget['assignedEmployee'];
  /** `null`: the installs could not be read. */
  readonly install: WidgetInstall | null;
  readonly shopifyData: ShopifyData | null;
  readonly shopifyAvailability: ShopifyAvailability | null;
  readonly business: string | null;
  readonly tab: WebchatTab;
}) {
  const t = useTranslations('channels.webchat');
  const live = install ? isLive(install) : null;
  // The preview's address line: a shop, else the site the code was last seen on.
  const site = install?.shopify[0]?.shopDomain ?? install?.code?.lastHost ?? null;
  /* Products and cart: on where a shop runs it and its catalogue answers (Backend, stage A). */
  const selling = Boolean(
    install?.shopify.some((shop) => shop.status === 'active') && shopifyData === 'ok',
  );
  const stageB = handoffNumbers !== null;
  const [config, setConfig] = useState(initial);
  const [saving, setSaving] = useState<Saving>('idle');
  const edits = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  /** Change the widget; saved after a pause, the latest change winning. */
  const change = (next: WebchatConfig, save = true) => {
    setConfig(next);
    if (!save) return;
    const mine = ++edits.current;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setSaving('saving');
      const { displayName: _account, ...settings } = next;
      void saveWebsiteWidget(settings, stageB).then((answer) => {
        if (mine !== edits.current) return;
        if (!answer.ok) setSaving(answer.reason);
        else {
          const kept = { ...answer.settings, displayName: '' };
          setSaving('saved');
          // What the route kept - but a question emptied to be rewritten keeps its place.
          setConfig({
            ...kept,
            ux: {
              ...kept.ux,
              welcome: {
                ...kept.ux.welcome,
                suggestedQuestions: next.ux.welcome.suggestedQuestions,
              },
            },
          });
        }
      });
    }, SAVE_AFTER_MS);
  };

  const appearance = (patch: Partial<WebchatConfig['appearance']>, save = true) =>
    change({ ...config, appearance: { ...config.appearance, ...patch } }, save);
  const ux = (patch: Partial<WebchatConfig['ux']>) =>
    change({ ...config, ux: { ...config.ux, ...patch } });

  const set: Setters = {
    colour: (primaryColor) => appearance({ primaryColor }, isHex(primaryColor)),
    logo: (logoUrl) => appearance({ logoUrl }),
    cover: (mediaUrl) => ux({ hero: { mediaType: mediaUrl ? 'image' : 'none', mediaUrl } }),
    position: (position) => ux({ launcher: { position } }),
    assistantName: (assistantName) => ux({ welcome: { ...config.ux.welcome, assistantName } }),
    questions: (suggestedQuestions) =>
      ux({ welcome: { ...config.ux.welcome, suggestedQuestions: [...suggestedQuestions] } }),
    language: (language) => appearance({ language }),
    popup: (patch) => ux({ proactive: { ...config.ux.proactive, ...patch } }),
    kind: (kind, whatsapp) =>
      ux({ kind, look: kind === 'whatsapp' ? 'whatsapp' : 'gotcha', whatsapp }),
    greeting: (title) => ux({ welcome: { ...config.ux.welcome, title } }),
    whatsapp: (patch) => ux({ whatsapp: { ...config.ux.whatsapp, ...patch } }),
  };
  /* The number "Continue on WhatsApp" would use - the button shows only when it can take it. */
  const handoff =
    stageB && config.ux.whatsapp.enabled
      ? (handoffNumbers.find(
          (n) => n.channelId === config.ux.whatsapp.channelAccountId && n.available,
        ) ?? null)
      : null;

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <nav className={styles.crumbs} aria-label={t('crumbs')}>
          <Link href="/settings/channels" className={styles.crumb}>
            {t('channels')}
          </Link>
          <span aria-hidden="true">›</span>
          <span aria-current="page">{t('title')}</span>
        </nav>
        <div className={styles.titleRow}>
          <span className={styles.tile} aria-hidden="true">
            <Globe size={18} strokeWidth={1.8} />
          </span>
          <span className={styles.titleText}>
            <h1 className={styles.title}>{t('title')}</h1>
            <span className={styles.subtitle}>{t('subtitle')}</span>
          </span>
          {live === null ? null : (
            <span
              className={styles.status}
              data-live={live ? '' : undefined}
              data-testid="webchat-status"
            >
              {live ? t('live') : t('notLive')}
            </span>
          )}
          {live !== false ? null : (
            // Going live IS installing: the status turns Live on the first real visit.
            <Link
              href={{ pathname: WIDGET_PATH, query: { tab: 'install' } }}
              className={styles.goLive}
              data-testid="webchat-go-live"
            >
              {t('goLive')}
            </Link>
          )}
        </div>
        {stageB ? <KindChoice config={config} numbers={handoffNumbers ?? []} set={set} /> : null}
        <nav className={styles.tabs} aria-label={t('tabsLabel')}>
          {WEBCHAT_TABS.map((name) => (
            <Link
              key={name}
              href={{ pathname: WIDGET_PATH, query: { tab: name } }}
              className={styles.tab}
              aria-current={tab === name ? 'page' : undefined}
              scroll={false}
              data-testid={`webchat-tab-${name}`}
            >
              {t(`tabs.${name}`)}
            </Link>
          ))}
          <span
            className={styles.saving}
            role="status"
            data-saving={saving}
            data-testid="webchat-saving"
          >
            {saving === 'idle' ? '' : t(`saving.${saving}`)}
          </span>
        </nav>
      </header>

      <div className={styles.columns}>
        <div className={styles.stack}>
          {tab === 'appearance' ? (
            <Appearance config={config} set={set} />
          ) : tab === 'conversation' ? (
            <Conversation config={config} set={set} assigned={assigned} assignment={assignment} />
          ) : tab === 'behaviour' ? (
            <Behaviour
              config={config}
              set={set}
              selling={selling}
              handoffNumbers={handoffNumbers}
            />
          ) : (
            <Install
              install={install}
              shopifyData={shopifyData}
              shopifyAvailability={shopifyAvailability}
            />
          )}
        </div>
        <Preview config={config} site={site} business={business} handoff={handoff !== null} />
      </div>
    </div>
  );
}

function Row({
  label,
  hint,
  children,
  testid,
}: {
  readonly label: ReactNode;
  readonly hint?: string;
  readonly children?: ReactNode;
  readonly testid?: string;
}) {
  return (
    <div className={styles.row} data-testid={testid}>
      <span className={styles.rowLabel}>
        {label}
        {hint ? <span className={styles.rowHint}>{hint}</span> : null}
      </span>
      {children ? <div className={styles.rowBody}>{children}</div> : null}
    </div>
  );
}

/** A switch that writes, or - with `why` - one that is drawn off and says why it cannot. */
function Toggle({
  label,
  hint,
  on,
  onChange,
  why,
  testid,
  children,
}: {
  readonly label: string;
  readonly hint: string;
  readonly on: boolean;
  readonly onChange?: (on: boolean) => void;
  readonly why?: string;
  readonly testid: string;
  readonly children?: ReactNode;
}) {
  const tw = useTranslations('channels.webchat');
  if (why !== undefined) {
    // Cannot be done yet: a status, not a switch (Omer, 2026-10-07).
    return (
      <div className={styles.toggleRow} data-testid={testid}>
        <UnavailableItem
          title={label}
          tag={tw('notYet')}
          why={why}
          testid={`${testid}-unavailable`}
        />
      </div>
    );
  }
  return (
    <div className={styles.toggleRow} data-testid={testid}>
      <span className={styles.toggleText}>
        <span>{label}</span>
        <span className={styles.rowHint}>{hint}</span>
      </span>
      <input
        type="checkbox"
        role="switch"
        className={styles.switch}
        checked={on}
        aria-label={label}
        onChange={(e) => onChange?.(e.target.checked)}
        data-testid={`${testid}-switch`}
      />
      {children ? <div className={styles.toggleMore}>{children}</div> : null}
    </div>
  );
}

function Appearance({ config, set }: { readonly config: WebchatConfig; readonly set: Setters }) {
  const t = useTranslations('channels.webchat.appearance');
  const tw = useTranslations('channels.webchat');
  const colour = config.appearance.primaryColor;
  const custom = !PALETTE.some((p) => p.toLowerCase() === colour.toLowerCase());
  const [code, setCode] = useState(colour);
  /* W5: the custom swatch opens the picker; a custom colour opens with it open. */
  const [picking, setPicking] = useState(custom);
  /* W5: the screen's eyedropper where the browser has one (Chromium) - known after mounting. */
  const dropper = useSyncExternalStore(
    noSubscription,
    () => 'EyeDropper' in window,
    () => false,
  );
  const hsv = hexToHsv(isHex(colour) ? colour : '#121212');
  const square = useRef<HTMLDivElement>(null);
  const choose = (hex: string) => {
    setCode(hex);
    set.colour(hex);
  };

  const pick = (event: PointerEvent<HTMLDivElement>) => {
    const box = square.current?.getBoundingClientRect();
    if (!box || box.width === 0 || event.buttons === 0) return;
    const s = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    const v = 1 - Math.min(1, Math.max(0, (event.clientY - box.top) / box.height));
    choose(hsvToHex({ h: hsv.h, s, v }));
  };

  return (
    <section className={styles.card}>
      {/*
        ★★ W1: a WhatsApp widget wears WhatsApp's own look - no colour, logo
        or cover to set; only its side.
      */}
      {config.ux.kind === 'whatsapp' ? (
        <p className={styles.rowHint} data-testid="webchat-wa-look-note">
          {t('waKindLook')}
        </p>
      ) : (
        <>
          {config.ux.look === 'whatsapp' ? (
            /*
          The WhatsApp look wears WhatsApp's own colours (Backend 09a1105b: a
          fixed green header, send and launcher) - the main colour does nothing
          there, so it is a status, not a picker that changes nothing.
        */
            <Row label={t('colour')} testid="webchat-colour">
              <UnavailableItem
                title={t('colour')}
                tag={tw('notInLook')}
                why={t('colourWaLook')}
                testid="webchat-colour-wa-look"
              />
            </Row>
          ) : (
            <Row label={t('colour')} testid="webchat-colour">
              <div className={styles.swatches} role="radiogroup" aria-label={t('colour')}>
                {PALETTE.map((p) => (
                  <button
                    key={p}
                    type="button"
                    role="radio"
                    aria-checked={p.toLowerCase() === colour.toLowerCase()}
                    aria-label={p}
                    className={styles.swatch}
                    style={{ backgroundColor: p }}
                    onClick={() => {
                      setPicking(false);
                      choose(p);
                    }}
                    data-testid={`webchat-swatch-${p.slice(1)}`}
                  />
                ))}
                {/* W5: a real control now - it opens the square, the hue and the code. */}
                <button
                  type="button"
                  aria-pressed={custom}
                  aria-expanded={picking}
                  aria-label={t('custom')}
                  title={t('custom')}
                  className={styles.swatch}
                  data-custom=""
                  onClick={() => setPicking((was) => !was)}
                  data-testid="webchat-swatch-custom"
                />
              </div>
              {picking ? (
                <div className={styles.picker} data-testid="webchat-picker">
                  <div className={styles.pickerArea}>
                    <div
                      ref={square}
                      className={styles.square}
                      style={{ backgroundColor: hsvToHex({ h: hsv.h, s: 1, v: 1 }) }}
                      onPointerDown={(e) => {
                        e.currentTarget.setPointerCapture?.(e.pointerId);
                        pick(e);
                      }}
                      onPointerMove={pick}
                      aria-hidden="true"
                    >
                      <span
                        className={styles.knob}
                        style={{
                          insetInlineStart: `${hsv.s * 100}%`,
                          insetBlockStart: `${(1 - hsv.v) * 100}%`,
                        }}
                      />
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={359}
                      value={Math.round(hsv.h)}
                      onChange={(e) =>
                        choose(
                          hsvToHex({ h: Number(e.target.value), s: hsv.s || 0.6, v: hsv.v || 0.8 }),
                        )
                      }
                      className={styles.hue}
                      aria-label={t('hue')}
                    />
                  </div>
                  <label className={styles.code}>
                    <span className={styles.rowHint}>{t('code')}</span>
                    <span className={styles.codeField}>
                      <span
                        className={styles.codeChip}
                        style={{ backgroundColor: isHex(code) ? code : colour }}
                      />
                      <input
                        value={code}
                        onChange={(e) => {
                          setCode(e.target.value);
                          const full = fullHex(e.target.value);
                          if (full) set.colour(full);
                        }}
                        aria-invalid={!isHex(code)}
                        spellCheck={false}
                        data-testid="webchat-hex"
                      />
                      <Pencil size={13} aria-hidden="true" />
                    </span>
                    <span className={styles.rowHint}>
                      {isHex(code) ? t('codeHint') : t('codeBad')}
                    </span>
                  </label>
                  {dropper ? (
                    <button
                      type="button"
                      className={styles.dropper}
                      aria-label={t('eyedropper')}
                      title={t('eyedropper')}
                      onClick={() => {
                        // A gesture, a secure page; Esc rejects it (AbortError) - nothing to say.
                        const Dropper = (
                          window as unknown as {
                            EyeDropper: new () => { open: () => Promise<{ sRGBHex: string }> };
                          }
                        ).EyeDropper;
                        new Dropper()
                          .open()
                          .then(({ sRGBHex }) => {
                            const full = fullHex(sRGBHex);
                            if (full) choose(full);
                          })
                          .catch(() => undefined);
                      }}
                      data-testid="webchat-eyedropper"
                    >
                      <Pipette size={14} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              ) : null}
            </Row>
          )}

          <ImageRow
            slot="logo"
            label={t('logo')}
            hint={t('logoHint')}
            value={config.appearance.logoUrl}
            onSave={set.logo}
            testid="webchat-logo"
          />
          {config.ux.look === 'whatsapp' ? (
            // The WhatsApp look shows no cover (the bundle hides it).
            <Row label={t('cover')} testid="webchat-cover">
              <UnavailableItem
                title={t('cover')}
                tag={tw('notInLook')}
                why={t('coverWaLook')}
                testid="webchat-cover-wa-look"
              />
            </Row>
          ) : (
            <ImageRow
              slot="cover"
              label={t('cover')}
              hint={t('coverHint')}
              value={config.ux.hero.mediaUrl}
              onSave={set.cover}
              testid="webchat-cover"
            />
          )}
        </>
      )}
      <Row label={t('position')} testid="webchat-position">
        <span className={styles.segments} role="radiogroup" aria-label={t('position')}>
          {(['right', 'left'] as const).map((side) => (
            <button
              key={side}
              type="button"
              role="radio"
              aria-checked={config.ux.launcher.position === side}
              className={styles.segment}
              onClick={() => set.position(side)}
              data-testid={`webchat-position-${side}`}
            >
              {t(`side.${side}`)}
            </button>
          ))}
        </span>
      </Row>
    </section>
  );
}

/**
 * ★★ W3/W4 (Omer, 2026-10-14): an image the widget shows - uploaded from the
 * computer, or given by a link (a Google Drive share link too), checked and
 * re-hosted by the platform (`widget-image.ts`). The slot's limits are said
 * before anything is chosen, a file that cannot be used is refused here in
 * words, and so is anything the server refuses. Removed by "Remove".
 */
function ImageRow({
  slot,
  label,
  hint,
  value,
  onSave,
  testid,
}: {
  readonly slot: ImageSlot;
  readonly label: string;
  readonly hint: string;
  readonly value: string | null;
  readonly onSave: (url: string | null) => void;
  readonly testid: string;
}) {
  const t = useTranslations('channels.webchat.appearance');
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ImageProblem | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const limits = IMAGE_SLOTS[slot];
  const send = async (source: File | string) => {
    setBusy(true);
    setProblem(null);
    const done = await uploadWidgetImage(slot, source);
    setBusy(false);
    if (!done.ok) {
      setProblem(done);
      return;
    }
    setLink('');
    setOpen(false);
    onSave(done.url);
  };
  const said = (p: ImageProblem) =>
    p.reason === 'too_large'
      ? t('upload.problem.too_large', { mb: p.maxBytes / 1_000_000 })
      : p.reason === 'too_big'
        ? p.width !== null && p.height !== null
          ? t('upload.problem.too_big', {
              width: p.width,
              height: p.height,
              maxWidth: p.maxWidth,
              maxHeight: p.maxHeight,
            })
          : t('upload.problem.too_big_unknown', { maxWidth: p.maxWidth, maxHeight: p.maxHeight })
        : t(`upload.problem.${p.reason}`);
  return (
    <Row label={label} testid={testid}>
      <span className={styles.imageLine}>
        {value ? (
          // The merchant's own image, re-hosted by the platform.
          // eslint-disable-next-line @next/next/no-img-element
          <img className={styles.thumb} src={value} alt="" />
        ) : (
          <span className={styles.thumb} data-empty="" aria-hidden="true">
            <ImageIcon size={14} />
          </span>
        )}
        <span className={styles.rowHint}>{hint}</span>
        <button
          type="button"
          className={styles.textButton}
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          data-testid={`${testid}-replace`}
        >
          {t('replace')}
        </button>
      </span>
      {open ? (
        <span className={styles.imageField}>
          <span className={styles.rowHint} data-testid={`${testid}-limits`}>
            {t('upload.limits', {
              mb: limits.maxBytes / 1_000_000,
              width: limits.maxWidth,
              height: limits.maxHeight,
            })}
          </span>
          <input
            ref={file}
            type="file"
            accept={IMAGE_TYPES.join(',')}
            hidden
            onChange={(e) => {
              const chosen = e.target.files?.[0];
              e.target.value = '';
              if (chosen) void send(chosen);
            }}
            data-testid={`${testid}-file`}
          />
          <span className={styles.imageActions}>
            <button
              type="button"
              className={styles.imageButton}
              disabled={busy}
              onClick={() => file.current?.click()}
              data-testid={`${testid}-upload`}
            >
              {busy ? t('upload.busy') : t('upload.file')}
            </button>
            {value ? (
              <button
                type="button"
                className={styles.textButton}
                disabled={busy}
                onClick={() => {
                  setOpen(false);
                  onSave(null);
                }}
                data-testid={`${testid}-remove`}
              >
                {t('upload.remove')}
              </button>
            ) : null}
          </span>
          <span className={styles.imageLink}>
            <input
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder={t('upload.linkPlaceholder')}
              aria-label={t('upload.link')}
              inputMode="url"
              dir="ltr"
              data-testid={`${testid}-url`}
            />
            <button
              type="button"
              className={styles.imageButton}
              disabled={busy || link.trim() === ''}
              onClick={() => void send(link)}
              data-testid={`${testid}-add`}
            >
              {t('upload.add')}
            </button>
          </span>
          {problem ? (
            <span className={styles.why} role="alert" data-testid={`${testid}-problem`}>
              {said(problem)}
            </span>
          ) : null}
        </span>
      ) : null}
    </Row>
  );
}

function Conversation({
  config,
  set,
  assigned,
  assignment,
}: {
  readonly config: WebchatConfig;
  readonly set: Setters;
  readonly assigned: WebsiteWidget['assignedEmployee'];
  readonly assignment: WidgetAssignment | 'forbidden' | null;
}) {
  const t = useTranslations('channels.webchat.conversation');
  const questions = [0, 1, 2].map((i) => config.ux.welcome.suggestedQuestions[i] ?? '');
  return (
    <>
      <section className={styles.card}>
        {config.ux.kind === 'whatsapp' ? (
          /* W1: the WhatsApp widget's greeting bubble, in its panel. */
          <Row label={t('greeting')} hint={t('greetingHint')} testid="webchat-greeting">
            <TextField
              label={t('greeting')}
              value={config.ux.welcome.title}
              onChange={set.greeting}
              max={60}
              testid="webchat-greeting-input"
            />
          </Row>
        ) : (
          <Row label={t('name')} testid="webchat-name">
            <TextField
              label={t('name')}
              value={config.ux.welcome.assistantName}
              onChange={set.assistantName}
              max={40}
              testid="webchat-name-input"
            />
          </Row>
        )}
        <Row
          label={config.ux.kind === 'whatsapp' ? t('teaser') : t('popup')}
          testid="webchat-popup-text"
        >
          <TextField
            label={config.ux.kind === 'whatsapp' ? t('teaser') : t('popup')}
            value={config.ux.proactive.message}
            onChange={(message) => set.popup({ message })}
            max={200}
            testid="webchat-popup-input"
          />
        </Row>
        {config.ux.kind === 'whatsapp' ? null : (
          <Row label={t('questions')} testid="webchat-questions">
            {questions.map((q, i) => (
              <TextField
                key={i}
                label={t('question', { n: i + 1 })}
                value={q}
                onChange={(value) => {
                  const next = [...questions];
                  next[i] = value;
                  set.questions(next);
                }}
                max={120}
                testid={`webchat-question-${i}`}
              />
            ))}
            <span className={styles.rowHint}>{t('questionsHint')}</span>
          </Row>
        )}
      </section>

      {/* W1: a WhatsApp widget has no AI employee on the site, and no language to choose. */}
      {config.ux.kind === 'whatsapp' ? null : (
        <div className={styles.pair}>
          <section className={styles.card} data-pad="" data-testid="webchat-employee">
            <h2 className={styles.cardTitle}>
              {t('employee')} <span className={styles.required}>{t('required')}</span>
            </h2>
            <p className={styles.rowHint}>{t('employeeHint')}</p>
            {/*
            Who answers is decided in one place, the playbook - and since Omer's
            2026-10-08 decision, an admin can set it from here, written to it.
          */}
            <WidgetAssignmentCard read={assignment} assigned={assigned} />
          </section>
          <section
            className={styles.card}
            data-pad=""
            role="radiogroup"
            aria-labelledby="webchat-language-title"
            data-testid="webchat-language"
          >
            <h2 className={styles.cardTitle} id="webchat-language-title">
              {t('language')}
            </h2>
            {WEBCHAT_LANGUAGES.map((lang) => (
              <label key={lang} className={styles.radio}>
                <input
                  type="radio"
                  name="webchat-language"
                  checked={config.appearance.language === lang}
                  onChange={() => set.language(lang)}
                  data-testid={`webchat-language-${lang}`}
                />
                {t(`languages.${lang}`)}
              </label>
            ))}
          </section>
        </div>
      )}
    </>
  );
}

/** A text the widget shows: the preview follows the typing, and the pause saves it. */
function TextField({
  label,
  value,
  onChange,
  max,
  testid,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly max: number;
  readonly testid: string;
}) {
  return (
    <span className={styles.textField}>
      <input
        value={value}
        maxLength={max}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        dir="auto"
        data-testid={testid}
      />
      <Pencil size={13} aria-hidden="true" />
    </span>
  );
}

function Behaviour({
  config,
  set,
  selling,
  handoffNumbers,
}: {
  readonly config: WebchatConfig;
  readonly set: Setters;
  /** A shop runs the widget and its catalogue answers: products and cart are on there. */
  readonly selling: boolean;
  /** Stage B's numbers; `null` on a stage A service. */
  readonly handoffNumbers: readonly HandoffNumber[] | null;
}) {
  const t = useTranslations('channels.webchat.behaviour');
  const popup = config.ux.proactive;
  const wa = config.ux.whatsapp;
  const usable = handoffNumbers?.filter((n) => n.available) ?? [];
  const chosen = handoffNumbers?.find((n) => n.channelId === wa.channelAccountId) ?? null;
  const channelsLink = (chunks: ReactNode) => <Link href="/settings/channels">{chunks}</Link>;
  return (
    <section className={styles.card}>
      <Toggle
        label={t('popup')}
        hint={t('popupHint')}
        on={popup.enabled}
        onChange={(enabled) => set.popup({ enabled })}
        testid="webchat-popup"
      />
      {popup.enabled ? (
        <Row label={t('when')} testid="webchat-when">
          <span className={styles.segments} role="radiogroup" aria-label={t('when')}>
            {POPUP_DELAYS.map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                // A stored 0 (before "right away" was 1s) is "right away" too.
                aria-checked={popup.delaySeconds === s || (s === 1 && popup.delaySeconds === 0)}
                className={styles.segment}
                onClick={() => set.popup({ delaySeconds: s })}
                data-testid={`webchat-when-${s}`}
              >
                {s === 1 ? t('rightAway') : t('seconds', { s })}
              </button>
            ))}
          </span>
        </Row>
      ) : null}
      {/* W1: the WhatsApp widget IS the hand-off: its number is chosen with its kind. */}
      {config.ux.kind === 'whatsapp' ? null : handoffNumbers === null ? (
        // A stage A service: not there yet, and nothing is sent for it.
        <Toggle
          label={t('whatsapp')}
          hint={t('whatsappHint')}
          on={false}
          why={t('whatsappWhy')}
          testid="webchat-whatsapp"
        />
      ) : (
        /*
          Stage B: on, and ONE of the workspace's numbers - chosen, never typed.
          A number that cannot take it says why; the button shows on the site
          only when its number can (Backend checks it again).
        */
        <Toggle
          label={t('whatsapp')}
          hint={t('whatsappHint')}
          on={wa.enabled}
          onChange={(enabled) =>
            set.whatsapp({
              enabled,
              // One number that can take it: it is the one.
              channelAccountId:
                wa.channelAccountId ?? (usable.length === 1 ? usable[0]!.channelId : null),
            })
          }
          testid="webchat-whatsapp"
        >
          {wa.enabled ? (
            handoffNumbers.length === 0 ? (
              <p className={styles.rowHint} data-testid="webchat-wa-none">
                {t.rich('whatsappNone', { channels: channelsLink })}
              </p>
            ) : (
              <>
                <span
                  className={styles.numbers}
                  role="radiogroup"
                  aria-label={t('whatsappNumber')}
                  data-testid="webchat-wa-numbers"
                >
                  {handoffNumbers.map((number) => (
                    <label
                      key={number.channelId}
                      className={styles.number}
                      data-available={number.available ? '' : undefined}
                      data-testid={`webchat-wa-${number.channelId}`}
                    >
                      <input
                        type="radio"
                        name="webchat-wa-number"
                        checked={wa.channelAccountId === number.channelId}
                        disabled={!number.available}
                        onChange={() => set.whatsapp({ channelAccountId: number.channelId })}
                      />
                      <span className={styles.numberText}>
                        <bdi dir="auto">{number.name}</bdi>
                        {number.phone ? (
                          <span className={styles.rowHint}>
                            <bdi dir="ltr">{number.phone}</bdi>
                          </span>
                        ) : null}
                        {number.available ? null : (
                          <span
                            className={styles.why}
                            data-testid={`webchat-wa-${number.channelId}-why`}
                          >
                            {t.rich(`whatsappReason.${number.reason ?? 'not_connected'}`, {
                              channels: channelsLink,
                            })}
                          </span>
                        )}
                      </span>
                    </label>
                  ))}
                </span>
                {chosen?.available ? null : (
                  <p className={styles.rowHint} data-testid="webchat-wa-hidden">
                    {t('whatsappHidden')}
                  </p>
                )}
              </>
            )
          ) : null}
        </Toggle>
      )}
      {/*
        ★★ W8 (Omer, 2026-10-14): "Powered by GOTCHA" is always on, in both
        widgets, with our logo - the server refuses false (403
        POWERED_BY_LOCKED, befd7811). A row that says so, never a switch.
      */}
      <div className={styles.toggleRow} data-testid="webchat-powered">
        <span className={styles.toggleText}>
          <span>{t('poweredBy')}</span>
          <span className={styles.rowHint}>{t('poweredByHint')}</span>
        </span>
        <PoweredBy />
      </div>
      {/*
        Products and cart are on by WHERE the widget runs (Backend, stage A):
        in a Shopify shop yes, from the code snippet no - a status, not a
        switch. Deals have no source anywhere yet.
      */}
      {config.ux.kind === 'whatsapp'
        ? null
        : (['products', 'cart'] as const).map((k) =>
            selling ? (
              <div className={styles.toggleRow} key={k} data-testid={`webchat-${k}`}>
                <span className={styles.toggleText}>
                  <span>{t(`${k}.label`)}</span>
                  <span className={styles.rowHint}>{t(`${k}.hint`)}</span>
                  <span className={styles.rowHint}>{t('codeNoProducts')}</span>
                </span>
                <span className={styles.onTag} data-testid={`webchat-${k}-on`}>
                  {t('onInShopify')}
                </span>
              </div>
            ) : (
              <Toggle
                key={k}
                label={t(`${k}.label`)}
                hint={t(`${k}.hint`)}
                on={false}
                why={t('noCatalogue')}
                testid={`webchat-${k}`}
              />
            ),
          )}
      {config.ux.kind === 'whatsapp' ? null : (
        <Toggle
          label={t('deals.label')}
          hint={t('deals.hint')}
          on={false}
          why={t('noDeals')}
          testid="webchat-deals"
        />
      )}
    </section>
  );
}

/**
 * Install (design 7): the platform is picked by installing - Shopify in one
 * click, WooCommerce when its plugin exists, any other site by the code.
 *
 * ★ "Connected to stock and orders" is the Shopify INTEGRATION's to say, not
 *   the chat's: the chat runs in a shop with no Admin API token, and on dev
 *   the integration is failing while the chat is live. Each shop line says
 *   which of the two it is talking about.
 */
function Install({
  install,
  shopifyData,
  shopifyAvailability,
}: {
  readonly install: WidgetInstall | null;
  readonly shopifyData: ShopifyData | null;
  readonly shopifyAvailability: ShopifyAvailability | null;
}) {
  const t = useTranslations('channels.webchat.install');
  if (install === null) {
    return (
      <p className={styles.rowHint} role="status" data-testid="webchat-install-unread">
        {t('unread')}
      </p>
    );
  }
  const code = install.code;
  const shopifyOffer = platformOffer(install.platforms, 'shopify');
  const wooOffer = platformOffer(install.platforms, 'woocommerce');
  return (
    <>
      {/*
        ★★ W11 (Omer, 2026-10-14): only a platform connected to GOTCHA is a
        way to install; one whose connection failed says it needs
        reconnecting; the rest are not shown. Any other site, always.
      */}
      <section className={styles.card}>
        {shopifyOffer === 'hide' ? null : shopifyOffer === 'reconnect' ? (
          <Reconnect platform="Shopify" testid="webchat-shopify-reconnect" />
        ) : install.shopify.length > 0 ? (
          install.shopify.map((shop) => (
            <ShopRow
              key={shop.channelId}
              shop={shop}
              shopifyData={shopifyData}
              shopifyAvailability={shopifyAvailability}
            />
          ))
        ) : (
          <div className={styles.store} data-testid="webchat-shopify">
            <span className={styles.storeMark} data-store="shopify" aria-hidden="true">
              <ShoppingBag size={15} />
            </span>
            <span className={styles.toggleText}>
              <span>{t('shopify')}</span>
              <span className={styles.rowHint}>{t('shopifyHint')}</span>
            </span>
            {/* The existing install (10 / 00g): availability first, then Shopify picks the store. */}
            <ShopifyConnect
              mode={shopifyAvailability?.mode ?? null}
              helpUrl={shopifyAvailability?.helpUrl ?? null}
            />
          </div>
        )}
        {wooOffer === 'hide' ? null : wooOffer === 'reconnect' ? (
          <Reconnect platform="WooCommerce" testid="webchat-woo-reconnect" />
        ) : (
          <WooPlugin woo={install.woocommerce} />
        )}
        <div className={styles.snippetBlock} data-testid="webchat-snippet">
          <span className={styles.snippetHead}>
            <span>{t('other')}</span>
            {code ? <CopyCode code={code.snippet} /> : null}
          </span>
          {code ? (
            <pre className={styles.snippet} dir="ltr" data-testid="webchat-snippet-code">
              {code.snippet}
            </pre>
          ) : (
            <GetTheCode />
          )}
          <span className={styles.rowHint}>{t('otherHint')}</span>
        </div>
      </section>
      {code ? (
        <p
          className={styles.strip}
          data-live={code.status === 'live' ? '' : undefined}
          role="status"
          data-testid="webchat-install-status"
        >
          <span className={styles.stripDot} aria-hidden="true" />
          {code.status === 'live'
            ? code.lastHost
              ? t('liveOn', { host: code.lastHost })
              : t('liveNow')
            : t('waiting')}
        </p>
      ) : null}
    </>
  );
}

/** One shop the widget was installed on: the chat's state, then the data connection's. */
function ShopRow({
  shop,
  shopifyData,
  shopifyAvailability,
}: {
  readonly shop: ShopifyPlace;
  readonly shopifyData: ShopifyData | null;
  readonly shopifyAvailability: ShopifyAvailability | null;
}) {
  const t = useTranslations('channels.webchat.install');
  const state =
    shop.status === 'uninstalled'
      ? 'removed'
      : shop.status === 'not_enabled'
        ? 'off'
        : shop.embedLive
          ? 'active'
          : 'quiet';
  // The data connection's line, with its one way forward as a button.
  const data =
    state === 'active' || state === 'quiet'
      ? shopifyData === 'ok'
        ? { words: t('data.ok'), action: null }
        : shopifyData === 'failing'
          ? { words: t('data.failing'), action: t('data.fix') }
          : shopifyData === 'none'
            ? { words: t('data.none'), action: t('data.connect') }
            : { words: t('data.unread'), action: null }
      : null;
  return (
    <div
      className={styles.store}
      data-stack=""
      data-testid={`webchat-shop-${shop.channelId}`}
      data-state={state}
    >
      <div className={styles.storeLine}>
        <span className={styles.storeMark} data-store="shopify" aria-hidden="true">
          <ShoppingBag size={15} />
        </span>
        <span className={styles.storeName}>{t('shopify')}</span>
        {(state === 'off' || state === 'quiet') && shop.themeEditorUrl ? (
          <a
            className={styles.secondary}
            href={shop.themeEditorUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="webchat-shop-theme"
          >
            {t('themeEditor')}
          </a>
        ) : null}
        {state === 'removed' ? (
          <ShopifyConnect
            mode={shopifyAvailability?.mode ?? null}
            helpUrl={shopifyAvailability?.helpUrl ?? null}
          />
        ) : (
          <span
            className={styles.status}
            data-live={state === 'active' ? '' : undefined}
            data-testid="webchat-shop-status"
          >
            {t(`shopTag.${state}`)}
          </span>
        )}
      </div>
      {/*
        Under the name's row, at the card's full width: the shop on its own
        line (an ellipsis when long, never broken inside), then what it is
        doing. The buttons and the badge stay on the name's row.
      */}
      <div className={styles.storeBody}>
        <bdi
          dir="ltr"
          className={styles.domain}
          title={shop.shopDomain}
          data-testid="webchat-shop-domain"
        >
          {shop.shopDomain}
        </bdi>
        <span className={styles.rowHint} data-testid="webchat-shop-line">
          {t(`shop.${state}`)}
        </span>
      </div>
      {data ? (
        <div className={styles.storeSection} data-testid="webchat-shop-data">
          <div className={styles.storeLine}>
            <span className={styles.storeName}>{t('data.title')}</span>
            {data.action ? (
              <Link
                href="/studio/capabilities"
                className={styles.secondary}
                data-testid="webchat-shop-data-action"
              >
                {data.action}
              </Link>
            ) : null}
          </div>
          <span className={styles.rowHint}>{data.words}</span>
        </div>
      ) : null}
    </div>
  );
}

function CopyCode({ code }: { readonly code: string }) {
  const t = useTranslations('channels.webchat.install');
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <button
      type="button"
      className={styles.secondary}
      onClick={() =>
        void navigator.clipboard
          .writeText(code)
          .then(() => setCopied(true))
          .catch(() => setCopied(false))
      }
      data-testid="webchat-copy"
    >
      {copied === true ? t('copied') : copied === false ? t('copyFailed') : t('copy')}
    </button>
  );
}

/**
 * No code yet: it is created by the web chat's own create (idempotent, and it
 * owns the plan's channel limit) - never by a settings save.
 */
function GetTheCode() {
  const t = useTranslations('channels.webchat.install');
  const router = useRouter();
  const [problem, setProblem] = useState<'limit' | 'forbidden' | 'failed' | null>(null);
  const [isPending, start] = useTransition();
  return (
    <span className={styles.getCode}>
      <span className={styles.rowHint}>{t('noCode')}</span>
      <button
        type="button"
        className={styles.secondary}
        disabled={isPending}
        onClick={() =>
          start(async () => {
            setProblem(null);
            const made = await connectWebChat('');
            if (made.ok) router.refresh();
            else
              setProblem(
                made.reason === 'limit' || made.reason === 'forbidden' ? made.reason : 'failed',
              );
          })
        }
        data-testid="webchat-get-code"
      >
        {isPending ? t('gettingCode') : t('getCode')}
      </button>
      {problem ? (
        <span className={styles.why} role="alert" data-testid="webchat-get-code-problem">
          {t(`getCodeProblem.${problem}`)}
        </span>
      ) : null}
    </span>
  );
}

/** The widget as a visitor will see it - drawn from the config, so it is every change at once. */
function Preview({
  config,
  site,
  business,
  handoff,
}: {
  readonly config: WebchatConfig;
  readonly site: string | null;
  readonly business: string | null;
  /** "Continue on WhatsApp" is on and its number can take it: the button shows. */
  readonly handoff: boolean;
}) {
  const t = useTranslations('channels.webchat.preview');
  const colour = isHex(config.appearance.primaryColor) ? config.appearance.primaryColor : '#121212';
  const name = config.ux.welcome.assistantName.trim() || t('assistant');
  const mark = brandMark(business ?? name);
  // Sized by its longest word, never broken inside one; initials when none fits.
  const fit = logoFit(mark.logo);
  const questions = config.ux.welcome.suggestedQuestions.filter((q) => q.trim()).slice(0, 3);
  return (
    <aside className={styles.preview} aria-label={t('label')} data-testid="webchat-preview">
      <span className={styles.previewHead}>
        <span>{t('label')}</span>
        {site ? (
          <span className={styles.rowHint}>
            <bdi dir="auto">{site}</bdi>
          </span>
        ) : null}
      </span>
      <div className={styles.stage} data-side={config.ux.launcher.position}>
        {config.ux.look === 'whatsapp' ? (
          /*
            Design 7's WhatsApp look: WhatsApp's panel, its green launcher, and
            "write here and we'll continue on WhatsApp". The chat shows only what
            the business wrote (its pop-up message) - no sample greeting.
          */
          <div className={styles.waWidget} data-testid="webchat-preview-wa">
            <div className={styles.waHead}>
              <span className={styles.waAvatar} aria-hidden="true">
                {initials(business ?? name)}
              </span>
              <span className={styles.waTitles}>
                <span className={styles.waTitle}>{t('waTitle')}</span>
                <span className={styles.waSub}>{t('waSub')}</span>
              </span>
            </div>
            <div className={styles.waChat}>
              {config.ux.proactive.message.trim() ? (
                <span className={styles.waBubble}>
                  <bdi dir="auto">{config.ux.proactive.message}</bdi>
                </span>
              ) : null}
            </div>
            <span className={styles.waComposer}>
              <span className={styles.waField}>{t('type')}</span>
              <span className={styles.waSend} aria-hidden="true">
                <ArrowUp size={12} />
              </span>
            </span>
            <span className={styles.powered} data-testid="webchat-preview-powered">
              <PoweredBy />
            </span>
          </div>
        ) : (
          <div className={styles.widget}>
            <div className={styles.hero} data-testid="webchat-preview-cover">
              {handoff ? (
                // Design 7: the WhatsApp action on the cover, when the button will show.
                <span
                  className={styles.heroWa}
                  title={t('waContinue')}
                  data-testid="webchat-preview-wa-button"
                >
                  <MessageCircle size={13} aria-hidden="true" />
                </span>
              ) : null}
              {config.ux.hero.mediaUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={config.ux.hero.mediaUrl} alt="" className={styles.heroImage} />
              ) : (
                <ImageIcon size={16} aria-hidden="true" />
              )}
            </div>
            <span
              className={styles.logo}
              data-fit={config.appearance.logoUrl ? undefined : fit}
              data-testid="webchat-preview-logo"
            >
              {config.appearance.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={config.appearance.logoUrl} alt="" />
              ) : fit === 'initials' ? (
                initials(business ?? name)
              ) : (
                mark.logo
              )}
            </span>
            <span className={styles.assistant} data-testid="webchat-preview-name">
              <bdi dir="auto">{name}</bdi>
            </span>
            <ul className={styles.questions} data-testid="webchat-preview-questions">
              {questions.map((q, i) => (
                <li key={i}>
                  <bdi dir="auto">{q}</bdi>
                  <ArrowRight size={12} aria-hidden="true" />
                </li>
              ))}
            </ul>
            <span className={styles.composer}>
              <span>{t('type')}</span>
              <span className={styles.send} style={{ backgroundColor: colour }} aria-hidden="true">
                <ArrowUp size={12} color="#FFFFFF" />
              </span>
            </span>
            <span className={styles.powered} data-testid="webchat-preview-powered">
              <PoweredBy />
            </span>
          </div>
        )}
        {config.ux.proactive.enabled && config.ux.proactive.message.trim() ? (
          <span className={styles.bubble} data-testid="webchat-preview-bubble">
            <bdi dir="auto">{config.ux.proactive.message}</bdi>
          </span>
        ) : null}
        {config.ux.look === 'whatsapp' ? (
          <span
            className={styles.launcher}
            data-look="whatsapp"
            data-testid="webchat-preview-launcher"
          >
            <MessageCircle size={20} aria-hidden="true" />
          </span>
        ) : (
          <span
            className={styles.launcher}
            style={{ backgroundColor: colour }}
            data-testid="webchat-preview-launcher"
          >
            {mark.launcher}
          </span>
        )}
      </div>
    </aside>
  );
}

/** "Powered by" and our logo - design 7's line, in every widget (W8). */
function PoweredBy() {
  const t = useTranslations('channels.webchat.behaviour');
  return (
    <span className={styles.poweredBy} dir="ltr">
      <span>{t('poweredByLead')}</span>
      {/* A 6 KB local mark: `next/image` would optimise nothing here. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className={styles.poweredLogo}
        src={appPath('/brand/gotcha-line-dark.png')}
        alt="GOTCHA"
      />
    </span>
  );
}

/**
 * ★★ W1 (Omer, 2026-10-14): what the widget IS, chosen before anything else -
 * a chat on the site with an AI employee, or a WhatsApp widget that starts
 * the conversation on WhatsApp. Each shows only its own settings.
 *
 * A WhatsApp widget needs a number that can take it (else 422
 * WHATSAPP_KIND_NEEDS_NUMBER): it is chosen here, in place - one that can be
 * used is offered, one that cannot says why - and the kind is saved only with
 * one. No usable number at all: said, with where to connect one.
 */
function KindChoice({
  config,
  numbers,
  set,
}: {
  readonly config: WebchatConfig;
  readonly numbers: readonly HandoffNumber[];
  readonly set: Setters;
}) {
  const t = useTranslations('channels.webchat.kind');
  const [picking, setPicking] = useState(false);
  /*
    ★ A switch changes the live widget on the customer's site at once, so it
    is asked first, both ways (dev, 2026-10-14) - with the WhatsApp block it
    would write.
  */
  const [asking, setAsking] = useState<{
    readonly kind: WidgetKind;
    readonly whatsapp: WebchatConfig['ux']['whatsapp'];
  } | null>(null);
  /*
    ★ What "Continue on WhatsApp" was before the switch to a WhatsApp widget:
    put back on the way to chat (dev, 2026-10-14 - keeping the widget's
    number turned the hand-off on with it). Not known (the page opened on a
    WhatsApp widget): the hand-off is off - never a number nobody chose.
  */
  const [before, setBefore] = useState<WebchatConfig['ux']['whatsapp'] | null>(null);
  const usable = numbers.filter((n) => n.available);
  const current = numbers.find((n) => n.channelId === config.ux.whatsapp.channelAccountId) ?? null;
  const ready = config.ux.whatsapp.enabled && current?.available === true;
  const toWhatsApp = (channelAccountId: string) => {
    setPicking(false);
    setAsking({ kind: 'whatsapp', whatsapp: { enabled: true, channelAccountId } });
  };
  const choose = (kind: WidgetKind) => {
    if (kind === 'chat') {
      setPicking(false);
      if (config.ux.kind === 'chat') return;
      setAsking({ kind: 'chat', whatsapp: before ?? { enabled: false, channelAccountId: null } });
      return;
    }
    if (config.ux.kind === 'whatsapp' && ready) return;
    if (ready) toWhatsApp(config.ux.whatsapp.channelAccountId!);
    else if (usable.length === 1) toWhatsApp(usable[0]!.channelId);
    else setPicking(true);
  };
  const confirm = () => {
    if (!asking) return;
    if (asking.kind === 'whatsapp' && config.ux.kind === 'chat') setBefore(config.ux.whatsapp);
    set.kind(asking.kind, asking.whatsapp);
    setAsking(null);
  };
  return (
    <section className={styles.kinds} data-testid="webchat-kind">
      <span className={styles.kindLabel} id="webchat-kind-label">
        {t('label')}
      </span>
      <span className={styles.kindOptions} role="radiogroup" aria-labelledby="webchat-kind-label">
        {WIDGET_KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            role="radio"
            aria-checked={config.ux.kind === kind}
            className={styles.kindOption}
            onClick={() => choose(kind)}
            data-testid={`webchat-kind-${kind}`}
          >
            <span className={styles.kindName}>{t(`${kind}.name`)}</span>
            <span className={styles.rowHint}>{t(`${kind}.hint`)}</span>
          </button>
        ))}
      </span>
      {asking ? (
        <div className={styles.kindAsk} role="alertdialog" data-testid="webchat-kind-ask">
          <span>{t(`ask.${asking.kind}`)}</span>
          <span className={styles.kindAskActions}>
            <button
              type="button"
              className={styles.kindAskYes}
              onClick={confirm}
              data-testid="webchat-kind-ask-yes"
            >
              {t('ask.yes')}
            </button>
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => setAsking(null)}
              data-testid="webchat-kind-ask-no"
            >
              {t('ask.no')}
            </button>
          </span>
        </div>
      ) : null}
      {config.ux.kind === 'whatsapp' && current && !picking && !asking ? (
        <p className={styles.rowHint} data-testid="webchat-kind-number">
          {t('number', { name: current.name, phone: current.phone ?? '' })}{' '}
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => setPicking(true)}
            data-testid="webchat-kind-change-number"
          >
            {t('changeNumber')}
          </button>
        </p>
      ) : null}
      {picking ? (
        usable.length === 0 ? (
          <p className={styles.rowHint} role="status" data-testid="webchat-kind-no-number">
            {t.rich('noNumber', {
              channels: (chunks) => <Link href="/settings/channels">{chunks}</Link>,
            })}
          </p>
        ) : (
          <span
            className={styles.kindNumbers}
            role="radiogroup"
            aria-label={t('pickNumber')}
            data-testid="webchat-kind-numbers"
          >
            <span className={styles.rowHint}>{t('pickNumber')}</span>
            {numbers.map((n) => (
              <label key={n.channelId} className={styles.radio}>
                <input
                  type="radio"
                  name="webchat-kind-number"
                  disabled={!n.available}
                  checked={config.ux.kind === 'whatsapp' && current?.channelId === n.channelId}
                  onChange={() => toWhatsApp(n.channelId)}
                  data-testid={`webchat-kind-number-${n.channelId}`}
                />
                <bdi dir="auto">{n.name}</bdi>
                {n.phone ? <span dir="ltr">{n.phone}</span> : null}
                {n.available ? null : (
                  <span className={styles.rowHint}>
                    {t(`numberWhy.${n.reason ?? 'not_connected'}`)}
                  </span>
                )}
              </label>
            ))}
          </span>
        )
      ) : null}
    </section>
  );
}

/** For a value that never changes while the page is open (a browser's abilities). */
function noSubscription(): () => void {
  return () => undefined;
}

/** W11: a store platform whose connection to GOTCHA failed - not a way to install until it is fixed. */
function Reconnect({ platform, testid }: { readonly platform: string; readonly testid: string }) {
  const t = useTranslations('channels.webchat.install');
  return (
    <p className={styles.rowHint} role="status" data-testid={testid}>
      {t.rich('reconnect', {
        platform,
        systems: (chunks) => <Link href="/settings/systems">{chunks}</Link>,
      })}
    </p>
  );
}
