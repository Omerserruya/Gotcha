import { useTranslations } from 'next-intl';

import { AddCustomer } from './AddCustomer';
import { CustomerSearch } from './CustomerSearch';
import styles from './Customers.module.css';

/**
 * 04's header actions - the search and "Add a customer" - static, so the
 * page and its `loading.tsx` draw the same ones.
 */
export function CustomersActions({ query }: { readonly query: string }) {
  const t = useTranslations('customers');
  return (
    <div className={styles.headActions}>
      <CustomerSearch
        query={query}
        label={t('search.label')}
        placeholder={t('search.placeholder')}
        busyLabel={t('search.busy')}
      />
      {/* 02's "Add a customer" - live: name and phone, never a duplicate. Outside the search form, so Enter there never searches. */}
      <AddCustomer />
    </div>
  );
}
