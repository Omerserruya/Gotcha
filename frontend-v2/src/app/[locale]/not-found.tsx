import { getTranslations } from 'next-intl/server';

import { Button } from '@/design-system/primitives/button/Button';
import { StateDisplay } from '@/design-system/patterns/StateDisplay';
import { Link } from '@/i18n/navigation';

export default async function NotFound() {
  const t = await getTranslations('errors');
  return (
    <StateDisplay
      title={t('notFound.title')}
      description={t('notFound.body')}
      actions={
        <Button variant="secondary" asChild>
          <Link href="/home">{t('notFound.home')}</Link>
        </Button>
      }
    />
  );
}
