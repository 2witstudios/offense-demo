import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { App } from '../src/server/app';
import type { Routes } from '../src/server/routes';
import { createProductionServer } from '../src/server/server-wiring';
import { origin } from './fixtures';
import { requestFrom } from './socket-request';

/**
 * The composed app behind the server start.ts runs (`createProductionServer`
 * over `createApp`'s logger), for suites proving that real requests reach
 * AUTH-7.7's `/api/ops/metrics` and `/api/ops/alerts` through the logger tap
 * (ISSUE-173, ISSUE-190). Next's handler is stood in for by the same route
 * handlers the app binds.
 */
const routeFor = (routes: Routes, method: string, path: string) => {
  if (path.startsWith('/api/auth/'))
    return method === 'POST' ? routes.auth.POST : routes.auth.GET;
  if (method === 'POST' && path === '/api/realtime/ticket')
    return routes.ticket.POST;
  if (method === 'GET' && path === '/api/ops/metrics')
    return routes.ops.metrics.GET;
  if (method === 'GET' && path === '/api/ops/alerts')
    return routes.ops.alerts.GET;
  return undefined;
};

type AlertSnapshotBody = {
  readonly redisState: 'read' | 'unreachable';
  readonly storageUnavailableSinceIso: string | null;
  readonly limiterUnavailableSinceIso: string | null;
  readonly deliveryConsecutiveFailures: number;
  readonly authRequests: {
    readonly total: number;
    readonly serverErrors: number;
    readonly windowMinutes: number;
  };
  readonly retentionLastSuccessIso: string | null;
  readonly mailShed: { readonly count: number; readonly windowMinutes: number };
  readonly networkDenied: {
    readonly count: number;
    readonly windowMinutes: number;
  };
};

export async function serveEdge({
  app,
  routes,
  opsToken,
}: {
  readonly app: App;
  readonly routes: Routes;
  readonly opsToken: string;
}) {
  const handle = async (
    incoming: IncomingMessage,
    outgoing: ServerResponse,
  ) => {
    const route = routeFor(
      routes,
      incoming.method ?? 'GET',
      new URL(incoming.url ?? '/', origin).pathname,
    );
    if (!route) {
      outgoing.writeHead(404);
      outgoing.end();
      return;
    }
    const response = await route(await requestFrom(incoming));
    outgoing.writeHead(response.status, {
      'content-type': response.headers.get('content-type') ?? 'text/plain',
    });
    outgoing.end(await response.text());
  };
  const server = createProductionServer({
    app,
    handle,
    readRouteTable: () => null,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const opsGet = async (path: string) => {
    const response = await fetch(`${base}${path}`, {
      headers: { authorization: `Bearer ${opsToken}` },
    });
    if (!response.ok) throw new Error(`${path} answered ${response.status}`);
    return response;
  };
  return {
    /** A same-origin JSON POST from this socket's client; resolves to the status. */
    post: (
      path: string,
      body: unknown,
      headers: Readonly<Record<string, string>> = {},
    ) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, ...headers },
        body: JSON.stringify(body),
      }).then((response) => response.status),
    /** `/api/ops/metrics`' Prometheus text. */
    metricsText: async () => (await opsGet('/api/ops/metrics')).text(),
    /** `/api/ops/alerts`' snapshot. */
    alertSnapshot: async () =>
      (
        (await (await opsGet('/api/ops/alerts')).json()) as {
          snapshot: AlertSnapshotBody;
        }
      ).snapshot,
    /**
     * `/api/ops/alerts` as the probe sees it, whatever it answers: the
     * status, the fired condition ids and the snapshot.
     */
    alerts: async () => {
      const response = await fetch(`${base}/api/ops/alerts`, {
        headers: { authorization: `Bearer ${opsToken}` },
      });
      const body = (await response.json()) as {
        conditions?: readonly { readonly id: string }[];
        snapshot?: AlertSnapshotBody;
      };
      return {
        status: response.status,
        conditions: body.conditions?.map((condition) => condition.id),
        snapshot: body.snapshot,
      };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** One sample's value, or undefined when the exposition has no such line. */
export const sampleOf = (text: string, series: string) => {
  const line = text.split('\n').find((entry) => entry.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.slice(series.length + 1));
};

/**
 * `auth_http_request_duration_ms` for one operation label: every bucket by
 * its `le`, the sum and the count; undefined when the label has no series.
 */
export const latencyHistogramOf = (text: string, operation: string) => {
  const label = `{operation="${operation}"`;
  const lines = text
    .split('\n')
    .filter(
      (line) =>
        line.startsWith('auth_http_request_duration_ms_') &&
        line.includes(label),
    );
  if (lines.length === 0) return undefined;
  const buckets: Record<string, number> = {};
  for (const line of lines) {
    const bucket = line.match(/,le="([^"]+)"\} (\S+)$/);
    if (bucket) buckets[bucket[1] as string] = Number(bucket[2]);
  }
  return {
    buckets,
    sum: sampleOf(text, `auth_http_request_duration_ms_sum${label}}`),
    count: sampleOf(text, `auth_http_request_duration_ms_count${label}}`),
  };
};
