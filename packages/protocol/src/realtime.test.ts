import { expect } from 'bun:test';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { cursorSchema, heartbeatMs } from './realtime';
import {
  buildRoomTopic,
  buildUserInboxTopic,
  parseTopic,
  topicStringSchema,
} from './topics';
import { parseOutcome } from './parse-outcome.test-support';

setupRitewayBun();

const id = 'k2v9x0f4m8q3w1z7c5n6b4d2';

describe('heartbeat period constant (ADR 0031 §7)', () => {
  test('names the value the client heartbeat sends on', () => {
    assert({
      given: 'the protocol module',
      should: 'export the 15 s heartbeat period',
      actual: heartbeatMs,
      expected: 15_000,
    });
  });
});

describe('topic grammar', () => {
  test('parses every topic family, and the inbox builder round-trips', () => {
    assert({
      given: 'a user id',
      should: 'build the inbox topic',
      actual: buildUserInboxTopic(id),
      expected: `user:${id}:inbox`,
    });
    assert({
      given: 'a topic of every family',
      should: 'parse to the matching family and ids',
      actual: [
        parseTopic(`room:${id}`),
        parseTopic(`room:${id}:presence`),
        parseTopic(`room:${id}:chat`),
        parseTopic(buildUserInboxTopic(id)),
      ],
      expected: [
        { family: 'room', roomId: id },
        { family: 'room:presence', roomId: id },
        { family: 'room:chat', roomId: id },
        { family: 'user:inbox', userId: id },
      ],
    });
  });

  test('rejects non-cuid2 segments and unknown shapes', () => {
    const rejected = [
      'room:not-a-cuid2',
      'room:0f0e6d1c-2b3a-4455-9a8b-7c6d5e4f3a21',
      `room:${id}:unknown-suffix`,
      `user:${id}`,
      `user:${id}:outbox`,
      'user:not-a-cuid2:inbox',
      `inbox:${id}`,
      `presence:${id}`,
      `room:${id}:inbox`,
      'room:',
      '',
      `room:${id}:presence:extra`,
    ];
    assert({
      given: 'topic strings with bad ids or unrecognized shapes',
      should: 'return undefined for every one',
      actual: rejected.map((topic) => parseTopic(topic)),
      expected: rejected.map(() => undefined),
    });
  });

  test('the builder throws on a non-cuid2 segment instead of building a bad topic', () => {
    expect(() => buildUserInboxTopic('not-a-cuid2')).toThrow(
      'Invalid string: must match pattern',
    );
  });

  test('the room topic builder round-trips through the parser and throws on a non-cuid2 segment', () => {
    assert({
      given: 'a room id',
      should: 'build a topic the parser accepts back as the room family',
      actual: parseTopic(buildRoomTopic(id)),
      expected: { family: 'room', roomId: id },
    });
    expect(() => buildRoomTopic('not-a-cuid2')).toThrow(
      'Invalid string: must match pattern',
    );
  });

  test('bounds the topic string length', () => {
    const oversizedTopic = `room:${'a'.repeat(200)}`;
    assert({
      given: 'a topic string far longer than any real topic',
      should:
        'fail the length bound alone: the shape refinement never parses an oversized string',
      actual: topicStringSchema
        .safeParse(oversizedTopic)
        .error?.issues.map((issue) => issue.code),
      expected: ['too_big'],
    });
  });
});

describe('the since cursor', () => {
  test('accepts a well-formed txid:seq cursor at the 20-digit bound', () => {
    const twentyDigits = '1'.repeat(20);
    assert({
      given: 'a cursor with each part at the 20-digit bound',
      should: 'accept it',
      actual: parseOutcome(cursorSchema, `${twentyDigits}:${twentyDigits}`),
      expected: { data: `${twentyDigits}:${twentyDigits}` },
    });
  });

  test('rejects a cursor with a part over 20 digits, or a non-canonical leading zero', () => {
    const twentyOneDigits = '1'.repeat(21);
    assert({
      given:
        'a cursor with a part past the 20-digit bound, and one with a leading zero',
      should: 'reject both',
      actual: [
        parseOutcome(cursorSchema, `${twentyOneDigits}:1`),
        parseOutcome(cursorSchema, '01:1'),
      ],
      expected: [{ issues: ['(root)'] }, { issues: ['(root)'] }],
    });
  });
});
