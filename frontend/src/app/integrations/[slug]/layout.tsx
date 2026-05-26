export const dynamicParams = true;
export function generateStaticParams() {
  return [{ slug: "_" }];
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
