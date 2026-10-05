/** Shared by `redisKey` and every module that validates a raw key segment before it reaches Redis. */
export const redisSegmentPattern = /^[a-zA-Z0-9_-]{1,100}$/;

export function redisKey(namespace: string, ...segments: string[]): string {
  if (
    ![namespace, ...segments].every((segment) =>
      redisSegmentPattern.test(segment),
    )
  )
    throw new Error('Invalid Redis key segment');
  return [namespace, 'v1', ...segments].join(':');
}
