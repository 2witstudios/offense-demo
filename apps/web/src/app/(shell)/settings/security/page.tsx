import type { Metadata } from 'next';
import type { SearchParams } from '../../../../features/access/decision';
import { requireAccess } from '../../../../lib/access';
import { SecurityPage } from '../../../../ui/settings/security/security-page';
import { prose } from '../../../ui/prose-class';
import { changeEmailAction } from './actions';

export const metadata: Metadata = { title: 'Account security' };

export default async function AccountSecurityPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireAccess('/settings/security', searchParams);
  return (
    <>
      <h1 className={prose.h1}>Account security</h1>
      <SecurityPage changeEmail={changeEmailAction} />
    </>
  );
}
