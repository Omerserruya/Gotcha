'use client';

import { ArrowRight, ArrowUp, Globe, ImageIcon, Pencil, Plug, ShoppingBag } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  useEffect,
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
  isHex,
  isHttpsUrl,
  type WebchatConfig,
  type WebchatTab,
} from '@/api/contracts/webchat';
import {
  WIDGET_PATH,
  isLive,
  type ShopifyPlace,
  type WebsiteWidget,
  type WidgetInstall,
} from '@/api/contracts/website-widget';
import {
  UnavailableAction,
  UnavailableItem,
} from '@/design-system/primitives/unavailable/Unavailable';
import { connectWebChat } from '@/features/channels/actions';
import { ShopifyConnect } from '@/features/capabilities/ShopifyConnect';
import type { ShopifyAvailability } from '@/features/capabilities/load-capabilities';
import { Link, useRouter } from '@/i18n/navigation';

import { automationsLink } from '@/features/employees/WhoAnswers';
import { brandMark } from '@/lib/brand-mark';

import { hexToHsv, hsvToHex } from './colour';
import type { ShopifyData } from './load-website-widget';
import { saveWebsiteWidget } from './website-widget-actions';
import styles from './Webchat.module.css';

/** How long the editor waits after the last change before saving it. */
export const SAVE_AFTER_MS = 700;

type Saving = 'idle' | 'saving' | 'saved' | 'failed' | 'nowhere';

interface Setters {
  readonly colour: (hex: string) => void;
  readonly logo: (url: string | null) => void;
  readonly cover: (url: string | null) => void;
  readonly position: (side: 'left' | 'right') => void;
  readonly assistantName: (name: string) => void;
  readonly questions: (questions: readonly string[]) => void;
  readonly language: (language: WebchatConfig['appearance']['language']) => void;
  readonly poweredBy: (on: boolean) => void;
  readonly popup: (patch: Partial<WebchatConfig['ux']['proactive']>) => void;
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
}: {
  readonly initial: WebchatConfig;
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
      void saveWebsiteWidget(settings).then((answer) => {
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
    poweredBy: (showPoweredBy) => appearance({ showPoweredBy }),
    popup: (patch) => ux({ proactive: { ...config.ux.proactive, ...patch } }),
  };

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
            <Conversation config={config} set={set} assigned={assigned} />
          ) : tab === 'behaviour' ? (
            <Behaviour config={config} set={set} selling={selling} />
          ) : (
            <Install
              install={install}
              shopifyData={shopifyData}
              shopifyAvailability={shopifyAvailability}
            />
          )}
        </div>
        <Preview config={config} site={site} business={business} />
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
  const colour = config.appearance.primaryColor;
  const custom = !PALETTE.some((p) => p.toLowerCase() === colour.toLowerCase());
  const [code, setCode] = useState(colour);
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
              onClick={() => choose(p)}
              data-testid={`webchat-swatch-${p.slice(1)}`}
            />
          ))}
          <span
            className={styles.swatch}
            data-custom=""
            data-checked={custom ? '' : undefined}
            title={t('custom')}
            aria-hidden="true"
          />
        </div>
        <div className={styles.picker}>
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
                choose(hsvToHex({ h: Number(e.target.value), s: hsv.s || 0.6, v: hsv.v || 0.8 }))
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
                  if (isHex(e.target.value)) set.colour(e.target.value.toUpperCase());
                }}
                aria-invalid={!isHex(code)}
                spellCheck={false}
                data-testid="webchat-hex"
              />
              <Pencil size={13} aria-hidden="true" />
            </span>
            <span className={styles.rowHint}>{isHex(code) ? t('codeHint') : t('codeBad')}</span>
          </label>
        </div>
      </Row>

      <ImageRow
        label={t('logo')}
        hint={t('logoHint')}
        value={config.appearance.logoUrl}
        onSave={set.logo}
        testid="webchat-logo"
      />
      <ImageRow
        label={t('cover')}
        hint={t('coverHint')}
        value={config.ux.hero.mediaUrl}
        onSave={set.cover}
        testid="webchat-cover"
      />

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
 * An image the widget shows - by https address, because there is no upload
 * route (the old app took an address too). Saved once it is one the route
 * keeps; cleared by emptying it.
 */
function ImageRow({
  label,
  hint,
  value,
  onSave,
  testid,
}: {
  readonly label: string;
  readonly hint: string;
  readonly value: string | null;
  readonly onSave: (url: string | null) => void;
  readonly testid: string;
}) {
  const t = useTranslations('channels.webchat.appearance');
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const ok = draft.trim() === '' || isHttpsUrl(draft);
  return (
    <Row label={label} testid={testid}>
      <span className={styles.imageLine}>
        {value ? (
          // The merchant's own image, from their own address.
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
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              if (ok) onSave(draft.trim() || null);
            }}
            placeholder="https://"
            aria-invalid={!ok}
            aria-label={label}
            inputMode="url"
            data-testid={`${testid}-url`}
          />
          <span className={styles.rowHint}>{ok ? t('addressHint') : t('addressBad')}</span>
        </span>
      ) : null}
    </Row>
  );
}

function Conversation({
  config,
  set,
  assigned,
}: {
  readonly config: WebchatConfig;
  readonly set: Setters;
  readonly assigned: WebsiteWidget['assignedEmployee'];
}) {
  const t = useTranslations('channels.webchat.conversation');
  const questions = [0, 1, 2].map((i) => config.ux.welcome.suggestedQuestions[i] ?? '');
  return (
    <>
      <section className={styles.card}>
        <Row label={t('name')} testid="webchat-name">
          <TextField
            label={t('name')}
            value={config.ux.welcome.assistantName}
            onChange={set.assistantName}
            max={40}
            testid="webchat-name-input"
          />
        </Row>
        <Row label={t('popup')} testid="webchat-popup-text">
          <TextField
            label={t('popup')}
            value={config.ux.proactive.message}
            onChange={(message) => set.popup({ message })}
            max={200}
            testid="webchat-popup-input"
          />
        </Row>
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
      </section>

      <div className={styles.pair}>
        <section className={styles.card} data-pad="" data-testid="webchat-employee">
          <h2 className={styles.cardTitle}>
            {t('employee')} <span className={styles.required}>{t('required')}</span>
          </h2>
          <p className={styles.rowHint}>{t('employeeHint')}</p>
          {/*
            Who answers is decided in one place, the playbook: read here, never
            a second routing rule. Changing it from here waits for Omer.
          */}
          <p className={styles.assigned} data-testid="webchat-employee-who">
            {assigned ? (
              <>
                <span className={styles.assignedMark} aria-hidden="true">
                  {brandMark(assigned.name).logo}
                </span>
                <bdi dir="auto">{assigned.name}</bdi>
              </>
            ) : (
              t('employeeNone')
            )}
          </p>
          <p className={styles.rowHint} data-testid="webchat-employee-where">
            {t.rich('employeeWhere', { automations: automationsLink })}
          </p>
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
}: {
  readonly config: WebchatConfig;
  readonly set: Setters;
  /** A shop runs the widget and its catalogue answers: products and cart are on there. */
  readonly selling: boolean;
}) {
  const t = useTranslations('channels.webchat.behaviour');
  const popup = config.ux.proactive;
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
                aria-checked={popup.delaySeconds === s}
                className={styles.segment}
                onClick={() => set.popup({ delaySeconds: s })}
                data-testid={`webchat-when-${s}`}
              >
                {s === 0 ? t('rightAway') : t('seconds', { s })}
              </button>
            ))}
          </span>
        </Row>
      ) : null}
      <Toggle
        label={t('whatsapp')}
        hint={t('whatsappHint')}
        on={false}
        why={t('whatsappWhy')}
        testid="webchat-whatsapp"
      />
      <Toggle
        label={t('poweredBy')}
        hint={t('poweredByHint')}
        on={config.appearance.showPoweredBy}
        onChange={set.poweredBy}
        testid="webchat-powered"
      />
      {/*
        Products and cart are on by WHERE the widget runs (Backend, stage A):
        in a Shopify shop yes, from the code snippet no - a status, not a
        switch. Deals have no source anywhere yet.
      */}
      {(['products', 'cart'] as const).map((k) =>
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
      <Toggle
        label={t('deals.label')}
        hint={t('deals.hint')}
        on={false}
        why={t('noDeals')}
        testid="webchat-deals"
      />
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
  const tw = useTranslations('channels.webchat');
  if (install === null) {
    return (
      <p className={styles.rowHint} role="status" data-testid="webchat-install-unread">
        {t('unread')}
      </p>
    );
  }
  const code = install.code;
  return (
    <>
      <section className={styles.card}>
        {install.shopify.length > 0 ? (
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
        <div className={styles.store} data-testid="webchat-woo">
          <span className={styles.storeMark} data-store="woo" aria-hidden="true">
            <Plug size={15} />
          </span>
          <span className={styles.toggleText}>
            <span>{t('woo')}</span>
            <span className={styles.rowHint}>{t('wooHint')}</span>
            <span className={styles.why}>{t('wooWhy')}</span>
          </span>
          <UnavailableAction
            label={t('wooButton')}
            tag={tw('comingSoon')}
            why={t('wooWhy')}
            testid="webchat-woo-action"
          />
        </div>
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
  const integrationsLink = (chunks: ReactNode) => <Link href="/studio/capabilities">{chunks}</Link>;
  return (
    <div className={styles.store} data-testid={`webchat-shop-${shop.channelId}`} data-state={state}>
      <span className={styles.storeMark} data-store="shopify" aria-hidden="true">
        <ShoppingBag size={15} />
      </span>
      <span className={styles.toggleText}>
        <span>{t('shopify')}</span>
        <span className={styles.rowHint} data-testid="webchat-shop-line">
          <bdi dir="ltr">{shop.shopDomain}</bdi> · {t(`shop.${state}`)}
        </span>
        {state === 'active' || state === 'quiet' ? (
          <span className={styles.rowHint} data-testid="webchat-shop-data">
            {shopifyData === 'ok'
              ? t('data.ok')
              : shopifyData === 'failing'
                ? t.rich('data.failing', { integrations: integrationsLink })
                : shopifyData === 'none'
                  ? t.rich('data.none', { integrations: integrationsLink })
                  : t('data.unread')}
          </span>
        ) : null}
        {(state === 'off' || state === 'quiet') && shop.themeEditorUrl ? (
          <a
            className={styles.textButton}
            href={shop.themeEditorUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="webchat-shop-theme"
          >
            {t('themeEditor')}
          </a>
        ) : null}
      </span>
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
}: {
  readonly config: WebchatConfig;
  readonly site: string | null;
  readonly business: string | null;
}) {
  const t = useTranslations('channels.webchat.preview');
  const colour = isHex(config.appearance.primaryColor) ? config.appearance.primaryColor : '#121212';
  const name = config.ux.welcome.assistantName.trim() || t('assistant');
  const mark = brandMark(business ?? name);
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
        <div className={styles.widget}>
          <div className={styles.hero} data-testid="webchat-preview-cover">
            {config.ux.hero.mediaUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={config.ux.hero.mediaUrl} alt="" className={styles.heroImage} />
            ) : (
              <ImageIcon size={16} aria-hidden="true" />
            )}
          </div>
          <span className={styles.logo}>
            {config.appearance.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={config.appearance.logoUrl} alt="" />
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
          {config.appearance.showPoweredBy ? (
            <span className={styles.powered} data-testid="webchat-preview-powered">
              {t('powered')}
            </span>
          ) : null}
        </div>
        {config.ux.proactive.enabled && config.ux.proactive.message.trim() ? (
          <span className={styles.bubble} data-testid="webchat-preview-bubble">
            <bdi dir="auto">{config.ux.proactive.message}</bdi>
          </span>
        ) : null}
        <span
          className={styles.launcher}
          style={{ backgroundColor: colour }}
          data-testid="webchat-preview-launcher"
        >
          {mark.launcher}
        </span>
      </div>
    </aside>
  );
}
