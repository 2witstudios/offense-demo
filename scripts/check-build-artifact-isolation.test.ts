import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  artifactTextIssues,
  checkBuildArtifactIsolation,
  clientBundleSecretIssues,
  routeManifestIssues,
} from './check-build-artifact-isolation';

setupRitewayBun();

describe('build artifact isolation gate', () => {
  test('flags a forbidden marker compiled into a served file', () => {
    assert({
      given: 'a server chunk that references the e2e wrapper module',
      should: 'report the marker',
      actual: artifactTextIssues(
        'server/app/api/auth/route.js',
        'require("../../../../e2e/support/server")',
      ).length,
      expected: 1,
    });
  });

  test('reports nothing for ordinary compiled output', () => {
    assert({
      given: 'a server chunk with no e2e markers',
      should: 'report nothing',
      actual: artifactTextIssues(
        'server/app/page.js',
        'module.exports = { render: () => null }',
      ),
      expected: [],
    });
  });

  test('flags the mail-capture and reset paths in a route manifest', () => {
    assert({
      given: 'a routes manifest that declares /mails and /reset',
      should: 'report both as forbidden',
      actual: routeManifestIssues(
        JSON.stringify({ '/mails/route': '/mails', '/reset/route': '/reset' }),
      ).length,
      expected: 2,
    });
  });

  test('reports nothing for the real production route set', () => {
    assert({
      given: 'a routes manifest with only production routes',
      should: 'report nothing',
      actual: routeManifestIssues(
        JSON.stringify({
          '/api/auth/[...all]/route': '/api/auth/[...all]',
          '/api/health/live/route': '/api/health/live',
        }),
      ),
      expected: [],
    });
  });

  test('throws when the build directory does not exist', async () => {
    const missing = join(tmpdir(), 'offense-demo-e2e-isolation-missing');
    rmSync(missing, { recursive: true, force: true });
    let threw = false;
    try {
      await checkBuildArtifactIsolation(missing);
    } catch {
      threw = true;
    }
    assert({
      given: 'a build directory that was never built',
      should: 'throw instead of silently passing',
      actual: threw,
      expected: true,
    });
  });

  test('positive control: a fixture build carrying the e2e wrapper fails the gate', async () => {
    const fixture = mkdtempSync(
      join(tmpdir(), 'offense-demo-e2e-isolation-dirty-'),
    );
    try {
      writeFileSync(
        join(fixture, 'app-path-routes-manifest.json'),
        JSON.stringify({ '/mails/route': '/mails' }),
      );
      writeFileSync(
        join(fixture, 'server.js'),
        'import("../../e2e/support/server");',
      );
      const issues = await checkBuildArtifactIsolation(fixture);
      assert({
        given: 'a fixture artifact that leaked the e2e wrapper and its route',
        should: 'report both issues',
        actual: issues.length,
        expected: 2,
      });
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test('negative control: a clean fixture build passes the gate', async () => {
    const fixture = mkdtempSync(
      join(tmpdir(), 'offense-demo-e2e-isolation-clean-'),
    );
    try {
      writeFileSync(
        join(fixture, 'app-path-routes-manifest.json'),
        JSON.stringify({ '/page': '/' }),
      );
      writeFileSync(join(fixture, 'server.js'), 'module.exports = {};');
      const issues = await checkBuildArtifactIsolation(fixture);
      assert({
        given: 'a fixture artifact with no e2e-only surface',
        should: 'report nothing',
        actual: issues,
        expected: [],
      });
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  describe('AUTH-6.3 client-bundle secret scan', () => {
    test('flags a secret value compiled into a client-shipped static file', () => {
      assert({
        given: 'a static/ chunk that embeds a server-only secret value',
        should: 'report the leak',
        actual: clientBundleSecretIssues(
          'static/chunks/app/layout.js',
          'const x = "sk_live_super_secret_value";',
          ['sk_live_super_secret_value'],
        ).length,
        expected: 1,
      });
    });

    test('ignores the same value outside static/ (server chunks legitimately read config)', () => {
      assert({
        given: 'a server chunk that references the secret value',
        should: 'report nothing, since it is never shipped to the browser',
        actual: clientBundleSecretIssues(
          'server/chunks/config.js',
          'const x = "sk_live_super_secret_value";',
          ['sk_live_super_secret_value'],
        ),
        expected: [],
      });
    });

    test('reports nothing for a clean static file or an unset secret', () => {
      assert({
        given: 'a static file with no secret text, and an empty secret value',
        should: 'report nothing',
        actual: [
          ...clientBundleSecretIssues(
            'static/chunks/app/layout.js',
            'const x = "totally ordinary";',
            ['sk_live_super_secret_value'],
          ),
          ...clientBundleSecretIssues('static/chunks/app/layout.js', 'secret', [
            '',
          ]),
        ],
        expected: [],
      });
    });

    test('positive control: checkBuildArtifactIsolation catches a secret leaked into static/', async () => {
      const fixture = mkdtempSync(
        join(tmpdir(), 'offense-demo-e2e-isolation-secret-leak-'),
      );
      try {
        mkdirSync(join(fixture, 'static'), { recursive: true });
        writeFileSync(
          join(fixture, 'static', 'bundle.js'),
          'const secret = "whsec_test_leaked_value";',
        );
        const issues = await checkBuildArtifactIsolation(fixture, [
          'whsec_test_leaked_value',
        ]);
        assert({
          given: 'a fixture build whose static/ bundle embeds a secret value',
          should: 'report the client-bundle secret leak',
          actual: issues.length,
          expected: 1,
        });
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    });

    test('negative control: the same fixture passes once the secret is absent', async () => {
      const fixture = mkdtempSync(
        join(tmpdir(), 'offense-demo-e2e-isolation-secret-clean-'),
      );
      try {
        mkdirSync(join(fixture, 'static'), { recursive: true });
        writeFileSync(
          join(fixture, 'static', 'bundle.js'),
          'const secret = "ordinary-public-value";',
        );
        const issues = await checkBuildArtifactIsolation(fixture, [
          'whsec_test_leaked_value',
        ]);
        assert({
          given: 'a fixture build whose static/ bundle never embeds the secret',
          should: 'report nothing',
          actual: issues,
          expected: [],
        });
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    });
  });
});
