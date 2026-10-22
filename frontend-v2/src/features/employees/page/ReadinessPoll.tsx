'use client';

import { useEffect } from 'react';

import { useRouter } from '@/i18n/navigation';

import { READINESS_POLL_MS } from './EmployeeReadiness';

/**
 * Reads the page again every few seconds while a readiness run is stored as
 * running - for a server-drawn screen (07e) that cannot re-read itself. Draws
 * nothing; mounted only while the run is running.
 */
export function ReadinessPoll() {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), READINESS_POLL_MS);
    return () => clearInterval(timer);
  }, [router]);
  return null;
}
