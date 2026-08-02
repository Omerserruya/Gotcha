// Same reason as every other dynamic segment here: `output: export` cannot
// enumerate plan ids at build time, so emit the "_" placeholder and let the
// client router resolve the real id. Paired with an nginx rule that maps
// /system/plans/<id> onto the placeholder.
export const dynamicParams = true;
export function generateStaticParams() {
  return [{ id: "_" }];
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
