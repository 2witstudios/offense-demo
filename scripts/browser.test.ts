import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { openerCommand } from './browser';

setupRitewayBun();

describe('openerCommand', () => {
  test('opener', () => {
    assert({
      given: 'each platform',
      should: 'use open, xdg-open or start',
      actual: ['darwin', 'linux', 'win32'].map(
        (platform) => openerCommand(platform, 'http://x')[0],
      ),
      expected: ['open', 'xdg-open', 'cmd'],
    });
  });
});
