import { z } from 'zod';

/**
 * The production server's own launch settings, validated: it refuses any
 * NODE_ENV but production, and the port defaults to 3000.
 */
export function readStartOptions(
  env: Readonly<Record<string, string | undefined>>,
) {
  if (env.NODE_ENV !== 'production')
    throw new Error(
      `Production start requires NODE_ENV=production (received ${
        env.NODE_ENV ?? 'unset'
      })`,
    );
  return {
    port: z.coerce
      .number()
      .int()
      .min(1)
      .max(65535)
      .parse(env.PORT ?? 3000),
  };
}
