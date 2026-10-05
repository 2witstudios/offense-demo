import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import playwrightConfig, {
  resolveE2EServices,
  resolveRealtimeNamespace,
  resolveReuseExistingServer,
} from '../playwright.config';

setupRitewayBun();

// The configured web servers: the app (0) and realtime (1).
const webServer = (index: 0 | 1) =>
  Array.isArray(playwrightConfig.webServer)
    ? playwrightConfig.webServer[index]
    : index === 0
      ? playwrightConfig.webServer
      : undefined;

describe('Playwright web server output', () => {
  test('writes one server log per app port', () => {
    const server = webServer(0);
    assert({
      given: 'the configured e2e web server',
      should: 'log to a file named after its app port, never a shared one',
      actual: server?.command.endsWith(
        `> test-results/server-${server.env?.PORT}.log 2>&1`,
      ),
      expected: true,
    });
  });
});

describe('Playwright realtime web server', () => {
  const realtime = webServer(1);

  test('takes its database and Redis from the same slot services as the web server', () => {
    assert({
      given: 'the configured realtime web server',
      should:
        'source DATABASE_URL and REDIS_URL from resolveE2EServices and REDIS_NAMESPACE from resolveRealtimeNamespace',
      actual: {
        databaseUrl: realtime?.env?.DATABASE_URL,
        redisUrl: realtime?.env?.REDIS_URL,
        namespace: realtime?.env?.REDIS_NAMESPACE,
      },
      expected: {
        databaseUrl: resolveE2EServices(process.env).DATABASE_URL,
        redisUrl: resolveE2EServices(process.env).REDIS_URL,
        namespace: resolveRealtimeNamespace(process.env),
      },
    });
  });

  test('logs to a file named after its own port, beside the web server log', () => {
    assert({
      given: 'the configured realtime web server',
      should: 'log to test-results/realtime-<port>.log',
      actual: realtime?.command.includes(
        `test-results/realtime-${realtime?.env?.REALTIME_PORT}.log`,
      ),
      expected: true,
    });
  });

  test('follows the same reuse policy as the web server', () => {
    assert({
      given: 'the configured realtime web server',
      should: 'share resolveReuseExistingServer with the web server',
      actual: realtime?.reuseExistingServer,
      expected: resolveReuseExistingServer(process.env),
    });
  });
});

describe('Playwright web server readiness', () => {
  test('probes the TLS edge the suite uses, so reuse needs the whole wrapper', () => {
    const server = webServer(0);
    assert({
      given: 'the configured e2e web server',
      should: 'wait for the HTTPS edge origin and accept its test certificate',
      actual: {
        edge: server?.url?.startsWith(`${playwrightConfig.use?.baseURL}/`),
        https: server?.url?.startsWith('https://localhost:'),
        ignoreHTTPSErrors: server?.ignoreHTTPSErrors,
      },
      expected: { edge: true, https: true, ignoreHTTPSErrors: true },
    });
  });

  test('waits for readiness, which answers 200 only once the start-up gate opens (ISSUE-197)', () => {
    const server = webServer(0);
    assert({
      given:
        'a production server whose liveness answers 200 while start.ts still prepares Next (ISSUE-172)',
      should:
        'wait on /api/health/ready through the edge, never on liveness, so no navigation meets a gated 503',
      actual: server?.url,
      expected: `${playwrightConfig.use?.baseURL}/api/health/ready`,
    });
  });
});
