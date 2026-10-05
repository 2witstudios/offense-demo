/** The Better Auth client's error shape, shared by every adapter over it. */
export type ClientError = {
  readonly status?: number | undefined;
  readonly code?: string | undefined;
} | null;
