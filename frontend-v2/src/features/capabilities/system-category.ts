import { humaniseCode } from '@/api/contracts/capabilities';

/**
 * A business system's category, in the reader's language - the finder's
 * chips and each system's line. The platform sends its enum
 * (`IntegrationCategory` in the schema: these eleven); `humaniseCode` made
 * them English words on a Hebrew screen (measured on dev, 2026-10-08).
 *
 * One added later is still said - in the platform's words, humanised - never
 * dropped and never a raw code.
 */
export const SYSTEM_CATEGORIES = [
  'ECOMMERCE',
  'CRM',
  'PAYMENTS',
  'HELPDESK',
  'COMMUNICATION',
  'ANALYTICS',
  'SHIPPING',
  'PROJECT_MANAGEMENT',
  'CALENDAR',
  'DATABASE',
  'CUSTOM',
] as const;
type SystemCategory = (typeof SYSTEM_CATEGORIES)[number];

export function systemCategoryName(
  code: string,
  t: (key: `systemCategory.${SystemCategory}`) => string,
): string {
  return (SYSTEM_CATEGORIES as readonly string[]).includes(code)
    ? t(`systemCategory.${code as SystemCategory}`)
    : humaniseCode(code);
}
