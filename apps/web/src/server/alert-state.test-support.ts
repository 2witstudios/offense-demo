import type { AlertSnapshot } from './alert-state';

/** A snapshot with nothing recorded: no outage, failure, request or event. */
export const emptySnapshot = (
  nowIso: string,
  redisState: AlertSnapshot['redisState'] = 'read',
): AlertSnapshot => ({
  nowIso,
  redisState,
  storageUnavailableSinceIso: null,
  limiterUnavailableSinceIso: null,
  deliveryConsecutiveFailures: 0,
  authRequests: { total: 0, serverErrors: 0, windowMinutes: 10 },
  retentionLastSuccessIso: null,
  mailShed: { count: 0, windowMinutes: 10 },
  networkDenied: { count: 0, windowMinutes: 10 },
});
