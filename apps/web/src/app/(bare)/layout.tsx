/**
 * The unstyled document routes outside the product shell (auth entry, the
 * gated foundation proof): no header, nav or rail, just the single main
 * landmark the root layout no longer owns.
 */
export default function BareLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return <main>{children}</main>;
}
