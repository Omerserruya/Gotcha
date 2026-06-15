// Shared integration logo map + lookup helpers.
// Keyed by integration slug (e.g. "zoho_crm"). Tools elsewhere carry the
// integration display NAME ("Zoho CRM"); `logoForIntegration` bridges both via
// `slugifyIntegration`. Used by IntegrationsExplorer and the AI builder's tool picker.

export const INTEGRATION_LOGOS: Record<string, string> = {
  shopify: "https://cdn.worldvectorlogo.com/logos/shopify.svg",
  woocommerce: "https://cdn.worldvectorlogo.com/logos/woocommerce.svg",
  bigcommerce: "https://cdn.worldvectorlogo.com/logos/bigcommerce-1.svg",
  magento: "https://cdn.worldvectorlogo.com/logos/magento.svg",
  wix: "https://cdn.worldvectorlogo.com/logos/wix.svg",
  shippo: "https://cdn.prod.website-files.com/64700b7f349828a5b8dc81ab/6720117f8561f9ad587b820e_AD_4nXewExxEHFrSDaVcyUsSBCZxMRLDfuZ3SYABIbGEikcH_3jFJsGRLXAAkPSeRsqBtlQ-tY89qW1qtX3rzZQ_qmt7hzOrNLQHdu2BOyIeEjIYliByLM5FwYgB0IMD-K46n9wKX6NFbKRsmT845rfmGYcGhQ5X.gif",
  easyship: "https://cdn.shopify.com/app-store/listing_images/7857972f1c70c4384cd3d0e61c5284c1/icon/CLPUja--4IMDEAE=.png",
  shipstation: "https://www.shipstation.com/wp-content/uploads/2024/10/ShipStation-BlogLaunch-Logo-2-1024x427.png",
  aftership: "https://aftership.ghost.io/content/images/2023/01/YouTube-avatar-2.png",
  stripe: "https://cdn.worldvectorlogo.com/logos/stripe-4.svg",
  paypal: "https://www.paypalobjects.com/webstatic/mktg/Logo/pp-logo-200px.png",
  square: "https://messenger-assets.qualified.com/uploads/7ujZqmvzoStw2DuEbeUvSkS2tNDMnum1bcHPM/c55336256d47abdd4b160b28e0535a57ccebff58605da5199d39e3af3b55fe3d.png",
  hubspot: "https://cdn.worldvectorlogo.com/logos/hubspot.svg",
  salesforce: "https://cdn.worldvectorlogo.com/logos/salesforce-2.svg",
  pipedrive: "https://cdn.worldvectorlogo.com/logos/pipedrive.svg",
  zoho_crm: "https://cdn.worldvectorlogo.com/logos/zoho-1.svg",
  zendesk: "https://cdn.worldvectorlogo.com/logos/zendesk.svg",
  intercom: "https://cdn.worldvectorlogo.com/logos/intercom-2.svg",
  monday: "https://cdn.worldvectorlogo.com/logos/monday-1.svg",
  google_calendar: "https://fonts.gstatic.com/s/i/productlogos/calendar_2020q4/v13/192px.svg",
  calendly: "https://calendly.com/media/favicon/icon-144x144.png",
  slack: "https://cdn.worldvectorlogo.com/logos/slack-new-logo.svg",
  google_analytics: "https://cdn.worldvectorlogo.com/logos/google-analytics-4.svg",
  postgresql: "https://cdn.worldvectorlogo.com/logos/postgresql.svg",
  mongodb: "https://cdn.worldvectorlogo.com/logos/mongodb-icon-1.svg",
  aws_rds: "https://cdn.worldvectorlogo.com/logos/aws-rds.svg",
  mongo_atlas: "https://cdn.worldvectorlogo.com/logos/mongodb-icon-1.svg",
  airtable: "https://www.google.com/s2/favicons?domain=airtable.com&sz=64",
  fireberry: "https://www.google.com/s2/favicons?domain=fireberry.com&sz=64",
  returngo: "https://www.google.com/s2/favicons?domain=returngo.ai&sz=64",
};

/** Normalize an integration display name to its slug: "Zoho CRM" → "zoho_crm". */
export function slugifyIntegration(nameOrSlug: string): string {
  return nameOrSlug
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Resolve a logo URL from either a slug ("zoho_crm") or a display name ("Zoho CRM"). */
export function logoForIntegration(nameOrSlug?: string | null): string | undefined {
  if (!nameOrSlug) return undefined;
  return INTEGRATION_LOGOS[nameOrSlug] || INTEGRATION_LOGOS[slugifyIntegration(nameOrSlug)];
}
