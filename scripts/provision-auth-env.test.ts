import { expect } from 'bun:test';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  generateAuthSecret,
  provisionAuthEnv,
  provisionAuthSecret,
} from './provision-auth-env';

setupRitewayBun();

const marker = 'm'.repeat(64);

describe('auth secret provisioning', () => {
  test('appends a generated value when the variable is absent', () => {
    const content = 'DATABASE_URL=postgres://localhost/offense_demo\n';
    const result = provisionAuthSecret(content, { generate: () => marker });
    assert({
      given: 'a .env without BETTER_AUTH_SECRET',
      should: 'append the generated value and keep every existing line',
      actual: {
        changed: result.changed,
        hasSecretLine: result.content.includes(
          `BETTER_AUTH_SECRET=${marker}\n`,
        ),
        keepsExisting: result.content.includes(
          'DATABASE_URL=postgres://localhost/offense_demo\n',
        ),
      },
      expected: { changed: true, hasSecretLine: true, keepsExisting: true },
    });
  });

  test('preserves an existing value without invoking the generator', () => {
    let generateCalls = 0;
    const content =
      'PUBLIC_APP_URL=http://localhost:3000\nBETTER_AUTH_SECRET=existing\n';
    const result = provisionAuthSecret(content, {
      generate: () => {
        generateCalls += 1;
        return marker;
      },
    });
    assert({
      given: 'a .env with an existing BETTER_AUTH_SECRET value',
      should: 'preserve the file and never generate',
      actual: {
        changed: result.changed,
        content: result.content,
        generateCalls,
      },
      expected: {
        changed: false,
        content,
        generateCalls: 0,
      },
    });
  });

  test('treats an empty assignment as absent and fills it', () => {
    const result = provisionAuthSecret('BETTER_AUTH_SECRET=\n', {
      generate: () => marker,
    });
    assert({
      given: 'a .env whose BETTER_AUTH_SECRET line has no value',
      should: 'replace the empty value with a generated one',
      actual: result.content,
      expected: `BETTER_AUTH_SECRET=${marker}\n`,
    });
  });

  test('treats a whitespace-only assignment as absent and fills it', () => {
    const result = provisionAuthSecret('BETTER_AUTH_SECRET=   \n', {
      generate: () => marker,
    });
    assert({
      given: 'a .env whose BETTER_AUTH_SECRET line holds only whitespace',
      should: 'replace the blank value with a generated one',
      actual: result.content,
      expected: `BETTER_AUTH_SECRET=${marker}\n`,
    });
  });

  test('treats a CRLF blank assignment as absent and keeps the line ending', () => {
    const result = provisionAuthSecret('BETTER_AUTH_SECRET=\r\n', {
      generate: () => marker,
    });
    assert({
      given: 'a CRLF .env whose BETTER_AUTH_SECRET line has no value',
      should: 'fill the value and keep the CRLF ending',
      actual: result.content,
      expected: `BETTER_AUTH_SECRET=${marker}\r\n`,
    });
  });

  test('honors the last assignment when the variable is duplicated', () => {
    const content = 'BETTER_AUTH_SECRET=\nBETTER_AUTH_SECRET=kept\n';
    const result = provisionAuthSecret(content, { generate: () => marker });
    assert({
      given: 'an empty assignment followed by a valued duplicate',
      should: 'preserve the file because the last value wins',
      actual: { changed: result.changed, content: result.content },
      expected: { changed: false, content },
    });
  });

  test('fills only the last assignment when later duplicates are empty', () => {
    const content = 'BETTER_AUTH_SECRET=stale\nBETTER_AUTH_SECRET=\n';
    const result = provisionAuthSecret(content, { generate: () => marker });
    assert({
      given: 'a valued assignment followed by an empty duplicate',
      should: 'replace the effective last assignment only',
      actual: result.content,
      expected: `BETTER_AUTH_SECRET=stale\nBETTER_AUTH_SECRET=${marker}\n`,
    });
  });

  test('rotates an export-prefixed assignment by appending the canonical value last', () => {
    const content =
      'export BETTER_AUTH_SECRET=stale\nDATABASE_URL=postgres://localhost/offense_demo\n';
    const result = provisionAuthSecret(content, { generate: () => marker });
    assert({
      given: 'an export-prefixed existing assignment',
      should:
        'rotate by appending the canonical assignment so last-assignment loaders honor it',
      actual: {
        changed: result.changed,
        staleLineKept: result.content.includes(
          'export BETTER_AUTH_SECRET=stale\n',
        ),
        canonicalAssignmentLast: result.content.endsWith(
          `BETTER_AUTH_SECRET=${marker}\n`,
        ),
        keepsExisting: result.content.includes(
          'DATABASE_URL=postgres://localhost/offense_demo\n',
        ),
      },
      expected: {
        changed: true,
        staleLineKept: true,
        canonicalAssignmentLast: true,
        keepsExisting: true,
      },
    });
  });

  test('rotates a space-padded assignment and converges on the next run', () => {
    const content = 'BETTER_AUTH_SECRET = stale\n';
    const first = provisionAuthSecret(content, { generate: () => marker });
    const second = provisionAuthSecret(first.content, {
      generate: () => marker,
    });
    assert({
      given: 'a space-padded existing assignment',
      should:
        'append the canonical assignment once and treat the canonical result as preserved',
      actual: {
        changed: first.changed,
        paddedLineKept: first.content.includes('BETTER_AUTH_SECRET = stale\n'),
        rerunChanged: second.changed,
      },
      expected: { changed: true, paddedLineKept: true, rerunChanged: false },
    });
  });

  test('writes generated values containing replacement patterns literally', () => {
    const dollarSecret = `$&${'x'.repeat(62)}`;
    const result = provisionAuthSecret('BETTER_AUTH_SECRET=\n', {
      generate: () => dollarSecret,
    });
    assert({
      given: 'a generated value containing `$&`',
      should: 'write the value literally without pattern interpretation',
      actual: result.content,
      expected: `BETTER_AUTH_SECRET=${dollarSecret}\n`,
    });
  });

  test('appends with a separating newline when the file lacks a trailing one', () => {
    const result = provisionAuthSecret('LOG_LEVEL=info', {
      generate: () => marker,
    });
    assert({
      given: 'a .env without a trailing newline',
      should: 'start the generated line on its own line',
      actual: result.content,
      expected: `LOG_LEVEL=info\nBETTER_AUTH_SECRET=${marker}\n`,
    });
  });

  test('handles a completely empty file', () => {
    const result = provisionAuthSecret('', { generate: () => marker });
    assert({
      given: 'empty .env content',
      should: 'produce just the secret line',
      actual: result.content,
      expected: `BETTER_AUTH_SECRET=${marker}\n`,
    });
  });

  test('provisions a different named variable independently (ADR 0044, ISSUE-141)', () => {
    const content =
      'BETTER_AUTH_SECRET=existing\nDATABASE_URL=postgres://localhost/offense_demo\n';
    const result = provisionAuthSecret(content, {
      generate: () => marker,
      variableName: 'RECIPIENT_HASH_SECRET',
    });
    assert({
      given: 'a .env with BETTER_AUTH_SECRET set but no RECIPIENT_HASH_SECRET',
      should:
        'append a RECIPIENT_HASH_SECRET line and leave BETTER_AUTH_SECRET untouched',
      actual: {
        changed: result.changed,
        hasRecipientHashLine: result.content.includes(
          `RECIPIENT_HASH_SECRET=${marker}\n`,
        ),
        keepsBetterAuthSecret: result.content.includes(
          'BETTER_AUTH_SECRET=existing\n',
        ),
      },
      expected: {
        changed: true,
        hasRecipientHashLine: true,
        keepsBetterAuthSecret: true,
      },
    });
  });

  test('preserves an existing named variable without invoking the generator', () => {
    let generateCalls = 0;
    const content = 'RECIPIENT_HASH_SECRET=existing\n';
    const result = provisionAuthSecret(content, {
      generate: () => {
        generateCalls += 1;
        return marker;
      },
      variableName: 'RECIPIENT_HASH_SECRET',
    });
    assert({
      given: 'a .env with an existing RECIPIENT_HASH_SECRET value',
      should: 'preserve the file and never generate',
      actual: { changed: result.changed, generateCalls },
      expected: { changed: false, generateCalls: 0 },
    });
  });

  test('the real generator emits 64 hexadecimal characters', () => {
    const secret = generateAuthSecret();
    assert({
      given: 'the cryptographic generator',
      should: 'emit 64 hex characters from 32 random bytes',
      actual: /^[0-9a-f]{64}$/.test(secret),
      expected: true,
    });
    expect(() => provisionAuthSecret('', { generate: () => 'short' })).toThrow(
      'Generated auth secret must be 64 non-whitespace characters',
    );
  });
});

describe('provisionAuthEnv (the main() loop)', () => {
  test('provisions every real PROVISIONED_VARIABLES entry, not just the first', async () => {
    // No `variables` override: this exercises the real, default list, so
    // dropping RECIPIENT_HASH_SECRET from PROVISIONED_VARIABLES (as it once
    // was) fails this test, not just typecheck or a hand-picked variable.
    let written = '';
    let generateCalls = 0;
    const result = await provisionAuthEnv({
      content: '',
      write: async (content) => {
        written = content;
      },
      generate: () => {
        generateCalls += 1;
        return `${'m'.repeat(63)}${generateCalls}`;
      },
      log: () => {},
    });
    assert({
      given: 'an empty .env and the real PROVISIONED_VARIABLES list',
      should:
        'generate and write a distinct value for every provisioned variable',
      actual: {
        changedAny: result.changedAny,
        hasBetterAuthSecret: /^BETTER_AUTH_SECRET=\S{64}$/m.test(written),
        hasRecipientHashSecret: /^RECIPIENT_HASH_SECRET=\S{64}$/m.test(written),
        generateCalls,
      },
      expected: {
        changedAny: true,
        hasBetterAuthSecret: true,
        hasRecipientHashSecret: true,
        generateCalls: 2,
      },
    });
  });

  test('never prints the generated secret (ISSUE-167)', async () => {
    const secrets: string[] = [];
    let generateCalls = 0;
    const messages: string[] = [];
    await provisionAuthEnv({
      content: '',
      write: async () => {},
      generate: () => {
        generateCalls += 1;
        const secret = `${'s'.repeat(63)}${generateCalls}`;
        secrets.push(secret);
        return secret;
      },
      log: (message) => messages.push(message),
    });
    assert({
      given:
        'a real provisioning run that generates two secrets and logs one line per variable',
      should:
        'name the variable and whether it changed, never the secret value itself, in any logged line',
      actual: {
        loggedLines: messages.length,
        anyLineLeaksASecret: messages.some((message) =>
          secrets.some((secret) => message.includes(secret)),
        ),
      },
      expected: { loggedLines: 2, anyLineLeaksASecret: false },
    });
  });

  test('never writes when every provisioned variable already has a value', async () => {
    let writeCalls = 0;
    const content =
      'BETTER_AUTH_SECRET=existing1\nRECIPIENT_HASH_SECRET=existing2\n';
    const result = await provisionAuthEnv({
      content,
      write: async () => {
        writeCalls += 1;
      },
      generate: () => marker,
      log: () => {},
    });
    assert({
      given: 'a .env where every provisioned variable already has a value',
      should: 'report no change and never write',
      actual: {
        changedAny: result.changedAny,
        content: result.content,
        writeCalls,
      },
      expected: { changedAny: false, content, writeCalls: 0 },
    });
  });
});
