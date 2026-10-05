import type { ProtocolError } from '@offense-demo/protocol';

/** The code vocabulary is the protocol's; this table only maps each code. */
export type ErrorCode = ProtocolError['code'];
const definitions: Readonly<
  Record<ErrorCode, readonly [status: number, message: string]>
> = {
  VALIDATION: [400, 'Invalid input'],
  AUTHENTICATION: [401, 'Authentication required'],
  AUTHORIZATION: [403, 'Permission denied'],
  NOT_FOUND: [404, 'Resource not found'],
  CONFLICT: [409, 'Resource conflict'],
  PAYLOAD_TOO_LARGE: [413, 'Request body too large'],
  INVARIANT: [422, 'Domain operation is not allowed'],
  RATE_LIMIT: [429, 'Too many requests'],
  INFRASTRUCTURE: [503, 'Service temporarily unavailable'],
  INTERNAL: [500, 'Unexpected internal error'],
};
export type AppError = Error & {
  readonly code: ErrorCode;
  readonly invariantId?: string;
};
const knownErrors = new WeakSet<Error>();
/** Details and cause remain internal. Public messages are fixed by error code. */
export function createAppError(
  code: ErrorCode,
  message: string = definitions[code][1],
  cause?: unknown,
): AppError {
  const error = Object.assign(new Error(message, { cause }), { code });
  knownErrors.add(error);
  return error;
}
/** Create an invariant failure with an identity safe to expose to callers. */
export function createInvariantError(
  invariantId: string,
  message: string = definitions.INVARIANT[1],
  cause?: unknown,
): AppError {
  const error = createAppError('INVARIANT', message, cause);
  Object.assign(error, { invariantId });
  return error;
}
/** Only factory-minted errors carry a trustworthy public code. */
export function isAppError(error: unknown): error is AppError {
  return error instanceof Error && knownErrors.has(error);
}
/** The HTTP status and `{ error }` body, whose `error` is the protocol's public error. */
export function toPublicError(
  error: unknown,
  requestId: string,
): {
  readonly status: number;
  readonly body: { readonly error: ProtocolError };
} {
  const code = isAppError(error) ? error.code : 'INTERNAL';
  const invariantId =
    code === 'INVARIANT' && isAppError(error) ? error.invariantId : undefined;
  return {
    status: definitions[code][0],
    body: {
      error: {
        version: 1,
        type: 'error',
        code,
        message: definitions[code][1],
        requestId,
        ...(invariantId === undefined ? {} : { invariantId }),
      },
    },
  };
}
