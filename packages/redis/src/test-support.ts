import { createRedis } from './index';

type RecordedCommand = { command: string; args: string[] };

/**
 * Stands in for the Redis wire protocol only: records issued commands and
 * returns scripted values, so the adapter's namespacing, TTL and failure
 * semantics are exercised without a live server.
 */
function fakeRedis(values: Map<string, string> = new Map()) {
  const commands: RecordedCommand[] = [];
  let closed = false;
  let scriptedEval: unknown = [1, 60000];
  let shaCounter = 0;
  let noScriptOnce = false;
  const client = {
    async connect() {
      if (closed) throw new Error('client closed');
    },
    async ping() {
      commands.push({ command: 'PING', args: [] });
      return 'PONG';
    },
    async send(command: string, args: string[]) {
      commands.push({ command, args });
      if (command === 'SET') values.set(args[0] ?? '', args[1] ?? '');
      if (command === 'EVAL') return scriptedEval;
      if (command === 'SCRIPT' && args[0] === 'LOAD') {
        shaCounter += 1;
        return `fakesha${shaCounter}`;
      }
      if (command === 'EVALSHA') {
        if (noScriptOnce) {
          noScriptOnce = false;
          throw new Error('NOSCRIPT No matching script. Please use EVAL.');
        }
        return scriptedEval;
      }
      return 'OK';
    },
    async get(key: string) {
      commands.push({ command: 'GET', args: [key] });
      return values.get(key) ?? null;
    },
    async del(key: string) {
      commands.push({ command: 'DEL', args: [key] });
      return values.delete(key) ? 1 : 0;
    },
    async getdel(key: string) {
      commands.push({ command: 'GETDEL', args: [key] });
      const value = values.get(key) ?? null;
      values.delete(key);
      return value;
    },
    close() {
      closed = true;
    },
  };
  return {
    client: client as never,
    scriptEval: (value: unknown) => {
      scriptedEval = value;
    },
    /** The next EVALSHA throws NOSCRIPT once, so a caller can prove it reloads and retries. */
    simulateNoScriptOnce: () => {
      noScriptOnce = true;
    },
    commands,
    values: () => values,
    isClosed: () => closed,
  };
}

/** A Redis client whose connection always fails, for the shared "propagates outage" proof. */
export const createOfflineRedis = (
  events: Array<{ event: string; fields: Record<string, unknown> }>,
) =>
  createRedis({
    url: 'redis://127.0.0.1:1',
    namespace: 'test',
    eventSink: (event, fields) => events.push({ event, fields }),
    client: {
      async connect() {
        throw new Error('offline');
      },
    } as never,
  });

/** A fresh failure-event recorder paired with an always-offline Redis wired to it. */
export const createOutageRedis = () => {
  const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
  return { events, redis: createOfflineRedis(events) };
};

export const createTestRedis = (
  events: Array<{
    event: string;
    fields: Record<string, unknown>;
    message: string;
  }> = [],
  values?: Map<string, string>,
) => {
  const fake = fakeRedis(values);
  const redis = createRedis({
    url: 'redis://127.0.0.1:1',
    namespace: 'test',
    eventSink: (event, fields, message) =>
      events.push({ event, fields, message }),
    client: fake.client,
  });
  return { redis, ...fake };
};
