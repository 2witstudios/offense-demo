import { readFileSync } from 'node:fs';
import { assert, describe, test } from 'riteway/bun';
import { findRuntimeRoleGateProblem } from './runtime-role-gate';

// Shared fixtures for the start.ts runtime-role gate's table tests
// (scripts/runtime-role-gate.ts): the committed start.ts, the edits that
// reshape it and the problems the guard reports.
// Prettier wraps the refuseRole line once the role name is long (a long
// project slug); the guard reads the AST, so the fixtures join it back to
// the one line every edit below anchors on.
export const realStart = readFileSync(
  'apps/web/src/server/start.ts',
  'utf8',
).replace(
  /^ {2}refuseRole: \(\) =>\n\s+refuseSchemaAlteringRole\(/m,
  '  refuseRole: () => refuseSchemaAlteringRole(',
);

export const REFUSAL =
  "  refuseRole: () => refuseSchemaAlteringRole(app, 'offense_demo_web'),\n";
export const START_IMPORT =
  "import { startProductionServer } from './listen-first';\n";
export const DB_IMPORT =
  "import { refuseSchemaAlteringRole } from '@offense-demo/db';\n";
export const CALL = 'const { server, started } = startProductionServer({\n';
export const ROUTE_READ =
  "      return readFileSync('/proc/net/route', 'utf8');\n";
export const NO_OP_OPTIONS =
  "{\n  app,\n  nextApp,\n  refuseRole: async () => {},\n  readRouteTable: () => null,\n  port: port + 1,\n  host: '0.0.0.0',\n}";
export const SHIM = 'apps/web/src/server/shim.ts';

export const edit = (from: string, to: string) => {
  if (!realStart.includes(from))
    throw new Error(`fixture anchor missing: ${from}`);
  return realStart.replace(from, to);
};
export const append = (tail: string) => `${realStart}${tail}`;

export const MISSING =
  "start.ts does not start through startProductionServer with refuseRole: () => refuseSchemaAlteringRole(app, 'offense_demo_web') and await started";
export const bypass = (token: string) =>
  `start.ts bypasses the start-up gate with ${token}; start only through startProductionServer (ISSUE-193)`;
export const IMPORT =
  'start.ts must import startProductionServer, unaliased, from ./listen-first and nothing else from it (ISSUE-218)';
export const ONE_CALL =
  'start.ts must call startProductionServer exactly once, directly by that name; a second call, alias, .call, optional call or other reference starts a server the checked refusal does not guard (ISSUE-206, ISSUE-218)';
export const OVERRIDDEN =
  "start.ts's startProductionServer call must set refuseRole once by a plain key, with no spread or computed key that could override it (ISSUE-206, ISSUE-218)";
export const NOT_FROM_DB =
  'start.ts must import refuseSchemaAlteringRole from @offense-demo/db and use it only as the refuseRole (ISSUE-206)';
export const unparsed = (diagnostic: string, line: number) =>
  `start.ts does not parse: ${diagnostic} (line ${line}); the gate cannot be checked (ISSUE-221)`;
export const unresolved = (specifier: string) =>
  `start.ts imports ${specifier}, which does not resolve; the gate cannot be checked (ISSUE-221)`;
export const lineCount = realStart.split('\n').length;
export const BOOT = 'apps/web/src/server/boot2.ts';

export type Row = {
  readonly shape: string;
  readonly startTs: string;
  readonly files?: Readonly<Record<string, string>>;
  readonly expected: string | null;
};

/** One test per row: the gate's answer for that start.ts is `expected`. */
export const describeRows = (
  title: string,
  should: string,
  rows: readonly Row[],
) =>
  describe(title, () => {
    for (const row of rows)
      test(row.shape, () => {
        assert({
          given: `start.ts with ${row.shape}`,
          should,
          actual: findRuntimeRoleGateProblem(row.startTs, row.files),
          expected: row.expected,
        });
      });
  });
