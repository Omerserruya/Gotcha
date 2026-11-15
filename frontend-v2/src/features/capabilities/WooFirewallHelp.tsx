'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState, useTransition, type ReactNode } from 'react';

import type { StoreProbe } from '@/api/contracts/woo-probe';
import { Button } from '@/design-system/primitives/button/Button';

import styles from './WooFirewallHelp.module.css';
import {
  firewallPlan,
  ipCondition,
  probeState,
  WOO_REST_PATH,
  type FirewallRule,
} from './woo-firewall';
import { probeWooStore } from './woo-probe-actions';

const NAMES = { cloudflare: 'Cloudflare', sucuri: 'Sucuri', imunify360: 'Imunify360' } as const;

/** A Cloudflare control's name, as Cloudflare writes it: English, left to right, in any language. */
const ui = (chunks: ReactNode) => (
  <bdi dir="ltr" className={styles.ui}>
    {chunks}
  </bdi>
);

/**
 * What to do when a firewall answered instead of the WooCommerce store
 * (`store_firewall_challenge`): which firewall, from GOTCHA's own probe, and
 * the steps for it - see `woo-firewall.ts` for which steps, in which order.
 *
 * `connectAgain` is the screen's own way to connect (the store's approval, the
 * plugin's button, or the keys form): this never re-sends anything itself.
 */
export function WooFirewallHelp({ connectAgain = null }: { readonly connectAgain?: ReactNode }) {
  const t = useTranslations('capabilities.wooFirewall');
  // `undefined`: not asked yet. `null`: asked, and it could not tell.
  const [probe, setProbe] = useState<StoreProbe | null | undefined>(undefined);
  const [checked, setChecked] = useState<ReturnType<typeof probeState> | null>(null);
  const [checking, startCheck] = useTransition();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    void probeWooStore().then((outcome) => {
      if (live) setProbe(outcome.ok ? outcome.probe : null);
    });
    return () => {
      live = false;
    };
  }, []);

  const plan = probe === undefined ? null : firewallPlan(probe);
  const firewall = probe?.firewall;
  const name = firewall && firewall !== 'other' ? NAMES[firewall] : 'none';

  const steps = (rule: FirewallRule) => {
    const egress = plan?.kind === 'cloudflare' ? plan.egress : null;
    const ip = rule === 'ip' && egress ? ipCondition(egress.ips) : null;
    return [
      t.rich('step.open', { ui }),
      t.rich('step.create', { ui }),
      ip
        ? t.rich('step.ip', { ui, operator: ip.operator, value: ip.value })
        : t.rich('step.path', { ui, path: WOO_REST_PATH }),
      rule === 'ip' ? t.rich('step.skipAll', { ui }) : t.rich('step.skipPath', { ui }),
      t.rich('step.deploy', { ui }),
      t.rich('step.botFight', { ui }),
    ];
  };

  /** The same steps as plain text, for someone else to follow. */
  const developerText = () => {
    const quote = (chunks: ReactNode) => `"${String(chunks)}"`;
    const lines = [t('developerIntro')];
    if (plan?.kind === 'cloudflare') {
      for (const rule of plan.rules) {
        const egress = plan.egress;
        const ip = rule === 'ip' && egress ? ipCondition(egress.ips) : null;
        lines.push('', rule === 'ip' ? t('ipTitle') : t('pathTitle'));
        const plain = [
          t.markup('step.open', { ui: quote }),
          t.markup('step.create', { ui: quote }),
          ip
            ? t.markup('step.ip', { ui: quote, operator: ip.operator, value: ip.value })
            : t.markup('step.path', { ui: quote, path: WOO_REST_PATH }),
          rule === 'ip'
            ? t.markup('step.skipAll', { ui: quote })
            : t.markup('step.skipPath', { ui: quote }),
          t.markup('step.deploy', { ui: quote }),
          t.markup('step.botFight', { ui: quote }),
        ];
        plain.forEach((line, i) => lines.push(`${i + 1}. ${line}`));
      }
    } else {
      lines.push('', t('host', { path: WOO_REST_PATH, name }));
    }
    return lines.join('\n');
  };

  return (
    <section
      className={styles.help}
      aria-labelledby="woo-firewall-title"
      data-testid="woo-firewall-help"
    >
      <h3 id="woo-firewall-title" className={styles.title}>
        {t('title')}
      </h3>
      <p className={styles.lead}>{t('lead', { name })}</p>

      {plan === null ? (
        <p className={styles.note} role="status" data-testid="woo-firewall-checking">
          {t('checking')}
        </p>
      ) : plan.kind === 'cloudflare' ? (
        plan.rules.map((rule, index) => (
          <div key={rule} className={styles.rule} data-testid={`woo-firewall-rule-${rule}`}>
            {index > 0 ? <p className={styles.or}>{t('orInstead')}</p> : null}
            <h4 className={styles.ruleTitle}>{rule === 'ip' ? t('ipTitle') : t('pathTitle')}</h4>
            <ol className={styles.steps}>
              {steps(rule).map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
            <p className={styles.note}>
              {rule === 'ip' ? t('ipScope') : t('pathScope', { path: WOO_REST_PATH })}
            </p>
            {rule === 'ip' && plan.egress && !plan.egress.stable ? (
              <p className={styles.note} data-testid="woo-firewall-may-change">
                {t('mayChange')}
              </p>
            ) : null}
          </div>
        ))
      ) : (
        <p className={styles.note} data-testid="woo-firewall-host">
          {t('host', { path: WOO_REST_PATH, name })}
        </p>
      )}

      {connectAgain === null && plan !== null ? (
        // The screen's own connect control is beside this: it is the way to connect again.
        <p className={styles.lead} data-testid="woo-firewall-then">
          {t('thenConnect')}
        </p>
      ) : null}

      {checked && !checking ? (
        <p
          className={styles.result}
          role="status"
          data-result={checked}
          data-testid="woo-firewall-result"
        >
          {t(`result.${checked}`)}
        </p>
      ) : null}

      <div className={styles.actions}>
        <Button
          type="button"
          variant="secondary"
          disabled={checking}
          data-testid="woo-firewall-check"
          onClick={() =>
            startCheck(async () => {
              const outcome = await probeWooStore();
              const next = outcome.ok ? outcome.probe : null;
              setProbe(next);
              setChecked(probeState(next));
            })
          }
        >
          {t('checkNow')}
        </Button>
        {connectAgain}
        {plan !== null ? (
          <Button
            type="button"
            variant="ghost"
            data-testid="woo-firewall-copy"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(developerText())
                .then(() => setCopied(true))
                .catch(() => setCopied(false));
            }}
          >
            {copied ? t('copied') : t('copy')}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
