import { useTranslations } from 'next-intl';

import { AddCustomer } from './AddCustomer';
import styles from './Customers.module.css';

/**
 * 04's header actions - the search and "Add a customer" - static, so the
 * page and its `loading.tsx` draw the same ones.
 */
export function CustomersActions({ query }: { readonly query: string }) {
  const t = useTranslations('customers');
  return (
    <div className={styles.headActions}>
      <form className={styles.search} action="" method="get" data-testid="customer-search">
        <label className="srOnly" htmlFor="customer-q">
          {t('search.label')}
        </label>
        <input
          id="customer-q"
          name="q"
          type="search"
          className={styles.searchInput}
          defaultValue={query}
          placeholder={t('search.placeholder')}
          data-testid="customer-search-input"
        />
      </form>
      {/* 02's "Add a customer" - live: name and phone, never a duplicate. Outside the search form, so Enter there never searches. */}
      <AddCustomer />
    </div>
  );
}
