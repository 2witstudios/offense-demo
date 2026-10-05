import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A loopback HTTPS receiver standing in for the real Incidents webhook
 * (`requireHttpsWebhook` in notify-drive.ts refuses a non-https URL, so a
 * real end-to-end proof of "the probe posts" needs a real HTTPS server, not
 * a plain HTTP stub). Self-signed per call, same approach as
 * `apps/web/e2e/support/tls-edge.ts` — not shared with it directly since
 * that would cross the apps/web workspace boundary from this top-level
 * script (ADR 0026 exception, `.jscpd-tests-baseline.json`); the private key is
 * generated into a private temp directory and deleted immediately after
 * loading.
 */
export function withHttpsReceiver<T>(
  work: (receiver: {
    readonly url: string;
    readonly requests: () => readonly { body: string; headers: Headers }[];
  }) => Promise<T>,
): Promise<T> {
  const certDir = mkdtempSync(join(tmpdir(), 'offense-demo-alert-probe-tls-'));
  const made = Bun.spawnSync([
    'openssl',
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-keyout',
    join(certDir, 'key.pem'),
    '-out',
    join(certDir, 'cert.pem'),
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost',
  ]);
  const tls = {
    key: made.exitCode === 0 ? readFileSync(join(certDir, 'key.pem')) : null,
    cert: made.exitCode === 0 ? readFileSync(join(certDir, 'cert.pem')) : null,
  };
  rmSync(certDir, { recursive: true, force: true });
  if (tls.key === null || tls.cert === null)
    throw new Error('openssl could not create the cert');

  const requests: { body: string; headers: Headers }[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls,
    async fetch(request) {
      requests.push({ body: await request.text(), headers: request.headers });
      return new Response('ok');
    },
  });
  return work({
    url: `https://127.0.0.1:${server.port}`,
    requests: () => requests,
  }).finally(() => server.stop(true));
}
