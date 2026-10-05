/**
 * The runner's whole-database Redis sweep (ISSUE-237, ISSUE-275). It lives in
 * `scripts/`, which no workspace file may import (`runnerOnlyIssue`), and is
 * in no package's `exports`, so no test file can reach it by any import shape:
 * only `scripts/test-integration.ts` and the proofs call it, on a raw client,
 * after `requireTestServices` proved TEST_REDIS_URL is this slot's own
 * database (ISSUE-245). A whole-database SCAN is refused to everything a
 * suite can hold (`@offense-demo/redis/testing`).
 */
type Commands = {
  readonly send: (command: string, args: string[]) => Promise<unknown>;
};

/** Unlinks every key of the database that has no expiry and returns their names, so a run that left an immortal key fails loudly. */
export async function deleteAllKeysWithoutExpiry(
  client: Commands,
): Promise<string[]> {
  const immortal: string[] = [];
  let cursor = '0';
  do {
    const [next, page] = (await client.send('SCAN', [cursor])) as [
      string,
      string[],
    ];
    cursor = next;
    const ttls = await Promise.all(
      page.map((key) => client.send('PTTL', [key])),
    );
    page.forEach((key, index) => {
      if (Number(ttls[index]) === -1) immortal.push(key);
    });
  } while (cursor !== '0');
  for (let from = 0; from < immortal.length; from += 500)
    await client.send('UNLINK', immortal.slice(from, from + 500));
  return immortal.sort();
}
