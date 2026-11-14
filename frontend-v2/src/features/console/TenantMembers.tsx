'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import type { TenantMember } from '@/api/contracts/console';
import { Button } from '@/design-system/primitives/button/Button';
import { Input } from '@/design-system/primitives/input/Input';
import { UserText } from '@/design-system/primitives/text/UserText';

import { ConfirmedAction } from './ConfirmedAction';
import styles from './Console.module.css';
import { addMember, changeMemberEmail, removeMember, type EditResult } from './edit-actions';
import { useEditRefusal, useEditWarnings } from './TenantStatusEdit';

const EMAIL = /^\S+@\S+\.\S+$/;
const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * A tenant's owners and users, edited by hand (Backend's manual-edit
 * contract): change a member's login email, remove a member, add one.
 *
 * A platform administrator's row is shown and never offered an edit: the
 * routes refuse both. An address already in the list is refused here, before
 * the route, which answers a duplicate invite with a bare 500.
 */
export function TenantMembers({
  tenantId,
  members,
}: {
  readonly tenantId: string;
  /** `undefined`: the list could not be read. */
  readonly members: readonly TenantMember[] | undefined;
}) {
  const t = useTranslations('console.edit.members');

  return (
    <section className={styles.card} aria-labelledby="tenant-members" data-testid="tenant-members">
      <h2 id="tenant-members" className={styles.cardTitle}>
        {t('title')}
      </h2>
      {members === undefined ? (
        <p className={styles.refused} role="alert" data-testid="members-unread">
          {t('unread')}
        </p>
      ) : members.length === 0 ? (
        <p className={styles.quiet}>{t('empty')}</p>
      ) : (
        <ul className={styles.members}>
          {members.map((member) => (
            <MemberRow key={member.id} tenantId={tenantId} member={member} />
          ))}
        </ul>
      )}
      {members === undefined ? null : <AddMember tenantId={tenantId} members={members} />}
    </section>
  );
}

function MemberRow({
  tenantId,
  member,
}: {
  readonly tenantId: string;
  readonly member: TenantMember;
}) {
  const t = useTranslations('console.edit');
  const refusal = useEditRefusal();
  const warnings = useEditWarnings();
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState('');
  const editable = member.role !== 'SYSTEM_ADMIN';
  const name = member.name.trim() || member.email;
  const role = t.has(`members.roles.${member.role}`)
    ? t(`members.roles.${member.role}`)
    : member.role;
  const ready = EMAIL.test(email.trim()) && !sameEmail(email, member.email);

  return (
    <li className={styles.member} data-testid={`member-${member.id}`}>
      <span className={styles.memberWho}>
        <UserText className={styles.name}>{name}</UserText>
        <UserText className={styles.quiet}>{member.email}</UserText>
        <span className={styles.quiet}>
          {role}
          {member.isActive ? null : ` · ${t('members.inactive')}`}
        </span>
      </span>
      {editable ? (
        <span className={styles.controlRow}>
          {editing ? (
            <>
              <Input
                label={t('members.email.label')}
                type="email"
                dir="ltr"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                data-testid={`member-email-${member.id}`}
              />
              <ConfirmedAction<EditResult>
                label={t('members.email.save')}
                disabled={!ready}
                sentences={[t('members.email.what', { name, email: email.trim() })]}
                reason={t('reason')}
                yes={t('members.email.yes')}
                run={({ reason }) => changeMemberEmail(tenantId, member.id, email, reason)}
                done={() => t('members.email.done', { email: email.trim() })}
                notes={warnings}
                refused={refusal}
                testid={`member-email-save-${member.id}`}
              />
              <Button size="sm" onClick={() => setEditing(false)}>
                {t('members.email.cancel')}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              onClick={() => {
                setEmail('');
                setEditing(true);
              }}
              data-testid={`member-email-open-${member.id}`}
            >
              {t('members.email.open')}
            </Button>
          )}
          <ConfirmedAction<EditResult>
            label={t('members.remove.label')}
            variant="danger"
            sentences={[t('members.remove.what', { name })]}
            reason={t('reason')}
            yes={t('members.remove.yes')}
            run={({ reason }) => removeMember(tenantId, member.id, reason)}
            done={() => t('members.remove.done', { name })}
            refused={refusal}
            testid={`member-remove-${member.id}`}
          />
        </span>
      ) : null}
    </li>
  );
}

function AddMember({
  tenantId,
  members,
}: {
  readonly tenantId: string;
  readonly members: readonly TenantMember[];
}) {
  const t = useTranslations('console.edit');
  const refusal = useEditRefusal();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'ADMIN' | 'AGENT'>('AGENT');
  const taken = members.some((member) => sameEmail(member.email, email));
  const ready = name.trim() !== '' && EMAIL.test(email.trim()) && !taken;

  return (
    <div className={styles.assign} data-testid="member-add">
      <h3 className={styles.fieldLabel}>{t('members.add.title')}</h3>
      <Input
        label={t('members.add.name')}
        value={name}
        maxLength={120}
        onChange={(event) => setName(event.target.value)}
      />
      <Input
        label={t('members.add.email')}
        type="email"
        dir="ltr"
        value={email}
        error={taken ? t('refusal.already_member') : undefined}
        onChange={(event) => setEmail(event.target.value)}
      />
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t('members.add.role')}</span>
        <select
          className={styles.select}
          value={role}
          onChange={(event) => setRole(event.target.value as 'ADMIN' | 'AGENT')}
          data-testid="member-add-role"
        >
          <option value="AGENT">{t('members.roles.AGENT')}</option>
          <option value="ADMIN">{t('members.roles.ADMIN')}</option>
        </select>
      </label>
      <ConfirmedAction<EditResult>
        label={t('members.add.label')}
        variant="primary"
        disabled={!ready}
        sentences={[
          t('members.add.what', { email: email.trim(), role: t(`members.roles.${role}`) }),
        ]}
        reason={t('reason')}
        yes={t('members.add.yes')}
        run={({ reason }) => addMember(tenantId, { email, name, role }, reason)}
        done={() => t('members.add.done', { email: email.trim() })}
        refused={refusal}
        testid="member-add-submit"
      />
    </div>
  );
}
