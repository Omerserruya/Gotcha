'use client';

import { ArrowRight, ArrowUp, Globe, ImageIcon, Pencil, Plug, ShoppingBag } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
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
import { embedCode } from '@/features/channels/ConnectPanel';
import { Link } from '@/i18n/navigation';

import { hexToHsv, hsvToHex } from './colour';
import { saveWebchat } from './webchat-actions';
import styles from './Webchat.module.css';

/** How long the editor waits after the last change before saving it. */
export const SAVE_AFTER_MS = 700;

type Saving = 'idle' | 'saving' | 'saved' | 'failed';

export interface WebchatEmployee {
  readonly id: string;
  readonly name: string;
  readonly line: string | null;
  readonly paused: boolean;
}

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
 * 13g-13j - Settings · Channels · Web chat (design 6).
 *
 * ★★ NO SAVE BUTTON, AS THE DESIGN HAS NONE: a change is saved a moment
 *   after it is made, to the widget's own config route, and the preview on
 *   the right IS the change. The answer is what the route kept (it
 *   normalises); the line by the tabs says saving / saved / not saved. A
 *   colour or an image address is saved only once it is one the route would
 *   keep - a hex, an https address - so a half-typed value never is.
 *
 * ★ What the widget cannot store yet is drawn and says why: a brand scan,
 *   image upload, Continue on WhatsApp, products / cart / deals (a website
 *   widget has no catalogue), the store installs, and which employee answers
 *   (that is routing's, not the widget's).
 */
export function WebchatSettings({
  id,
  initial,
  widget,
  employees,
  business,
  tab,
}: {
  readonly id: string;
  readonly initial: WebchatConfig;
  readonly widget: {
    readonly widgetId: string | null;
    readonly live: boolean;
    readonly name: string | null;
  } | null;
  readonly employees: readonly WebchatEmployee[] | null;
  readonly business: string | null;
  readonly tab: WebchatTab;
}) {
  const t = useTranslations('channels.webchat');
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
      void saveWebchat(id, next).then((kept) => {
        if (mine !== edits.current) return;
        if (kept === null) setSaving('failed');
        else {
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
          {widget ? (
            <span
              className={styles.status}
              data-live={widget.live ? '' : undefined}
              data-testid="webchat-status"
            >
              {widget.live ? t('live') : t('notLive')}
            </span>
          ) : null}
          {widget?.live ? null : (
            // Going live IS installing: the status turns Live on the first real visit.
            <Link
              href={{ pathname: `/settings/channels/webchat/${id}`, query: { tab: 'install' } }}
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
              href={{ pathname: `/settings/channels/webchat/${id}`, query: { tab: name } }}
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
            <Conversation config={config} set={set} employees={employees} />
          ) : tab === 'behaviour' ? (
            <Behaviour config={config} set={set} />
          ) : (
            <Install widgetId={widget?.widgetId ?? null} live={widget?.live ?? false} />
          )}
        </div>
        <Preview config={config} site={widget?.name ?? null} business={business} />
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
  return (
    <div className={styles.toggleRow} data-testid={testid}>
      <span className={styles.toggleText}>
        <span>{label}</span>
        <span className={styles.rowHint}>{hint}</span>
        {why ? <span className={styles.why}>{why}</span> : null}
      </span>
      <input
        type="checkbox"
        role="switch"
        className={styles.switch}
        checked={on}
        disabled={why !== undefined}
        title={why}
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
  employees,
}: {
  readonly config: WebchatConfig;
  readonly set: Setters;
  readonly employees: readonly WebchatEmployee[] | null;
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
          {/* Who answers is decided in one place, routing's - not by the widget. Drawn, and why. */}
          <p className={styles.why} data-testid="webchat-employee-why">
            {t('employeeWhy')}
          </p>
          {employees === null ? (
            <p className={styles.rowHint}>{t('employeesUnread')}</p>
          ) : (
            <ul className={styles.choices}>
              {employees.map((e) => (
                <li key={e.id} className={styles.choice} aria-disabled="true">
                  <span className={styles.initials} aria-hidden="true">
                    {e.name.slice(0, 2).toUpperCase()}
                  </span>
                  <span className={styles.choiceText}>
                    <span>{e.name}</span>
                    <span className={styles.rowHint}>
                      {[e.line, e.paused ? t('paused') : null].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <input
                    type="radio"
                    name="webchat-employee"
                    disabled
                    checked={false}
                    readOnly
                    aria-label={e.name}
                    title={t('employeeWhy')}
                  />
                </li>
              ))}
            </ul>
          )}
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

function Behaviour({ config, set }: { readonly config: WebchatConfig; readonly set: Setters }) {
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
      {(['products', 'cart', 'deals'] as const).map((k) => (
        <Toggle
          key={k}
          label={t(`${k}.label`)}
          hint={t(`${k}.hint`)}
          on={false}
          why={t('noCatalogue')}
          testid={`webchat-${k}`}
        />
      ))}
    </section>
  );
}

const noSubscription = () => () => {};

function Install({ widgetId, live }: { readonly widgetId: string | null; readonly live: boolean }) {
  const t = useTranslations('channels.webchat.install');
  // The snippet loads from where this app is served - known in the browser, after hydration.
  const origin = useSyncExternalStore(
    noSubscription,
    () => window.location.origin,
    () => '',
  );
  const [copied, setCopied] = useState<boolean | null>(null);
  const code = widgetId && origin ? embedCode(widgetId, origin) : null;
  return (
    <>
      <section className={styles.card}>
        {/* No one-click installs yet: drawn, each with why (Shopify's is its own app channel). */}
        <div className={styles.store} data-testid="webchat-shopify">
          <span className={styles.storeMark} data-store="shopify" aria-hidden="true">
            <ShoppingBag size={15} />
          </span>
          <span className={styles.toggleText}>
            <span>{t('shopify')}</span>
            <span className={styles.rowHint}>{t('shopifyHint')}</span>
            <span className={styles.why}>{t('shopifyWhy')}</span>
          </span>
          <button type="button" className={styles.primary} disabled title={t('shopifyWhy')}>
            {t('shopifyButton')}
          </button>
        </div>
        <div className={styles.store} data-testid="webchat-woo">
          <span className={styles.storeMark} data-store="woo" aria-hidden="true">
            <Plug size={15} />
          </span>
          <span className={styles.toggleText}>
            <span>{t('woo')}</span>
            <span className={styles.rowHint}>{t('wooHint')}</span>
            <span className={styles.why}>{t('wooWhy')}</span>
          </span>
          <button type="button" className={styles.secondary} disabled title={t('wooWhy')}>
            {t('wooButton')}
          </button>
        </div>
        <div className={styles.snippetBlock} data-testid="webchat-snippet">
          <span className={styles.snippetHead}>
            <span>{t('other')}</span>
            {code ? (
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
            ) : null}
          </span>
          {code ? (
            <pre className={styles.snippet} data-testid="webchat-snippet-code">
              {code}
            </pre>
          ) : (
            <p className={styles.rowHint}>{widgetId ? t('reading') : t('noWidget')}</p>
          )}
          <span className={styles.rowHint}>{t('otherHint')}</span>
        </div>
      </section>
      <p
        className={styles.strip}
        data-live={live ? '' : undefined}
        role="status"
        data-testid="webchat-install-status"
      >
        <span className={styles.stripDot} aria-hidden="true" />
        {live ? t('liveNow') : t('waiting')}
      </p>
    </>
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

/**
 * One source for both marks, as the design draws them from the business's
 * name: the logo "AVIV & CO.", the launcher its first word "AVIV". A name
 * with a tagline ("Urban Supply - GOTCHA demo") is cut at its first separator,
 * and never ends on a separator - a full stop is the name's ("CO.") (dev: "URBAN SUPPLY -").
 */
export function brandMark(name: string): { readonly logo: string; readonly launcher: string } {
  const head = name.split(/\s[-|·:\u2013\u2014]\s|\s*[|·]\s*/u)[0] ?? name;
  const tidy = (text: string) => text.trim().replace(/[\s\-|·:,;\u2013\u2014]+$/u, '');
  const upper = tidy(head).toUpperCase();
  const words = upper.split(/\s+/);
  let logo = '';
  for (const word of words) {
    if (logo && (logo + ' ' + word).length > 16) break;
    logo = logo ? `${logo} ${word}` : word;
  }
  return { logo: tidy(logo), launcher: tidy(words[0] ?? '').slice(0, 5) };
}
