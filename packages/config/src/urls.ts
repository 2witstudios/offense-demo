import { z } from 'zod';

export const databaseUrl = z
  .url()
  .refine(
    (value) => ['postgres:', 'postgresql:'].includes(new URL(value).protocol),
    'Expected PostgreSQL URL',
  );
export const redisUrl = z
  .url()
  .refine(
    (value) => ['redis:', 'rediss:'].includes(new URL(value).protocol),
    'Expected Redis URL',
  );
