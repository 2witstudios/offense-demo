import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createMetricsStore } from '../../server/metrics-store';
import { silentLogger } from '../../server/test-loggers.test-support';
import { createMetricsHandler } from './metrics';

setupRitewayBun();

const TOKEN = 'a'.repeat(32);

describe('GET /api/ops/metrics (AUTH-7.7)', () => {
  test('refuses a request without the probe bearer token', async () => {
    const handler = createMetricsHandler({
      logger: silentLogger,
      metrics: createMetricsStore(),
      token: () => TOKEN,
    });
    const response = await handler(
      new Request('http://localhost/api/ops/metrics'),
    );
    assert({
      given: 'a request with no Authorization header',
      should: 'answer 401',
      actual: response.status,
      expected: 401,
    });
  });

  test('answers Prometheus text exposition for an authorized request', async () => {
    const metrics = createMetricsStore();
    metrics.observe('http.request.completed', {
      operation: 'auth.request',
      status: 200,
    });
    const handler = createMetricsHandler({
      logger: silentLogger,
      metrics,
      token: () => TOKEN,
    });
    const response = await handler(
      new Request('http://localhost/api/ops/metrics', {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    );
    const text = await response.text();
    assert({
      given: 'an authorized request against a store with one recorded 2xx',
      should: 'answer 200 with the Prometheus content type and that sample',
      actual: {
        status: response.status,
        contentType: response.headers.get('content-type'),
        hasSample: text.includes(
          'auth_http_requests_total{status_class="2xx"} 1',
        ),
      },
      expected: {
        status: 200,
        contentType: 'text/plain; version=0.0.4; charset=utf-8',
        hasSample: true,
      },
    });
  });
});
