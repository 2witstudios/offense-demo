import { AppShell } from '../../ui/layout/app-shell/app-shell';
import { shellAccount } from '../../lib/shell-account';
import { requestIdentity } from '../../lib/request-session';

/**
 * The product shell: renders AppShell's landmarks once (header, nav and the
 * content column) and resolves the account once per request, so every route
 * in this group inherits the chrome instead of each page composing it for
 * itself. Pass `rail` to AppShell to add a right rail. The root layout above
 * keeps only <html>, theme and fonts.
 */
export default async function ShellLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const identity = await requestIdentity();
  return <AppShell account={shellAccount(identity)}>{children}</AppShell>;
}
