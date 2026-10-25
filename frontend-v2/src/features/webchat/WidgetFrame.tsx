'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';

import { readWidgetBundle, WIDGET_BASE } from '@/api/client/widget-bundle';
import type { WebchatConfig } from '@/api/contracts/webchat';
import { brandInitial } from '@/lib/brand-mark';

import styles from './Webchat.module.css';

/** Edits settle this long before the widget is booted again: no rebuild per keystroke. */
export const SETTLE_MS = 300;

/**
 * The widget object the chat bundle is booted with - the same projection the
 * server's bootstrap makes (shared `publicWebchatConfig` + embedded-chat's
 * `withHandoff`, Backend 330b0461), from the draft being edited.
 *
 * ★ The header's name: the answering employee's when `nameSource` is
 *   "employee" and one is known, else the typed one - as the bootstrap does.
 * ★ Products: what the merchant switched on; whether a store is connected
 *   is the server's to decide on the live widget, never guessed here.
 * ★ Fields this screen never edits (contrast colour, corner radius,
 *   sounds) are left out: the widget draws its own defaults for them.
 */
export function previewWidget(
  config: WebchatConfig,
  {
    language,
    employeeName,
    handoff,
    business = null,
  }: {
    readonly language: 'he' | 'en';
    readonly employeeName: string | null;
    readonly handoff: boolean;
    /** The business's name: the widget's wordmark, as the bootstrap's `brand` (brandOf). */
    readonly business?: string | null;
  },
) {
  const brandName = business?.trim().slice(0, 60) || null;
  const typed = config.ux.welcome.assistantName;
  const employee = config.nameSource === 'employee' ? employeeName?.trim() || null : null;
  const assistantName = employee ?? typed;
  const welcome = { ...config.ux.welcome, assistantName };
  return {
    appearance: {
      primaryColor: config.appearance.primaryColor,
      logoUrl: config.appearance.logoUrl,
      launcherPosition: config.ux.launcher.position,
      // The preview's language, not "auto": the merchant sees one of the two.
      language,
      // "auto", never a pinned rtl: a bubble that is really English still reads left to right.
      direction: 'auto',
      showPoweredBy: true,
    },
    welcome: {
      headline: config.ux.welcome.title,
      subline: '',
      assistantName,
      suggestedQuestions: config.ux.welcome.suggestedQuestions.filter((q) => q.trim()),
    },
    offline: {
      active: false,
      message: '',
      behavior: 'ai',
      formFields: [],
      consentRequired: false,
      consentText: '',
    },
    features: {
      humanHandoff: false,
      productMessaging: config.commerce.productMessagingEnabled,
      addToCart: config.commerce.productMessagingEnabled && config.commerce.addToCartEnabled,
      whatsappHandoff: handoff,
    },
    ux: {
      welcome,
      launcher: config.ux.launcher,
      hero: config.ux.hero,
      proactive: { ...config.ux.proactive },
      kind: config.ux.kind,
      look: config.ux.kind === 'whatsapp' ? 'whatsapp' : config.ux.look,
    },
    nameSource: employee ? 'employee' : 'custom',
    brand: brandName ? { name: brandName, initial: brandInitial(brandName) } : null,
    promotions: [],
  };
}

type Factory = (options: Record<string, unknown>) => { open: () => void };

/**
 * 13g's preview, the real widget (supervisor, 2026-10-24; legacy
 * WidgetPreview.tsx): the SAME chat bundle the site loads, booted inside an
 * iframe against the draft. One renderer, so nothing drifts: a change to the
 * widget shows here on the next load, because it is the same file.
 *
 * ★ No network and no session: every call the widget makes resolves here,
 *   and its store is in memory, so a preview never creates a conversation,
 *   sends a message or writes a visitor session.
 * ★ `preview: true` keeps the caret where the merchant is typing.
 * ★ Rebuilt from scratch when the draft settles (the widget owns its shadow
 *   root and has no re-configure entry point) - the honest picture of a
 *   visitor's first load.
 * ★ The bundle's name is read from the manifest, fresh: names are content-
 *   hashed, and a hard-coded one is how a stale widget was served once.
 */
export function WidgetFrame({
  config,
  employeeName,
  handoff,
  language,
  business,
}: {
  readonly config: WebchatConfig;
  readonly employeeName: string | null;
  readonly handoff: boolean;
  readonly language: 'he' | 'en';
  readonly business: string | null;
}) {
  const t = useTranslations('channels.webchat.preview');
  const frame = useRef<HTMLIFrameElement>(null);
  const [bundle, setBundle] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    void readWidgetBundle().then((chat) => {
      if (!alive) return;
      if (chat) setBundle(chat);
      else setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const widget = useMemo(
    () => JSON.stringify(previewWidget(config, { language, employeeName, handoff, business })),
    [config, language, employeeName, handoff, business],
  );
  // The first draft at once; later edits after a pause.
  const [settled, setSettled] = useState(widget);
  useEffect(() => {
    if (settled === widget) return;
    const timer = window.setTimeout(() => setSettled(widget), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [widget, settled]);

  useEffect(() => {
    const doc = frame.current?.contentDocument;
    const win = frame.current?.contentWindow as
      (Window & { __gotchaShopifyChatApp?: Factory }) | null;
    if (!bundle || !doc || !win) return;
    let cancelled = false;
    doc.open();
    doc.write(
      '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body style="margin:0"></body></html>',
    );
    doc.close();
    const script = doc.createElement('script');
    script.src = `${WIDGET_BASE}/${bundle}`;
    script.onload = () => {
      if (cancelled) return;
      const factory = win.__gotchaShopifyChatApp;
      if (typeof factory !== 'function') {
        setFailed(true);
        return;
      }
      const host = doc.createElement('div');
      doc.body.appendChild(host);
      const memory: Record<string, string> = {};
      const app = factory({
        api: '',
        assets: '',
        context: { pageType: 'page', productHandle: null, locale: language },
        availability: 'online',
        store: {
          get: (k: string) => memory[k] ?? null,
          set: (k: string, v: string) => {
            memory[k] = v;
          },
          del: (k: string) => {
            delete memory[k];
          },
        },
        // No network: the welcome, and nothing to send anywhere.
        post: async (path: string) =>
          path.endsWith('/conversation')
            ? {
                data: {
                  conversationId: 'preview',
                  status: 'OPEN',
                  isHandedOver: false,
                  messages: [],
                },
              }
            : { data: {} },
        get: async () => ({ data: {} }),
        shadow: host.attachShadow({ mode: 'open' }),
        preview: true,
        setUnread: () => {},
        onOpened: () => {},
        onClosed: () => {},
        widget: JSON.parse(settled) as unknown,
      });
      app.open();
    };
    script.onerror = () => {
      if (!cancelled) setFailed(true);
    };
    doc.body.appendChild(script);
    return () => {
      cancelled = true;
    };
  }, [bundle, settled, language]);

  return (
    <div className={`${styles.pin} ${styles.frame}`} data-testid="webchat-preview-widget">
      {failed ? (
        <p className={styles.frameNote} role="status" data-testid="webchat-preview-failed">
          {t('frameFailed')}
        </p>
      ) : (
        <iframe
          ref={frame}
          title={t('frameTitle')}
          className={styles.frameWindow}
          // Our own file from our own origin; the sandbox still withholds navigation and forms.
          sandbox="allow-scripts allow-same-origin"
          data-testid="webchat-preview-frame"
        />
      )}
      {!bundle && !failed ? (
        <p className={styles.frameNote} data-testid="webchat-preview-loading">
          {t('frameLoading')}
        </p>
      ) : null}
    </div>
  );
}
