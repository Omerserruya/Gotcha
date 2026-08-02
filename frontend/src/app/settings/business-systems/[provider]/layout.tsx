// `output: export` refuses to build a dynamic segment that cannot enumerate
// its params, and the provider list is only knowable at runtime (it comes from
// the tenant's connected integrations). So emit the same single "_" placeholder
// every other dynamic route in this app uses and let the client router resolve
// the real provider, with `dynamicParams` allowing anything not pre-rendered.
//
// The matching nginx rule in gateway/nginx.prod.conf.template maps
// /settings/business-systems/<provider> onto this placeholder; without it the
// page deep-links to the root shell and renders nothing.
export const dynamicParams = true;
export function generateStaticParams() {
  return [{ provider: "_" }];
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
