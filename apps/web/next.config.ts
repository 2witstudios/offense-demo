import type { NextConfig } from 'next';
const config: NextConfig = {
  poweredByHeader: false,
  // The repo forbids a second agent doc (root AGENTS.md); stop `next dev` generating them.
  agentRules: false,
  serverExternalPackages: [
    '@offense-demo/db',
    '@offense-demo/redis',
    '@offense-demo/logger',
    '@offense-demo/observability',
    '@offense-demo/config',
  ],
  experimental: {
    serverActions: {
      // Form actions carry a few short fields (the username claim's own
      // route reads at most 4 KiB). Next reads and decodes the whole body
      // before an action's session and rate-limit gates run, so anything
      // larger is refused unread instead of at the 1 MB default (ISSUE-79).
      bodySizeLimit: '16kb',
    },
  },
  transpilePackages: [
    '@offense-demo/protocol',
    '@offense-demo/errors',
    '@offense-demo/auth',
  ],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
          ...(process.env.NODE_ENV === 'production'
            ? [
                {
                  key: 'Strict-Transport-Security',
                  value: 'max-age=31536000; includeSubDomains',
                },
              ]
            : []),
        ],
      },
      // Later entries win: a URL that carries a sign-in token must never be
      // sent as a Referer (ADR 0025).
      {
        source: '/auth/confirm',
        headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
      },
    ];
  },
};
export default config;
