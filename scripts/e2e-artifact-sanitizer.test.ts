import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { redactText, sanitizeArtifactTree } from './e2e-artifact-sanitizer';

setupRitewayBun();

describe('e2e artifact sanitizer', () => {
  test('redacts a token query parameter', () => {
    assert({
      given: 'a captured URL with a live magic-link token',
      should: 'replace the token value',
      actual: redactText(
        'GET https://localhost:3101/auth/confirm?token=abc123.def',
      ),
      expected: 'GET https://localhost:3101/auth/confirm?token=[REDACTED]',
    });
  });

  test('redacts a Set-Cookie header line', () => {
    assert({
      given: 'a trace line carrying a session cookie',
      should: 'redact the whole header value',
      actual: redactText(
        'set-cookie: __Secure-offense-demo.session_token=abcdef; Path=/; HttpOnly',
      ),
      expected: 'set-cookie: [REDACTED]',
    });
  });

  test('redacts the e2e placeholder secret', () => {
    assert({
      given:
        'the inert BETTER_AUTH_SECRET placeholder from playwright.config.ts',
      should: 'redact it like any other secret shape',
      actual: redactText(
        'BETTER_AUTH_SECRET=e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0',
      ),
      expected: 'BETTER_AUTH_SECRET=[REDACTED]',
    });
  });

  test('redacts the e2e placeholder recipient-hash secret', () => {
    assert({
      given:
        'the inert RECIPIENT_HASH_SECRET placeholder from playwright.config.ts',
      should: 'redact it like any other secret shape',
      actual: redactText(
        'RECIPIENT_HASH_SECRET=a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2',
      ),
      expected: 'RECIPIENT_HASH_SECRET=[REDACTED]',
    });
  });

  test('redacts a PEM private key, whatever its type (ISSUE-78)', () => {
    const key = (type: string) =>
      `-----BEGIN ${type}PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nBKcwggSjAgEAAoIBAQC7\n-----END ${type}PRIVATE KEY-----`;
    assert({
      given:
        'the TLS edge key (PKCS#8), an RSA and an EC key, and a certificate beside one',
      should: 'redact every key block and leave the certificate',
      actual: redactText(
        [
          key(''),
          key('RSA '),
          key('EC '),
          '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
        ].join('\n'),
      ),
      expected: [
        '[REDACTED PRIVATE KEY]',
        '[REDACTED PRIVATE KEY]',
        '[REDACTED PRIVATE KEY]',
        '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
      ].join('\n'),
    });
  });

  test('redacts a key.pem left in an artifact tree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'offense-demo-e2e-sanitize-pem-'));
    try {
      mkdirSync(join(root, 'e2e-tls-3101'));
      writeFileSync(
        join(root, 'e2e-tls-3101', 'key.pem'),
        '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n',
      );
      const result = sanitizeArtifactTree(root);
      assert({
        given: 'a run that left the TLS edge key under test-results',
        should: 'publish no private key material',
        actual: {
          result,
          key: await Bun.file(join(root, 'e2e-tls-3101', 'key.pem')).text(),
        },
        expected: {
          result: { scanned: 1, redacted: 1 },
          key: '[REDACTED PRIVATE KEY]\n',
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('leaves ordinary text untouched', () => {
    assert({
      given: 'a line with none of the sensitive shapes',
      should: 'return it unchanged',
      actual: redactText('GET /lobby 200 in 12ms'),
      expected: 'GET /lobby 200 in 12ms',
    });
  });

  /** A zip at `zipPath` holding one trace entry with `content`. */
  const writeTraceZip = (zipPath: string, content: string) => {
    const source = mkdtempSync(
      join(tmpdir(), 'offense-demo-e2e-sanitize-src-'),
    );
    try {
      writeFileSync(join(source, '0-trace.network'), content);
      Bun.spawnSync(['zip', '-qr', zipPath, '.'], { cwd: source });
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  };

  const readTraceEntry = async (zipPath: string) => {
    const extractDir = mkdtempSync(
      join(tmpdir(), 'offense-demo-e2e-sanitize-check-'),
    );
    try {
      Bun.spawnSync(['unzip', '-qq', '-o', zipPath, '-d', extractDir]);
      return await Bun.file(join(extractDir, '0-trace.network')).text();
    } finally {
      rmSync(extractDir, { recursive: true, force: true });
    }
  };

  test('rewrites a trace zip found under a relative artifact path', async () => {
    const checkout = mkdtempSync(
      join(tmpdir(), 'offense-demo-e2e-sanitize-relative-'),
    );
    const previous = process.cwd();
    try {
      mkdirSync(join(checkout, 'test-results'));
      writeTraceZip(
        join(checkout, 'test-results', 'trace.zip'),
        'authorization: Bearer live-secret-token-value',
      );

      // CI runs from the checkout and passes `apps/web/test-results`.
      process.chdir(checkout);
      const result = sanitizeArtifactTree('test-results');
      process.chdir(previous);

      assert({
        given: 'a trace zip that needs redaction, reached by a relative path',
        should: 'rewrite it in place with the redacted contents',
        actual: {
          result,
          traceText: await readTraceEntry(
            join(checkout, 'test-results', 'trace.zip'),
          ),
        },
        expected: {
          result: { scanned: 1, redacted: 1 },
          traceText: 'authorization: [REDACTED]',
        },
      });
    } finally {
      process.chdir(previous);
      rmSync(checkout, { recursive: true, force: true });
    }
  });

  test('refuses to publish a zip it cannot write back', async () => {
    const root = mkdtempSync(
      join(tmpdir(), 'offense-demo-e2e-sanitize-readonly-'),
    );
    const zipPath = join(root, 'trace.zip');
    try {
      writeTraceZip(zipPath, 'authorization: Bearer live-secret-token-value');
      chmodSync(root, 0o555);
      let threw = false;
      try {
        sanitizeArtifactTree(root);
      } catch {
        threw = true;
      }
      assert({
        given: 'a trace zip needing redaction whose directory is read-only',
        should: 'throw rather than report the archive as sanitized',
        actual: threw,
        expected: true,
      });
    } finally {
      chmodSync(root, 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('sanitizes a text artifact and a trace zip in place', async () => {
    const root = mkdtempSync(join(tmpdir(), 'offense-demo-e2e-sanitize-tree-'));
    try {
      writeFileSync(
        join(root, 'server.log'),
        'request completed token=live-secret-token-value',
      );
      const zipSource = mkdtempSync(
        join(tmpdir(), 'offense-demo-e2e-sanitize-src-'),
      );
      writeFileSync(
        join(zipSource, '0-trace.network'),
        'authorization: Bearer live-secret-token-value',
      );
      Bun.spawnSync(['zip', '-qr', join(root, 'trace.zip'), '.'], {
        cwd: zipSource,
      });
      rmSync(zipSource, { recursive: true, force: true });

      const { scanned, redacted } = sanitizeArtifactTree(root);

      const serverLog = await Bun.file(join(root, 'server.log')).text();
      const extractDir = mkdtempSync(
        join(tmpdir(), 'offense-demo-e2e-sanitize-check-'),
      );
      Bun.spawnSync([
        'unzip',
        '-qq',
        '-o',
        join(root, 'trace.zip'),
        '-d',
        extractDir,
      ]);
      const traceText = await Bun.file(
        join(extractDir, '0-trace.network'),
      ).text();

      assert({
        given:
          'a tree with a plain log file and a trace zip, both carrying secrets',
        should: 'scan both entries and redact both',
        actual: { scanned, redacted, serverLog, traceText },
        expected: {
          scanned: 2,
          redacted: 2,
          serverLog: 'request completed token=[REDACTED]',
          traceText: 'authorization: [REDACTED]',
        },
      });
      rmSync(extractDir, { recursive: true, force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses to publish a zip it cannot extract and scan', () => {
    const root = mkdtempSync(
      join(tmpdir(), 'offense-demo-e2e-sanitize-corrupt-'),
    );
    try {
      // Not a real zip: unzip will refuse it, and that must block
      // publication rather than pass through as "nothing to redact".
      writeFileSync(join(root, 'trace.zip'), 'not actually a zip archive');
      let threw = false;
      try {
        sanitizeArtifactTree(root);
      } catch {
        threw = true;
      }
      assert({
        given: 'a retained archive that cannot be extracted for scanning',
        should: 'throw instead of silently reporting it as already clean',
        actual: threw,
        expected: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reports zero scanned for a directory that does not exist', () => {
    const missing = join(
      tmpdir(),
      'offense-demo-e2e-sanitize-missing-does-not-exist',
    );
    rmSync(missing, { recursive: true, force: true });
    assert({
      given: 'no test-results directory (a run that produced no artifacts)',
      should: 'report zero scanned instead of throwing',
      actual: sanitizeArtifactTree(missing),
      expected: { scanned: 0, redacted: 0 },
    });
  });
});
