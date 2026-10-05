import { expect } from 'bun:test';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  mainAppPort,
  parsePortBlockComment,
  pickPortBlock,
  portBlockComment,
  portBlockPorts,
  slotPorts,
} from './slot-ports';

setupRitewayBun();

describe('port blocks', () => {
  test('keeps an existing claim and otherwise takes the lowest free block', () => {
    assert({
      given: 'claims by other slots and one busy block',
      should: 'reuse the own claim, else skip claimed and busy blocks',
      actual: [
        pickPortBlock({ own: 7, claimed: [1, 2], isFree: () => false }),
        pickPortBlock({ claimed: [1, 2], isFree: (block) => block !== 3 }),
      ],
      expected: [7, 4],
    });
  });

  test('round-trips the claim stored on the slot database', () => {
    assert({
      given: 'a port block comment and foreign comments',
      should: 'parse only the exact claim format',
      actual: [
        parsePortBlockComment(portBlockComment(12)),
        parsePortBlockComment('offense-demo-slot port-block=12; drop'),
        parsePortBlockComment(null),
      ],
      expected: [12, undefined, undefined],
    });
    expect(() => portBlockComment(0)).toThrow(/port block/);
  });

  test("reserves the app, its three web e2e ports and realtime's e2e and dev ports", () => {
    assert({
      given: 'port block 2',
      should: 'list all six ports slotEnvValues can hand out for that block',
      actual: portBlockPorts(2),
      expected: [13020, 13021, 13022, 13023, 13024, 13025],
    });
  });
});

describe('main checkout app port', () => {
  test('defaults and an override', () => {
    assert({
      given: 'no override, then OFFENSE_DEMO_APP_PORT=3020',
      should: 'use 3000/3100/3011, then move app, e2e and realtime together',
      actual: [
        slotPorts('main', undefined, mainAppPort(undefined)),
        slotPorts('main', undefined, mainAppPort('3020')),
      ],
      expected: [
        { app: 3000, e2e: 3100, realtime: 3011 },
        { app: 3020, e2e: 3120, realtime: 3031 },
      ],
    });
  });

  test('refuses a port the browser suite range cannot fit', () => {
    expect(() => mainAppPort('65500')).toThrow(
      'OFFENSE_DEMO_APP_PORT must be a port number (1024-65432), got "65500"',
    );
    expect(() => mainAppPort('abc')).toThrow(
      'OFFENSE_DEMO_APP_PORT must be a port number (1024-65432), got "abc"',
    );
  });
});
