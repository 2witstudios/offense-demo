import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  alreadySetUp,
  appJwt,
  appName,
  appSlug,
  buildManifest,
  manifestFormUrl,
  manifestPage,
  nameProblem,
  ownerType,
  parseCallback,
  parseConversion,
  reviewAppSteps,
  rulesetDecision,
  secretSetArgs,
} from './github-review-app-plan';

setupRitewayBun();

const root = new URL('..', import.meta.url).pathname;

describe('buildManifest', () => {
  const manifest = buildManifest({
    repository: 'octo/widget',
    name: 'widget-review-record',
    port: 4567,
  });

  test('permissions', () => {
    assert({
      given: 'the review-record App manifest',
      should:
        'grant exactly statuses:write, pull_requests:read, issues:read and metadata:read',
      actual: manifest.default_permissions,
      expected: {
        statuses: 'write',
        pull_requests: 'read',
        issues: 'read',
        metadata: 'read',
      },
    });
  });

  test('the token the workflow mints asks for the same permissions', async () => {
    const workflow = await Bun.file(
      `${root}.github/workflows/review-record.yml`,
    ).text();
    const minted = Object.fromEntries(
      [...workflow.matchAll(/permission-([a-z-]+): (read|write)/g)].map(
        (match) => [(match[1] ?? '').replaceAll('-', '_'), match[2]],
      ),
    );
    const requested = Object.fromEntries(
      Object.entries(manifest.default_permissions).filter(
        ([key]) => key !== 'metadata',
      ),
    );
    assert({
      given: 'the permission-* inputs review-record.yml mints the token with',
      should: 'match the manifest permissions (metadata is implicit)',
      actual: minted,
      expected: requested,
    });
  });

  test('everything else', () => {
    assert({
      given: 'a repository and a callback port',
      should:
        'be private, have no active webhook and no events, and redirect to the loopback callback',
      actual: {
        name: manifest.name,
        url: manifest.url,
        hook: manifest.hook_attributes,
        redirect: manifest.redirect_url,
        public: manifest.public,
        events: manifest.default_events,
      },
      expected: {
        name: 'widget-review-record',
        url: 'https://github.com/octo/widget',
        hook: { url: 'https://github.com/octo/widget', active: false },
        redirect: 'http://127.0.0.1:4567/callback',
        public: false,
        events: [],
      },
    });
  });
});

describe('appName', () => {
  test('length and shape', () => {
    const long = appName('northwind-logistics-portal-extra');
    assert({
      given: 'a short repository name, a long one, and a tag',
      should:
        'append -review-record, stay within 34 characters and never end the base in a hyphen',
      actual: [
        appName('widget'),
        long,
        long.length <= 34,
        appName('widget', 'a1b2'),
        appName('northwind-logistics-portal-extra', 'a1b2').length <= 34,
      ],
      expected: [
        'widget-review-record',
        'northwind-logistics-review-record',
        true,
        'widget-a1b2-review-record',
        true,
      ],
    });
  });

  test('nameProblem and appSlug', () => {
    assert({
      given: 'names that are fine, too long and symbol-only',
      should: 'accept the first and explain the others; slug lowercases',
      actual: [
        nameProblem('Widget Gate'),
        nameProblem('x'.repeat(35)),
        nameProblem('!!!'),
        appSlug('Widget Gate'),
      ],
      expected: [
        null,
        'must be 1 to 34 characters',
        'needs at least one letter or digit',
        'widget-gate',
      ],
    });
  });
});

describe('manifestFormUrl', () => {
  test('user and organization', () => {
    assert({
      given: 'a user owner and an organization owner',
      should:
        "post to the user's App settings or the organization's, with the state",
      actual: [
        manifestFormUrl('octo', 'User', 's1'),
        manifestFormUrl('offense-demo-org', 'Organization', 's1'),
        ownerType(0, 'Organization\n'),
        ownerType(0, 'User\n'),
        ownerType(1, ''),
      ],
      expected: [
        'https://github.com/settings/apps/new?state=s1',
        'https://github.com/organizations/offense-demo-org/settings/apps/new?state=s1',
        'Organization',
        'User',
        null,
      ],
    });
  });

  test('manifestPage escapes the manifest into an auto-submitting form', () => {
    const manifest = buildManifest({
      repository: 'octo/widget',
      name: 'a"<b>',
      port: 1,
    });
    const page = manifestPage(
      'https://github.com/settings/apps/new?state=s&x=1',
      manifest,
    );
    const value = /name="manifest" value="([^"]*)"/.exec(page)?.[1] ?? '';
    const decoded = value
      .replaceAll('&quot;', '"')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&amp;', '&');
    assert({
      given: 'a manifest whose name holds quotes and angle brackets',
      should: 'submit on load and round-trip the manifest JSON exactly',
      actual: [
        page.includes('onload="document.forms[0].submit()"'),
        page.includes(
          'action="https://github.com/settings/apps/new?state=s&amp;x=1"',
        ),
        page.includes('<b>'),
        JSON.parse(decoded),
      ],
      expected: [true, true, false, manifest],
    });
  });
});

describe('parseCallback', () => {
  const at = (path: string) => new URL(path, 'http://127.0.0.1:4567');

  test('state verification', () => {
    assert({
      given:
        'the right state, a wrong one, a missing one, no code and another path',
      should: 'return the code only for the right state on /callback',
      actual: [
        parseCallback(at('/callback?code=abc123&state=s1'), 's1'),
        parseCallback(at('/callback?code=abc123&state=evil'), 's1'),
        parseCallback(at('/callback?code=abc123'), 's1'),
        parseCallback(at('/callback?state=s1'), 's1'),
        parseCallback(at('/other?code=abc123&state=s1'), 's1'),
      ],
      expected: [
        { code: 'abc123' },
        { error: 'the state does not match this setup run' },
        { error: 'the state does not match this setup run' },
        { error: 'GitHub sent no usable code' },
        { error: 'not the callback path' },
      ],
    });
  });
});

describe('appJwt', () => {
  test('RS256 signed by the App key', () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const jwt = appJwt(42, privateKey, 1_700_000_000);
    const [header = '', payload = '', signature = ''] = jwt.split('.');
    const decode = (part: string) =>
      JSON.parse(Buffer.from(part, 'base64url').toString()) as unknown;
    assert({
      given: 'an App id, its PKCS#1 key and a clock',
      should:
        'carry an RS256 header, iss and a 60 s back-dated, 9 min window, and verify with the derived public key',
      actual: [
        decode(header),
        decode(payload),
        verify(
          'sha256',
          Buffer.from(`${header}.${payload}`),
          createPublicKey(privateKey),
          Buffer.from(signature, 'base64url'),
        ),
      ],
      expected: [
        { alg: 'RS256', typ: 'JWT' },
        { iat: 1_699_999_940, exp: 1_700_000_540, iss: '42' },
        true,
      ],
    });
  });
});

describe('parseConversion', () => {
  const PEM =
    '-----BEGIN RSA PRIVATE KEY-----\nSECRET\n-----END RSA PRIVATE KEY-----\n';

  test('valid and invalid bodies', () => {
    const failure = (stdout: string) => {
      try {
        parseConversion(stdout);
        return 'parsed';
      } catch (error) {
        return (error as Error).message;
      }
    };
    const partial = failure(JSON.stringify({ id: 1, pem: PEM }));
    assert({
      given: 'a full conversion response, a partial one and non-JSON',
      should: 'return the fields, and fail without ever quoting the key',
      actual: [
        parseConversion(
          JSON.stringify({
            id: 7,
            slug: 'w-rr',
            pem: PEM,
            html_url: 'https://github.com/apps/w-rr',
            client_secret: 'x',
          }),
        ),
        partial.includes('SECRET'),
        failure('nope'),
      ],
      expected: [
        {
          id: 7,
          slug: 'w-rr',
          pem: PEM,
          htmlUrl: 'https://github.com/apps/w-rr',
        },
        false,
        'GitHub answered the manifest conversion with non-JSON',
      ],
    });
  });
});

describe('decisions', () => {
  test('alreadySetUp, rulesetDecision and secretSetArgs', () => {
    assert({
      given: 'the stored state, visibility and plan, and the secret command',
      should:
        'skip only when both are stored, apply unless private on free, and keep the key out of argv',
      actual: [
        alreadySetUp({ variable: true, secret: true }),
        alreadySetUp({ variable: false, secret: true }),
        alreadySetUp({ variable: true, secret: false }),
        rulesetDecision('public', 'free'),
        rulesetDecision('private', 'free'),
        rulesetDecision('private', 'pro'),
        rulesetDecision('private', null),
        secretSetArgs('octo/widget', true),
      ],
      expected: [
        true,
        false,
        false,
        'apply',
        'unavailable',
        'apply',
        'apply',
        [
          'secret',
          'set',
          'REVIEW_RECORD_APP_KEY',
          '--env',
          'review-record',
          '-R',
          'octo/widget',
        ],
      ],
    });
  });

  test('reviewAppSteps', () => {
    const steps = reviewAppSteps({
      repository: 'octo/widget',
      name: 'widget-review-record',
      formUrl: 'https://github.com/settings/apps/new',
    });
    assert({
      given: 'a repository and an App name',
      should:
        'list the two clicks, the stores, the poll and the ruleset step in order',
      actual: [
        steps.length,
        steps.filter((step) => /click [12] of 2/.test(step)).length,
        steps.some((step) => step.includes('installations/new')),
        steps.at(-1)?.startsWith('$ bun github:rules --apply'),
      ],
      expected: [10, 2, true, true],
    });
  });
});
