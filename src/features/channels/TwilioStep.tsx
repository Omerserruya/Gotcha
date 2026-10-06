'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { Button } from '@/design-system/primitives/button/Button';
import { Input } from '@/design-system/primitives/input/Input';
import { useRouter } from '@/i18n/navigation';

import { accountSidProblem } from './twilio';
import {
  activateVoiceNumbers,
  createVoiceChannel,
  type ActivationResult,
  type CreatedVoiceChannel,
} from './voice-actions';
import styles from './Channels.module.css';

/**
 * Phone calls with the merchant's own Twilio, inside 13's Connect panel -
 * the old app's three steps (details → numbers → activate), drawn the way
 * Email is: fields, then a list. No screen of its own.
 */
export function TwilioStep({ onClose }: { readonly onClose: () => void }) {
  const t = useTranslations('channels.twilio');
  const router = useRouter();
  const [form, setForm] = useState({ friendlyName: '', accountSid: '', authToken: '' });
  const [channel, setChannel] = useState<CreatedVoiceChannel | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [done, setDone] = useState<ActivationResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [isPending, startTransition] = useTransition();

  const sidBad = form.accountSid.trim() !== '' && accountSidProblem(form.accountSid);
  const ready = form.friendlyName.trim() && form.authToken && !accountSidProblem(form.accountSid);

  if (done) {
    return (
      <div data-testid="twilio-done">
        <p className={styles.connectNote}>
          {done.failed.length === 0
            ? t('done', { count: done.activated.length })
            : t('donePartly', { done: done.activated.length, failed: done.failed.length })}
        </p>
        <div className={styles.connectActions}>
          <Button size="sm" onClick={onClose}>
            {t('close')}
          </Button>
        </div>
      </div>
    );
  }

  if (channel) {
    return (
      <div data-testid="twilio-numbers">
        {channel.numbers.length === 0 ? (
          <p className={styles.connectNote} data-testid="twilio-no-numbers">
            {t('noNumbers')}
          </p>
        ) : (
          <>
            <p className={styles.connectNote}>{t('pick', { count: channel.numbers.length })}</p>
            <ul className={styles.twilioNumbers}>
              {channel.numbers.map((n) => (
                <li key={n.id}>
                  <label className={styles.whoAnswersOption}>
                    <input
                      type="checkbox"
                      checked={chosen.has(n.id)}
                      data-testid={`twilio-number-${n.id}`}
                      onChange={() => {
                        const next = new Set(chosen);
                        if (next.has(n.id)) next.delete(n.id);
                        else next.add(n.id);
                        setChosen(next);
                      }}
                    />
                    <span>{n.e164}</span>
                    {n.friendlyName ? (
                      <span className={styles.detail}>{n.friendlyName}</span>
                    ) : null}
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className={styles.connectActions}>
          <Button
            variant="primary"
            size="sm"
            disabled={isPending || chosen.size === 0}
            data-testid="twilio-activate"
            onClick={() =>
              startTransition(async () => {
                const result = await activateVoiceNumbers(channel.id, [...chosen]);
                setDone(result);
                router.refresh();
              })
            }
          >
            {isPending ? t('activating') : t('activate', { count: chosen.size })}
          </Button>
          <Button size="sm" onClick={onClose}>
            {t('later')}
          </Button>
        </div>
      </div>
    );
  }

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));
  return (
    <form
      className={styles.connectStack}
      data-testid="twilio-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || isPending) return;
        setProblem(null);
        startTransition(async () => {
          const result = await createVoiceChannel(form);
          if (result.ok) {
            setChannel(result.channel);
            // Every number chosen to start with, as the old app does.
            setChosen(new Set(result.channel.numbers.map((n) => n.id)));
          } else {
            setProblem(t(`error.${result.reason}`));
          }
        });
      }}
    >
      <a
        className={styles.connectHelp}
        href="https://console.twilio.com/"
        target="_blank"
        rel="noopener noreferrer"
        data-testid="twilio-help"
      >
        {t('help')}
      </a>
      <Input
        label={t('friendlyName')}
        value={form.friendlyName}
        maxLength={100}
        onChange={set('friendlyName')}
        data-testid="twilio-name"
      />
      <Input
        label={t('accountSid')}
        value={form.accountSid}
        autoComplete="off"
        spellCheck={false}
        onChange={set('accountSid')}
        hint={t('accountSidHint')}
        error={sidBad ? t('accountSidBad') : undefined}
        data-testid="twilio-sid"
      />
      <Input
        label={t('authToken')}
        type={showToken ? 'text' : 'password'}
        trailing={
          <button
            type="button"
            className={styles.connectReveal}
            aria-pressed={showToken}
            data-testid="twilio-token-show"
            onClick={() => setShowToken(!showToken)}
          >
            {showToken ? t('hide') : t('show')}
          </button>
        }
        value={form.authToken}
        autoComplete="off"
        onChange={set('authToken')}
        data-testid="twilio-token"
      />
      <div className={styles.connectActions}>
        <Button
          variant="primary"
          size="sm"
          type="submit"
          disabled={isPending || !ready}
          data-testid="twilio-connect"
        >
          {isPending ? t('checking') : t('connect')}
        </Button>
        <Button size="sm" type="button" onClick={onClose}>
          {t('later')}
        </Button>
      </div>
      {problem ? (
        <p className={styles.connectProblem} role="alert" data-testid="twilio-problem">
          {problem}
        </p>
      ) : null}
    </form>
  );
}
