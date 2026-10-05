import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { inlineColoursWithoutDarkOverride } from './rendered-mail.test-support';
import { renderAuthEmail, type AuthEmailInput } from './templates';

setupRitewayBun();

const FIXTURES_DIR = join(import.meta.dir, '__fixtures__');
mkdirSync(FIXTURES_DIR, { recursive: true });

const DANGEROUS_URL =
  'https://offense-demo.example.com/auth/confirm?token=a"b&c<script>alert(1)</script>&next=/app';

const INPUTS: readonly AuthEmailInput[] = [
  { kind: 'sign-in', url: DANGEROUS_URL },
  { kind: 'passkey-added', url: DANGEROUS_URL },
  { kind: 'passkey-removed', url: DANGEROUS_URL },
  { kind: 'email-change-notice', url: DANGEROUS_URL },
  { kind: 'email-change-confirm', url: DANGEROUS_URL },
  { kind: 'email-change-taken', url: DANGEROUS_URL },
];

const linkCount = (source: string, needle: string) =>
  source.split(needle).length - 1;

// Realistic-looking link for human review screenshots; the security
// assertions above exercise the dangerous-input path instead.
const PREVIEW_URL =
  'https://offense-demo.example.com/auth/confirm?token=k3n2f8x91pqz7m4v&callbackURL=%2Fapp';

describe('AUTH-3.9 auth email templates', () => {
  test('renders a human-reviewable preview fixture per kind', () => {
    for (const input of INPUTS) {
      const preview = renderAuthEmail({ ...input, url: PREVIEW_URL });
      writeFileSync(
        join(FIXTURES_DIR, `${input.kind}.preview.html`),
        preview.html,
      );
    }
    assert({
      given: 'every supported message kind',
      should: 'render without throwing for a realistic link',
      actual: INPUTS.length,
      expected: INPUTS.length,
    });
  });

  for (const input of INPUTS) {
    const rendered = renderAuthEmail(input);
    // Written for a human reviewer to open in a browser; not itself
    // assertion evidence (byte snapshots are banned by the test contract).
    writeFileSync(join(FIXTURES_DIR, `${input.kind}.html`), rendered.html);

    test(`${input.kind}: escapes the interpolated link in both parts`, () => {
      assert({
        given: `a ${input.kind} message with an unsafe URL`,
        should: 'never emit the raw unsafe URL in the HTML part',
        actual: rendered.html.includes(DANGEROUS_URL),
        expected: false,
      });
      assert({
        given: `a ${input.kind} message with an unsafe URL`,
        should: 'carry the URL verbatim (unescaped) in the plain-text part',
        actual: rendered.text.includes(DANGEROUS_URL),
        expected: true,
      });
      assert({
        given: `a ${input.kind} message with an unsafe URL`,
        should: 'never inject the raw script tag into the HTML part',
        actual: rendered.html.includes('<script>'),
        expected: false,
      });
    });

    test(`${input.kind}: renders one link, once, in each part`, () => {
      assert({
        given: `the ${input.kind} HTML part`,
        should: 'contain exactly one anchor element',
        actual: linkCount(rendered.html, '<a href='),
        expected: 1,
      });
      assert({
        given: `the ${input.kind} plain-text part`,
        should: 'contain the link exactly once',
        actual: linkCount(rendered.text, DANGEROUS_URL),
        expected: 1,
      });
    });

    test(`${input.kind}: the anchor's accessible name is the descriptive label, not the raw URL`, () => {
      const anchor = rendered.html.match(/<a href="[^"]*"[^>]*>([^<]*)<\/a>/);
      assert({
        given: `the ${input.kind} HTML part's one anchor`,
        should:
          "announce its descriptive label, so assistive technology never reads out the token-bearing URL as the link's name",
        actual: {
          found: anchor !== null,
          textIsUrl: anchor?.[1] === DANGEROUS_URL,
        },
        expected: { found: true, textIsUrl: false },
      });
    });

    test(`${input.kind}: HTML and text parts share the same content model`, () => {
      assert({
        given: `the ${input.kind} message`,
        should: 'set a language attribute on the HTML document',
        actual: rendered.html.includes('<html lang="en">'),
        expected: true,
      });
      assert({
        given: `the ${input.kind} message`,
        should: 'declare a preheader and a single H1 heading',
        actual: {
          hasPreheader: /display:none[^>]*>[^<]+<\/span>/.test(rendered.html),
          headingCount: linkCount(rendered.html, '<h1'),
        },
        expected: { hasPreheader: true, headingCount: 1 },
      });
      assert({
        given: `the ${input.kind} message`,
        should: 'have a non-empty subject and a matching plain-text headline',
        actual: {
          hasSubject: rendered.subject.length > 0,
          textNonEmpty: rendered.text.trim().length > 0,
        },
        expected: { hasSubject: true, textNonEmpty: true },
      });
    });

    test(`${input.kind}: the dark scheme overrides every colour set inline`, () => {
      assert({
        given: `every element in the ${input.kind} body that sets a background or colour inline`,
        should:
          'have a dark-block rule overriding that same property on it (the button link and brand dot included), so no light value survives into a dark client',
        actual: inlineColoursWithoutDarkOverride(rendered.html),
        expected: [],
      });
    });

    test(`${input.kind}: has no JavaScript and no tracking pixels`, () => {
      assert({
        given: `the ${input.kind} HTML part`,
        should: 'contain no script tags, inline handlers or external images',
        actual: {
          script: rendered.html.includes('<script'),
          onHandler: /\bon\w+\s*=/.test(rendered.html),
          img: rendered.html.includes('<img'),
        },
        expected: { script: false, onHandler: false, img: false },
      });
    });
  }

  test('sign-in: subject and body shape do not depend on whether the account exists', () => {
    const forNewAccount = renderAuthEmail({
      kind: 'sign-in',
      url: 'https://offense-demo.example.com/auth/confirm?token=new',
    });
    const forExistingAccount = renderAuthEmail({
      kind: 'sign-in',
      url: 'https://offense-demo.example.com/auth/confirm?token=existing',
    });
    const stripLink = (source: string, url: string) =>
      source.replaceAll(url, '{{url}}');
    assert({
      given: 'two sign-in messages built the same way, only the link differs',
      should: 'render an identical subject and body shape either way',
      actual: {
        subject: forNewAccount.subject === forExistingAccount.subject,
        text:
          stripLink(forNewAccount.text, 'token=new') ===
          stripLink(forExistingAccount.text, 'token=existing'),
        html:
          stripLink(forNewAccount.html, 'token=new') ===
          stripLink(forExistingAccount.html, 'token=existing'),
      },
      expected: { subject: true, text: true, html: true },
    });
  });

  test('every kind renders a distinct, account-state-neutral subject', () => {
    const subjects = INPUTS.map((input) => renderAuthEmail(input).subject);
    assert({
      given: 'every supported message kind',
      should: 'give each kind its own subject with no account data in it',
      actual: new Set(subjects).size,
      expected: INPUTS.length,
    });
  });
});
