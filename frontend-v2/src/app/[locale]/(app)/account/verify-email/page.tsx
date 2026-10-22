import { VerifyEmail } from '@/features/account/VerifyEmail';
import { PageContainer } from '@/shell/PageContainer';

/**
 * `/account/verify-email?token=` - confirming a new sign-in address.
 *
 * In the product, not the sign-in surface: the route it calls needs the
 * session (services/auth account.ts:41, :448), so the proxy sends a signed-out
 * visitor to sign in first with this link as `returnTo` - what the legacy
 * page did with `login(returnPath)` - and this layout checks the session again.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const { token } = await searchParams;
  return (
    <PageContainer>
      <VerifyEmail token={typeof token === 'string' && token.length > 0 ? token : null} />
    </PageContainer>
  );
}
