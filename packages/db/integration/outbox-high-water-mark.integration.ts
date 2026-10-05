import { createId } from '@paralleldrive/cuid2';
import { assert, setupRitewayBun, test } from 'riteway/bun';
import { requireTestServices } from '@offense-demo/config';
import { readOutboxHighWaterMark } from '../src/outbox';
import { openOutOfOrderTransactions } from './two-transaction-race.test-support';

setupRitewayBun();

const { databaseUrl: url } = requireTestServices(process.env);

test('the high-water mark follows the same commit-order visibility rule as the drain: an open transaction holds it back even below an already-committed later one', async () => {
  const topic = `room:${createId()}`;
  const { connA, connB, connC, drizzleC, rowA, rowB, commitA } =
    await openOutOfOrderTransactions(url, topic);
  const positionA = { txid: BigInt(rowA.txid), seq: BigInt(rowA.seq) };
  const positionB = { txid: BigInt(rowB.txid), seq: BigInt(rowB.seq) };
  try {
    const whileOpen = await readOutboxHighWaterMark(drizzleC);
    const blockedByA = BigInt(whileOpen.txid) < positionA.txid;

    await commitA();
    const afterCommit = await readOutboxHighWaterMark(drizzleC);
    const reachesB =
      BigInt(afterCommit.txid) > positionB.txid ||
      (BigInt(afterCommit.txid) === positionB.txid &&
        afterCommit.seq >= positionB.seq);

    assert({
      given:
        'A opens and inserts, B opens, inserts and commits while A is still open, then A commits',
      should:
        'keep the high-water mark below A while A is open, even though B already committed, then advance to at least B once A commits',
      actual: { blockedByA, reachesB },
      expected: { blockedByA: true, reachesB: true },
    });
  } finally {
    await connC.unsafe('delete from outbox where topic = $1', [topic]);
    await connA.close();
    await connB.close();
    await connC.close();
  }
});
