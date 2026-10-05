/**
 * `bun db:roles`: provisions the test logins on the migrated local or CI
 * cluster DATABASE_URL names, through the same `provisionTestRoles` that
 * `bun slot:up` and `bun db:reset` call (ISSUE-6: one place). Loopback only.
 */
import { SQL } from 'bun';
import { provisionTestRoles } from '@offense-demo/db/slots';
import { e2eRole, isLoopbackUrl } from './slot-model';

const url = process.env.DATABASE_URL;
if (!url || !isLoopbackUrl(url))
  throw new Error('DATABASE_URL must name a loopback server');
const admin = new SQL(url, { max: 1 });
try {
  await provisionTestRoles(admin, e2eRole);
} finally {
  await admin.close();
}
process.stdout.write(
  `Provisioned ${e2eRole.user} as a member of offense_demo_web\n`,
);
