import { assert, setupRitewayBun, test } from 'riteway/bun';
import {
  EXPECTED_SINGLE_H1_PAGE_SHAPE,
  singleH1PageShape,
} from './confirm-page.test-support';
import { renderEmailConfirmPage } from './confirm-email-page';

setupRitewayBun();

const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString(
  'base64',
);

const request = () =>
  new Request('https://offense-demo.invalid/auth/confirm-email', {
    headers: { 'x-nonce': nonce },
  });

const token = 'a'.repeat(43);

test('renderEmailConfirmPage: the confirm state is single-h1, script- and asset-free, token hidden once', async () => {
  const html = await renderEmailConfirmPage(
    { kind: 'confirm', token },
    request(),
  ).text();
  assert({
    given: 'the confirm state',
    should:
      'render exactly one <main>, one <h1>, the token exactly once as a hidden value, and nothing loadable',
    actual: singleH1PageShape(html, token),
    expected: EXPECTED_SINGLE_H1_PAGE_SHAPE,
  });
});

test('renderEmailConfirmPage: the incomplete state carries its warning with role="alert"', async () => {
  const html = await renderEmailConfirmPage(
    { kind: 'incomplete', callbackURL: '/settings/security' },
    request(),
  ).text();
  assert({
    given: 'the incomplete-cleanup state',
    should: 'render its warning inside a role="alert" element',
    actual: /role="alert"/.test(html),
    expected: true,
  });
});

test('renderEmailConfirmPage: an untrusted callbackURL is escaped, not injected', async () => {
  const html = await renderEmailConfirmPage(
    { kind: 'incomplete', callbackURL: '"><script>alert(1)</script>' },
    request(),
  ).text();
  assert({
    given: 'a callbackURL carrying HTML metacharacters',
    should: 'escape it, never inject markup',
    actual: html.includes('<script>alert(1)</script>'),
    expected: false,
  });
});
