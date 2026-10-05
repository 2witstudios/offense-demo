import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { assertRejects } from '@offense-demo/errors/testing';
import { readJson } from './http';

setupRitewayBun();

const jsonRequest = (body: string, contentType = 'application/json') =>
  new Request('http://localhost/api/account/username', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });

describe('readJson', () => {
  test('parses bounded JSON bodies', async () => {
    assert({
      given: 'a JSON request body',
      should: 'parse it into an object',
      actual: await readJson(jsonRequest('{"a":1}')),
      expected: { a: 1 },
    });
  });

  test('rejects non-JSON content types', async () => {
    await assertRejects({
      given: 'a form-encoded body',
      should: 'refuse with VALIDATION',
      actual: () =>
        readJson(jsonRequest('a=1', 'application/x-www-form-urlencoded')),
      code: 'VALIDATION',
    });
  });

  test('rejects bodies beyond the byte bound', async () => {
    const large = JSON.stringify({ text: 'x'.repeat(128) });
    await assertRejects({
      given: 'a 140-byte body against a 64-byte bound',
      should: 'refuse with PAYLOAD_TOO_LARGE',
      actual: () => readJson(jsonRequest(large), 64),
      code: 'PAYLOAD_TOO_LARGE',
    });
  });

  test('rejects malformed JSON', async () => {
    await assertRejects({
      given: 'a body that is not JSON',
      should: 'refuse with VALIDATION',
      actual: () => readJson(jsonRequest('{nope')),
      code: 'VALIDATION',
    });
  });
});
