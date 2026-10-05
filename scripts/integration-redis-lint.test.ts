import { setDefaultTimeout } from 'bun:test';
import { ESLint } from 'eslint';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';

setupRitewayBun();
// The first typed lint builds the whole program: as slow as eslint.config.test.ts.
setDefaultTimeout(180_000);

let shared: ESLint | undefined;
const repositoryEslint = (): ESLint =>
  (shared ??= new ESLint({
    cwd: process.cwd(),
    overrideConfigFile: './eslint.config.mjs',
  }));

/** The restriction messages (syntax and imports) ESLint reports for `text` at `filePath`. */
const restricted = async (filePath: string, text: string) =>
  (await repositoryEslint().lintText(text, { filePath }))[0]?.messages
    .filter(
      ({ ruleId }) =>
        ruleId === 'no-restricted-syntax' || ruleId === 'no-restricted-imports',
    )
    .map(({ message }) => message) ?? [];

const integrationFiles = [
  'packages/redis/integration/x.integration.ts',
  'apps/web/integration/x.integration.ts',
  'apps/realtime/integration/x.integration.ts',
];

describe('integration files reach Redis only through the guarded helper (ISSUE-245)', () => {
  test('a raw client, a whole-database scan and FLUSH are each refused in every integration workspace', async () => {
    const bad = [
      "import { RedisClient } from 'bun'; const a = new RedisClient(url);",
      'await deleteKeysWithoutExpiry(client);',
      "await client.send('FLUSHDB', []);",
      "await client.send('flushall', []);",
      "await client.send('SCAN', ['0', 'MATCH', '*']);",
      "await client.send('KEYS', ['*']);",
    ];
    const files = [
      'packages/redis/integration/x.integration.ts',
      'apps/web/integration/x.integration.ts',
      'apps/realtime/integration/x.integration.ts',
    ];

    const reports = await Promise.all(
      files.flatMap((file) => bad.map((text) => restricted(file, text))),
    );

    assert({
      given:
        'a raw Redis client, a whole-database scan, FLUSHDB/FLUSHALL and a scan or KEYS of everything, in each integration workspace',
      should: 'report at least one restriction for each',
      actual: reports.map((messages) => messages.length > 0),
      expected: reports.map(() => true),
    });
  });

  test('negative control: the guarded helper and namespace-scoped commands are allowed', async () => {
    const messages = await restricted(
      'packages/redis/integration/x.integration.ts',
      "import { openTestRedis } from '@offense-demo/redis/testing'; const client = openTestRedis(url); await deleteKeysWithoutExpiry(client, `${namespace}:*`); await client.send('KEYS', [`${namespace}:*`]); await client.send('SCAN', ['0', 'MATCH', `${namespace}:*`]);",
    );

    assert({
      given:
        'openTestRedis and a delete, KEYS and SCAN scoped to one namespace',
      should: 'report no restricted-syntax error',
      actual: messages,
      expected: [],
    });
  });

  test('negative control: outside integration files (the runner, slot tooling) a raw client is allowed', async () => {
    const messages = await restricted(
      'scripts/x.ts',
      "import { RedisClient } from 'bun'; const a = new RedisClient(url); await deleteKeysWithoutExpiry(a);",
    );

    assert({
      given: 'the runner’s own use, in scripts/',
      should: 'report no restricted-syntax error',
      actual: messages,
      expected: [],
    });
  });

  test('ISSUE-246: aliased, namespaced and default Redis clients and every disguised whole-database command are refused', async () => {
    const bypasses = [
      "import { RedisClient as RC } from 'bun'; const a = new RC(url);",
      "import * as B from 'bun'; const a = new B.RedisClient(url);",
      "import { redis } from 'bun'; await redis.send('GET', ['k']);",
      "await Bun.redis.send('GET', ['k']);",
      "await deleteKeysWithoutExpiry(client, '*');",
      "import { deleteAllKeysWithoutExpiry as d } from '@offense-demo/redis/namespaces'; await d(client);",
      "await client.send('scan', ['0', 'MATCH', '*']);",
      "await client.send('SCAN', ['0', 'COUNT', '500', 'MATCH', '*']);",
      "await client.send(`FLUSH${'DB'}`, []);",
      "await client.send(['FLUSH', 'DB'].join(''), []);",
      "const cmd = 'FLUSHDB'; await client.send(cmd, []);",
      "await client.send('keys', ['*']);",
      "await client.keys('*');",
      // ISSUE-274: ways to a raw client or the class behind a wrapper.
      'const c = new client.constructor(url);',
      'const C = client.constructor; const c = new C(url);',
      "const c = new client['constructor'](url);",
      "const { RedisClient } = await import('bun'); const c = new RedisClient(url);",
      "const B = await import('bun'); const c = new B.RedisClient(url);",
      "const B = require('bun'); const c = B.redis;",
      "await Bun['redis'].send('GET', ['k']);",
      'const c = new Bun.RedisClient(url);',
      "const { redis } = Bun; await redis.send('GET', ['k']);",
      "const { redis } = globalThis.Bun; await redis.send('GET', ['k']);",
      // ISSUE-271: aliasing the Bun global to get at redis later.
      'const B = Bun; const c = B.redis;',
      'const B = globalThis.Bun; const c = B.redis;',
      'const { Bun: B } = globalThis; const c = B.redis;',
      "const B = globalThis['Bun']; const c = B.redis;",
    ];

    const reports = await Promise.all(
      integrationFiles.flatMap((file) =>
        bypasses.map(async (text) => ({
          text,
          found: await restricted(file, text),
        })),
      ),
    );

    assert({
      given:
        'each bypass the ISSUE-245 review listed (alias, namespace, default export, "*" pattern, aliased import, lowercase scan, MATCH * after COUNT, template or joined FLUSHDB, a variable command, lowercase keys, .keys) in every integration workspace',
      should: 'flag every one',
      actual: reports
        .filter(({ found }) => found.length === 0)
        .map(({ text }) => text),
      expected: [],
    });
  });

  test('ISSUE-246 negative controls: type-only imports, scoped commands and unrelated send calls stay allowed', async () => {
    const allowed = [
      "import type { RedisClient } from 'bun'; export type Handle = RedisClient;",
      "import { SQL } from 'bun'; const sql = new SQL(url);",
      'await deleteKeysWithoutExpiry(client, `${namespace}:*`);',
      "await client.send('scan', ['0', 'MATCH', `${namespace}:*`, 'COUNT', '500']);",
      "await client.send('GET', [key]);",
      'socket.send(JSON.stringify(message));',
      'const forward = (command, args) => client.send(command, args);',
    ];

    const reports = await Promise.all(
      integrationFiles.flatMap((file) =>
        allowed.map(async (text) => ({
          text,
          found: await restricted(file, text),
        })),
      ),
    );

    assert({
      given:
        'a type-only RedisClient import, another Bun class, scoped delete and scan, an ordinary GET, a socket send and a forwarding wrapper',
      should: 'report no restriction',
      actual: reports.filter(({ found }) => found.length > 0),
      expected: [],
    });
  });
});
