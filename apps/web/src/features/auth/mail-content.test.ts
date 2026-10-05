import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { create, magicLinkRequest } from './abuse.test-support';

setupRitewayBun();

const linkOf = (text: string) => text.match(/https?:\/\/\S+/)?.[0] ?? '';
const hrefOf = (html: string) => html.match(/href="([^"]+)"/)?.[1] ?? '';

describe('AUTH-3.6 message rendering', () => {
  test('text and HTML parts carry the same link, HTML-escaped, with a plain-language expiry notice', async () => {
    const { server, sent } = create();
    await server.instance.handler(
      magicLinkRequest(
        { 'x-offense-demo-client-ip': '198.51.100.9' },
        'p@offense-demo.example.com',
      ),
    );
    const { text = '', html = '', subject } = sent[0] ?? {};
    const htmlLink = hrefOf(html);
    assert({
      given: 'the delivered message',
      should:
        'render the identical link in both parts (ampersands escaped in HTML) and state the 5-minute single-use rule',
      actual: {
        same: htmlLink.replaceAll('&amp;', '&') === linkOf(text),
        escaped: htmlLink.includes('&amp;') || !htmlLink.includes('&'),
        textNotice: /5 minutes/.test(text),
        htmlNotice: /5 minutes/.test(html),
        subject,
      },
      expected: {
        same: true,
        escaped: true,
        textNotice: true,
        htmlNotice: true,
        subject: 'Sign in to Offense Demo',
      },
    });
  });
});
