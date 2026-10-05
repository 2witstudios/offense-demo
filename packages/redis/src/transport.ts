import type { RedisClient } from 'bun';

/**
 * The client members the adapter uses. A real `RedisClient` satisfies it, and
 * so does the frozen wrapper integration suites get (`@offense-demo/redis/testing`),
 * which is why the adapter is typed by what it calls, not by Bun's class.
 */
export type RedisTransport = Pick<
  RedisClient,
  'connect' | 'ping' | 'send' | 'get' | 'del' | 'getdel' | 'close'
>;
