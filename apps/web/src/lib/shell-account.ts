import type { Identity } from '@offense-demo/auth';
import type { ShellAccount } from '../ui/layout/app-shell/components/topbar/topbar';

/**
 * The only fields the client shell learns: never ids, roles or access facts.
 * During a session-store outage the shell offers sign-in, which is where a
 * visitor can recover once the store is back.
 */
export const shellAccount = (identity: Identity): ShellAccount => {
  if (identity.state === 'member')
    return { state: 'member', username: identity.username };
  return identity.state === 'provisional'
    ? { state: 'provisional' }
    : { state: 'anonymous' };
};
