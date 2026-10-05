import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { secretConfigKeys } from '@offense-demo/config';
import { createLogger, loggableFields, type LogFields } from './index';

setupRitewayBun();

/** Emits one log call and returns the raw line and its parsed record. */
const emit = (fields: unknown, message = 'Request failed', child?: unknown) => {
  let output = '';
  const logger = createLogger({
    service: 'test',
    destination: { write: (text) => (output += text) },
  });
  const target = child === undefined ? logger : logger.child(child as never);
  target.log('request.unhandled', fields as LogFields, message);
  return {
    output,
    entry: JSON.parse(output) as Record<string, unknown>,
  };
};

const BASE_KEYS = [
  'appVersion',
  'event',
  'gitCommit',
  'level',
  'msg',
  'service',
  'time',
];

describe('structured logging: field allowlist (ADR 0019)', () => {
  test('a secret config key never reaches the log, wherever it is placed', () => {
    for (const key of secretConfigKeys) {
      const value = `sk-${key}-unlogged-value`;
      const { output } = emit(
        {
          [key]: value,
          nested: { [key]: value },
          err: { message: 'failed', cause: { [key]: value } },
          pairs: [[key, value]],
        },
        `Failed with ${key} ${value}`,
        { [key]: value },
      );
      assert({
        given: `${key} (derived from @offense-demo/config's secret fields) at the top level, nested, in an error cause, in pairs, in a child and in the message`,
        should: 'never appear in the emitted log line',
        actual: output.includes(value),
        expected: false,
      });
    }
  });

  test('every shape the post-merge probe leaked is refused', () => {
    const secret = 'S3CRET-probe-value';
    const probes: ReadonlyArray<readonly [string, unknown, string?]> = [
      ['privateKey', { privateKey: secret }],
      ['credential', { credential: secret }],
      ['session', { session: { token: secret } }],
      ['code', { code: secret }],
      ['connectionString', { connectionString: `postgres://u:${secret}@h/db` }],
      ['svix-signature', { 'svix-signature': `v1,${secret}` }],
      ['a Bearer header value', { header: `Bearer ${secret}` }],
      ['a postgres URL password', { url: `postgres://u:${secret}@h/db` }],
      [
        'a URL inside a sentence',
        { detail: `open https://x.example/?token=${secret} now` },
      ],
      ['header pairs in arrays', { headers: [['set-cookie', secret]] }],
      [
        'an Error whose message holds a credential URL',
        { err: new Error(`dial redis://:${secret}@h:6379 failed`) },
      ],
      ['the message argument', {}, `Token is ${secret}`],
      [
        'a Bearer value under an allowlisted code field',
        { operation: `Bearer ${secret}` },
      ],
      [
        'a credential URL under an allowlisted path field',
        { path: `postgres://u:${secret}@h/db` },
      ],
      [
        'a query token under an allowlisted route field',
        { route: `/auth/confirm?token=${secret}` },
      ],
      [
        'a credential URL under an allowlisted id field',
        { requestId: `redis://:${secret}@h` },
      ],
    ];
    for (const [shape, fields, message] of probes) {
      const { output } = emit(fields, message);
      assert({
        given: shape,
        should: 'leave the secret out of the emitted line',
        actual: output.includes(secret),
        expected: false,
      });
    }
  });

  test('admits every allowlisted field of its declared kind verbatim', () => {
    const fields = {
      operation: 'auth.confirm_email.submit',
      errorCode: 'RATE_LIMIT',
      source: 'better-auth',
      sourceLevel: 'warn',
      closeReason: 'auth_failed',
      cause: 'hello_timeout',
      invariantId: 'INV-7',
      requestId: 'req_abcdefgh-1234',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      userId: 'tz4a98xxat96iws9zmbrgj3a',
      providerMessageId: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794',
      route: '/api/auth/[...all]',
      path: '/sign-in/magic-link',
      clientIdHash: 'a'.repeat(64),
      durationMs: 12,
      status: 429,
      port: 3000,
      deleted: 0,
      batches: 3,
      closeCode: 4001,
      deliverySeqLagEstimate: 42,
      pending: 68,
      scope: 'ipv6_48',
    };
    const { entry } = emit(
      fields,
      'Session store unavailable; request refused',
    );
    const rest = Object.fromEntries(
      Object.entries(entry).filter(
        ([key]) => key !== 'time' && key !== 'level',
      ),
    );
    assert({
      given: 'one value of the right kind for every allowlisted field',
      should: 'emit each unchanged, beside the base fields and message',
      actual: rest,
      expected: {
        service: 'test',
        appVersion: 'development',
        gitCommit: 'unknown',
        ...fields,
        event: 'request.unhandled',
        msg: 'Session store unavailable; request refused',
      },
    });
    assert({
      given: 'the allowlist',
      should: 'be exactly the fields exercised above',
      actual: Object.keys(loggableFields).sort(),
      expected: Object.keys(fields).sort(),
    });
  });

  test('drops fields off the allowlist or of the wrong kind', () => {
    const { entry } = emit({
      operation: 'auth.request',
      userEmail: 'player@offense-demo.example.com',
      durationMs: -1,
      status: '200',
      requestId: { id: 'nested' },
      traceId: undefined,
    });
    assert({
      given: 'an unlisted field, and listed fields with values of another kind',
      should: 'emit only the admitted field',
      actual: Object.keys(entry).sort(),
      expected: [...BASE_KEYS, 'operation'].sort(),
    });
  });

  test('a message that is not fixed prose is replaced', () => {
    const { entry } = emit({}, 'Dial https://h.example/x failed');
    assert({
      given: 'a message carrying a URL',
      should: 'emit a placeholder instead of the message',
      actual: entry.msg,
      expected: '[REDACTED]',
    });
  });
});

describe('structured logging: hostile field values never break a log call', () => {
  test('a very deep structure', () => {
    let deep: Record<string, unknown> = { operation: 'leaf' };
    for (let index = 0; index < 50_000; index += 1)
      deep = { nested: deep, operation: deep };
    const { entry } = emit({ ...deep, errorCode: 'INTERNAL' });
    assert({
      given: 'fields 50,000 levels deep, under listed and unlisted names',
      should: 'log without throwing, keeping the admitted field',
      actual: entry.errorCode,
      expected: 'INTERNAL',
    });
  });

  test('getters and proxies that throw', () => {
    const getters = Object.defineProperties(
      {},
      {
        operation: {
          enumerable: true,
          get: () => {
            throw new Error('getter');
          },
        },
        other: {
          enumerable: true,
          get: () => {
            throw new Error('getter');
          },
        },
        errorCode: { enumerable: true, value: 'INTERNAL' },
      },
    );
    const trap = () => {
      throw new Error('trap');
    };
    const proxy = new Proxy(
      {},
      { ownKeys: trap, get: trap, getOwnPropertyDescriptor: trap, has: trap },
    );
    const withGetters = emit(getters, 'Request failed', proxy);
    const withProxy = emit(proxy);
    assert({
      given:
        'fields whose getters throw, and a child and fields that are throwing proxies',
      should:
        'log without throwing, keeping the plain field and leaving the accessors out',
      actual: {
        errorCode: withGetters.entry.errorCode,
        operation: 'operation' in withGetters.entry,
        proxyEvent: withProxy.entry.event,
      },
      expected: {
        errorCode: 'INTERNAL',
        operation: false,
        proxyEvent: 'request.unhandled',
      },
    });
  });

  test('a shared, non-circular reference', () => {
    const shared = { id: 'shared' };
    const { output, entry } = emit({
      first: shared,
      second: shared,
      operation: 'auth.request',
    });
    assert({
      given: 'one object referenced by two fields',
      should: 'treat both the same, never logging the second as [REDACTED]',
      actual: {
        redacted: output.includes('[REDACTED]'),
        operation: entry.operation,
      },
      expected: { redacted: false, operation: 'auth.request' },
    });
  });

  test('a circular structure', () => {
    const circular: Record<string, unknown> = { operation: 'auth.request' };
    circular.self = circular;
    const { entry } = emit(circular);
    assert({
      given: 'fields that refer to themselves',
      should: 'log without looping, keeping the admitted field',
      actual: entry.operation,
      expected: 'auth.request',
    });
  });
});
