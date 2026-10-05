import type { RedisTransport } from './transport';
import type { PresenceActivity } from '@offense-demo/protocol';
import { redisKey } from './redis-key';
import {
  USER_CONNECTIONS_MAX,
  assertUserId,
  assertKeySegment,
  assertLimit,
  assertTtlSeconds,
  createScriptRunner,
  deletePresenceLeaseScript,
  parseActivity,
  readUserConnectionsScript,
  readOnlinePresenceScript,
  refreshPresenceLeaseScript,
  sweepOnlinePresenceScript,
  upsertPresenceLeaseScript,
} from './presence-scripts';

export type { PresenceActivity };
export type PresenceLease = {
  readonly connId: string;
  readonly userId: string;
  readonly instanceId: string;
};
export type PresenceConnection = {
  readonly connId: string;
  readonly userId: string;
  readonly activity: PresenceActivity;
  readonly instanceId: string;
  readonly expiresAtMs: number;
};
export type PresenceOnlineUser = {
  readonly userId: string;
  readonly expiresAtMs: number;
};

export function createPresenceOperations({
  client,
  namespace,
  reportFailure,
}: {
  readonly client: RedisTransport;
  readonly namespace: string;
  readonly reportFailure: (operation: string) => void;
}) {
  const runScript = createScriptRunner(client);
  return {
    /** Atomic upsert of one connection's presence lease with a mandatory TTL. */
    async upsertPresenceLease(
      lease: PresenceLease & { readonly activity: PresenceActivity },
      ttlSeconds: number,
    ) {
      assertKeySegment('connId', lease.connId);
      assertUserId(lease.userId);
      assertKeySegment('instanceId', lease.instanceId);
      const activity = parseActivity(lease.activity);
      assertTtlSeconds(ttlSeconds);
      try {
        await client.connect();
        await runScript(upsertPresenceLeaseScript, 3, [
          redisKey(namespace, 'presence', 'conn', lease.connId),
          redisKey(namespace, 'presence', 'user', lease.userId),
          redisKey(namespace, 'presence', 'online'),
          lease.userId,
          activity,
          lease.instanceId,
          String(ttlSeconds * 1000),
          lease.connId,
        ]);
      } catch (error) {
        reportFailure('upsertPresenceLease');
        throw error;
      }
    },
    /**
     * Extends an existing lease. Returns `refreshed: false` without error
     * when the lease already expired: the caller must re-upsert.
     */
    async refreshPresenceLease(
      lease: Pick<PresenceLease, 'connId' | 'userId'>,
      ttlSeconds: number,
    ) {
      assertKeySegment('connId', lease.connId);
      assertUserId(lease.userId);
      assertTtlSeconds(ttlSeconds);
      try {
        await client.connect();
        const refreshed = (await runScript(refreshPresenceLeaseScript, 3, [
          redisKey(namespace, 'presence', 'conn', lease.connId),
          redisKey(namespace, 'presence', 'user', lease.userId),
          redisKey(namespace, 'presence', 'online'),
          String(ttlSeconds * 1000),
          lease.connId,
          lease.userId,
        ])) as number;
        return { refreshed: refreshed === 1 };
      } catch (error) {
        reportFailure('refreshPresenceLease');
        throw error;
      }
    },
    /** Atomic delete of one connection's presence lease (a clean disconnect). */
    async deletePresenceLease(lease: Pick<PresenceLease, 'connId' | 'userId'>) {
      assertKeySegment('connId', lease.connId);
      assertUserId(lease.userId);
      try {
        await client.connect();
        await runScript(deletePresenceLeaseScript, 3, [
          redisKey(namespace, 'presence', 'conn', lease.connId),
          redisKey(namespace, 'presence', 'user', lease.userId),
          redisKey(namespace, 'presence', 'online'),
          lease.connId,
          lease.userId,
        ]);
      } catch (error) {
        reportFailure('deletePresenceLease');
        throw error;
      }
    },
    /**
     * A user's live connections (at most `USER_CONNECTIONS_MAX`, latest
     * expiry first), hydrated and userId-checked in one read-only Lua op.
     * `nowMs` is the Redis server clock the script used to trim and score
     * these leases; a caller deriving presence status from them must use
     * this, never an instance clock.
     */
    async readUserConnections(userId: string): Promise<{
      readonly connections: readonly PresenceConnection[];
      readonly nowMs: number;
    }> {
      assertUserId(userId);
      try {
        await client.connect();
        const flat = (await runScript(readUserConnectionsScript, 1, [
          redisKey(namespace, 'presence', 'user', userId),
          userId,
          `${redisKey(namespace, 'presence', 'conn')}:`,
          String(USER_CONNECTIONS_MAX),
        ])) as (string | number)[];
        const nowMs = Number(flat[0]);
        const connections: PresenceConnection[] = [];
        for (let index = 1; index < flat.length; index += 5) {
          connections.push({
            connId: flat[index] as string,
            userId: flat[index + 1] as string,
            activity: parseActivity(String(flat[index + 2])),
            instanceId: flat[index + 3] as string,
            expiresAtMs: Number(flat[index + 4]),
          });
        }
        return { connections, nowMs };
      } catch (error) {
        reportFailure('readUserConnections');
        throw error;
      }
    },
    /**
     * A bounded, read-only range of the online set (live users only; no
     * write-on-read — see `sweepOnlinePresence`). `nowMs` is the Redis
     * server clock the script used to filter these users; a caller
     * deriving presence status from them must use this, never an instance
     * clock.
     */
    async readOnlinePresence(limit: number): Promise<{
      readonly users: readonly PresenceOnlineUser[];
      readonly nowMs: number;
    }> {
      assertLimit(limit);
      try {
        await client.connect();
        const flat = (await runScript(readOnlinePresenceScript, 1, [
          redisKey(namespace, 'presence', 'online'),
          String(limit),
        ])) as (string | number)[];
        const nowMs = Number(flat[0]);
        const users: PresenceOnlineUser[] = [];
        for (let index = 1; index < flat.length; index += 2) {
          users.push({
            userId: flat[index] as string,
            expiresAtMs: Number(flat[index + 1]),
          });
        }
        return { users, nowMs };
      } catch (error) {
        reportFailure('readOnlinePresence');
        throw error;
      }
    },
    /**
     * Removes up to `limit` (at most `PRESENCE_LIMIT_MAX`) expired members
     * from the online set. The write side of trimming that
     * `readOnlinePresence` never does; the web retention sweep runs it on
     * its schedule, not per read. Returns the number removed.
     */
    async sweepOnlinePresence(limit: number): Promise<number> {
      assertLimit(limit);
      try {
        await client.connect();
        return (await runScript(sweepOnlinePresenceScript, 1, [
          redisKey(namespace, 'presence', 'online'),
          String(limit),
        ])) as number;
      } catch (error) {
        reportFailure('sweepOnlinePresence');
        throw error;
      }
    },
  };
}
