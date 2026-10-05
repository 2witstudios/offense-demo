import { APIError } from 'better-auth/api';

/** Safe, retryable public failures; details never reach the response. */
export const unavailable = (code: string, message: string) =>
  new APIError(
    'SERVICE_UNAVAILABLE',
    { code, message },
    { 'Retry-After': '5' },
  );
