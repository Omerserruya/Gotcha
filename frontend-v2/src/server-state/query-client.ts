import { QueryClient, type QueryClientConfig } from '@tanstack/react-query';

import { ApiError } from '@/api/client/api-error';

/**
 * Server-state defaults.
 *
 * The retry policy is the part worth reading. Retrying a failed request is
 * only correct when the failure was transient. Retrying a 403 is noise;
 * retrying a 401 delays the sign-in the user actually needs; retrying a
 * mutation risks applying it twice. So: reads retry transient failures twice,
 * writes never retry automatically - a mutation that failed for an unknown
 * reason may have partially applied, and the user decides whether to repeat it.
 */
const config: QueryClientConfig = {
  defaultOptions: {
    queries: {
      // Operational data goes stale quickly; realtime events invalidate the
      // rest. Thirty seconds keeps a tab switch from refetching everything.
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      retry(failureCount, error) {
        if (failureCount >= 2) return false;
        return error instanceof ApiError ? error.isRetryable : false;
      },
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
    },
    mutations: {
      retry: false,
    },
  },
};

export function createQueryClient(): QueryClient {
  return new QueryClient(config);
}
