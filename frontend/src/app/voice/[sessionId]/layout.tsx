export const dynamicParams = true;
export function generateStaticParams() {
  return [{ sessionId: "_" }];
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
