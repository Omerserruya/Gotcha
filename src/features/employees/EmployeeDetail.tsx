import { getFormatter, getTranslations } from 'next-intl/server';

import {
  capabilityStance,
  humaniseCode,
  humaniseToolName,
  type Capability,
} from '@/api/contracts/capabilities';
import {
  aloneRate,
  EMPLOYEE_TONES,
  employeeLanguages,
  handoverRules,
  responsibilityOf,
  roleKeyOf,
  type Employee,
} from '@/api/contracts/employees';
import { channelNameList } from '@/api/contracts/inbox';
import { isConnected, type Integration } from '@/api/contracts/integrations';
import { UserText } from '@/design-system/primitives/text/UserText';
import { Link } from '@/i18n/navigation';

import { DeleteEmployee } from './DeleteEmployee';
import styles from './EmployeeDetail.module.css';
import { PauseEmployee } from './PauseEmployee';

/** How many permission rows the card shows, as 02's does. */
const MAY_DO_ROWS = 6;

/**
 * Screen 07's detail - the selected employee, measured.
 *
 * The name (30/600) over what it is responsible for, Pause/Edit on the
 * right; a strip of four; then three columns of cards.
 *
 * ── LIVE ──
 *   the line under the name   `identity.responsibility`, else `goal`
 *   Answers on                `channels`
 *   How it answers            `tone` and `languages`
 *   What it may do            the tenant's capabilities - 10's own line says
 *                             they apply to every AI employee, and the card
 *                             says so: there are no per-employee overrides
 *   What it knows             its knowledge sources, readable or switched off
 *   Connected tools           the business's connected systems
 *   When it hands over        its handover rules that are on
 *
 * ── DRAWN, IN THEIR SHAPE ("-" or a sentence), AND WHY ──
 *   Handled TODAY             the count has no clock: the strip says "in all"
 *   Passed to a human         no handover cause is recorded
 *   Customer rating           nothing rates a conversation
 *   A reply from today        no reply is picked out per employee
 *   What it handles           nothing groups its conversations by topic
 *   Worth changing            nothing proposes a change
 */
export async function EmployeeDetail({
  employee,
  capabilities,
  integrations,
}: {
  readonly employee: Employee;
  /** `null`: the permissions read failed. */
  readonly capabilities: readonly Capability[] | null;
  /** `null`: the systems read failed. */
  readonly integrations: readonly Integration[] | null;
}) {
  const t = await getTranslations('employees');
  const channelNames = await getTranslations('channels');
  const format = await getFormatter();

  const roleKey = roleKeyOf(employee);
  const responsibility = responsibilityOf(employee);
  const rate = aloneRate(employee);
  /*
    ★ The agent's channels are stored as the builder sent them - documented
    lowercase (`whatsapp`), where `channelName` knows the platform's enum
    (`WHATSAPP`). Unnormalised, every channel read "Another channel".
  */
  const channels = channelNameList(
    employee.channels.map((channel) => channel.toUpperCase()),
    channelNames,
  );
  const languages = employeeLanguages(employee);
  const tone = employee.tone.trim();
  const rules = handoverRules(employee);
  const mayDo = (capabilities ?? []).filter((c) => c.kind === 'action').slice(0, MAY_DO_ROWS);
  const connected = (integrations ?? []).filter(isConnected);

  const languageName = (code: string) =>
    ['english', 'hebrew', 'arabic'].includes(code)
      ? t(`detail.language.${code}` as 'detail.language.english')
      : humaniseCode(code);

  return (
    <>
      <header className={styles.head}>
        <div className={styles.heading}>
          <h2 className={styles.name}>{employee.name}</h2>
          <p className={styles.line} data-testid="detail-line">
            {responsibility ? (
              <UserText>{responsibility}</UserText>
            ) : roleKey ? (
              t(`role.${roleKey}` as 'role.sales')
            ) : (
              <span className={styles.unset}>{t('role.unset')}</span>
            )}
          </p>
        </div>
        <div className={styles.actions}>
          <PauseEmployee
            id={employee.id}
            name={employee.name}
            openConversations={employee.openConversations}
            paused={employee.status === 'PAUSED'}
          />
          {/* 07f: the Edit sheet over this screen. */}
          <Link
            href={{
              pathname: '/studio/employees',
              query: { employee: employee.id, edit: '1' },
            }}
            className={styles.button}
            data-testid="edit"
            scroll={false}
          >
            {t('detail.edit')}
          </Link>
          <DeleteEmployee employee={employee} />
        </div>
      </header>

      <dl className={styles.strip} data-testid="detail-strip">
        <div className={styles.cell}>
          {/* 02 says "today"; the count has no clock, so it says "in all". */}
          <dt>{t('detail.strip.handled')}</dt>
          <dd>{format.number(employee.handledConversations)}</dd>
        </div>
        <div className={styles.cell}>
          <dt>{t('detail.strip.alone')}</dt>
          <dd>{rate === null ? '-' : format.number(rate, { style: 'percent' })}</dd>
        </div>
        <div className={styles.cell}>
          <dt>{t('detail.strip.passed')}</dt>
          <dd>-</dd>
        </div>
        <div className={styles.cell}>
          <dt>{t('detail.strip.rating')}</dt>
          <dd>-</dd>
        </div>
      </dl>

      <div className={styles.grid}>
        <div className={styles.column}>
          <section className={styles.card} data-testid="card-answers-on">
            <h3 className={styles.cardHead}>
              {t('detail.answersOn.title')}
              <span className={styles.cardMeta}>{t('detail.answersOn.meta')}</span>
            </h3>
            {channels.length > 0 ? (
              <ul className={styles.rows}>
                {channels.map((channel) => (
                  <li key={channel} className={styles.rowText}>
                    {channel}
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.none}>{t('noChannels')}</p>
            )}
          </section>

          <section className={styles.card} data-testid="card-how">
            <h3 className={styles.cardHead}>{t('detail.how.title')}</h3>
            <div className={styles.chips}>
              {tone ? (
                <span className={styles.chip}>
                  {(EMPLOYEE_TONES as readonly string[]).includes(tone)
                    ? t(`detail.tone.${tone}` as 'detail.tone.friendly')
                    : humaniseCode(tone)}
                </span>
              ) : null}
              {languages.length > 0 ? (
                <span className={styles.chip}>{languages.map(languageName).join(' · ')}</span>
              ) : null}
            </div>
            <div className={styles.sample}>
              <p className={styles.sampleEyebrow}>{t('detail.how.sample')}</p>
              <p className={styles.none}>{t('detail.how.sampleNone')}</p>
            </div>
          </section>
        </div>

        <div className={styles.column}>
          <section className={styles.card} data-testid="card-handles">
            <h3 className={styles.cardHead}>{t('detail.handles.title')}</h3>
            <div className={styles.chips}>
              <span className={styles.chipEmpty}>{t('detail.handles.none')}</span>
            </div>
          </section>

          <section className={styles.card} data-testid="card-may-do">
            <h3 className={styles.cardHead}>{t('detail.mayDo.title')}</h3>
            {capabilities === null ? (
              <p className={styles.none}>{t('detail.mayDo.unavailable')}</p>
            ) : mayDo.length === 0 ? (
              <p className={styles.none}>{t('detail.mayDo.none')}</p>
            ) : (
              <ul className={styles.rows}>
                {mayDo.map((capability) => {
                  const stance = capabilityStance(capability);
                  return (
                    <li
                      key={capability.toolName}
                      className={styles.rowSplit}
                      data-testid={`may-${capability.toolName}`}
                    >
                      <span className={styles.rowLabel}>
                        {humaniseToolName(capability.toolName)}
                      </span>
                      <span className={styles.stance} data-stance={stance}>
                        {t(`detail.mayDo.${stance}`)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className={styles.cardFoot}>{t('detail.mayDo.everyone')}</p>
          </section>

          <section className={styles.card} data-testid="card-knows">
            <h3 className={styles.cardHead}>{t('detail.knows.title')}</h3>
            {employee.knowledgeSources.length === 0 ? (
              <p className={styles.none}>{t('knowledge.none')}</p>
            ) : (
              <ul className={styles.rows}>
                {employee.knowledgeSources.map((source) => (
                  <li key={source.id} className={styles.rowSplit}>
                    <span className={styles.rowLabelQuiet}>
                      {source.name || humaniseCode(source.id)}
                    </span>
                    <span className={styles.knows} data-state={source.isActive ? 'on' : 'off'}>
                      {source.isActive ? t('detail.knows.on') : t('detail.knows.off')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className={styles.column}>
          <section className={styles.card} data-testid="card-tools">
            <h3 className={styles.cardHead}>
              {t('detail.tools.title')}
              <span className={styles.cardMeta}>{t('detail.tools.meta')}</span>
            </h3>
            {integrations === null ? (
              <p className={styles.none}>{t('detail.tools.unavailable')}</p>
            ) : connected.length === 0 ? (
              <p className={styles.none}>{t('detail.tools.none')}</p>
            ) : (
              <ul className={styles.rows}>
                {connected.map((integration) => (
                  <li key={integration.id} className={styles.rowText}>
                    {integration.name}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className={styles.card} data-testid="card-handover">
            <h3 className={styles.cardHead}>{t('detail.handover.title')}</h3>
            {rules.length > 0 ? (
              <ul className={styles.rows}>
                {rules.map((rule) => (
                  <li key={rule} className={styles.rowQuiet}>
                    <UserText>{rule}</UserText>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.none}>{t('detail.handover.none')}</p>
            )}
          </section>

          <section className={styles.worth} data-testid="card-worth">
            <h3 className={styles.worthHead}>{t('detail.worth.title')}</h3>
            <p className={styles.worthBody}>{t('detail.worth.none')}</p>
          </section>
        </div>
      </div>
    </>
  );
}
