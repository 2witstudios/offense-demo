import { describe, test } from 'riteway/bun';
import { setupRitewayBun, assert } from 'riteway/bun';
import { readRunRecords } from './docs-reconcile';
import { RUN_RECORD_COLUMNS } from './docs-runs-sheet';

setupRitewayBun();

const REPOSITORY = '2witstudios/offense-demo';

describe('readRunRecords', async () => {
  const cell = (raw: string) => ({ raw, value: raw });
  const header = {
    rowIndex: 0,
    cells: Object.fromEntries(
      RUN_RECORD_COLUMNS.map(({ column, field }) => [column, cell(field)]),
    ),
  };
  const row = (rowIndex: number, runId: string) => ({
    rowIndex,
    cells: {
      A: cell(runId),
      B: cell('technical-docs'),
      C: cell('2026-09-21T03:50:00Z'),
      D: cell('2026-09-21T03:56:00Z'),
      E: cell('complete'),
      F: cell(`${REPOSITORY}@merge007`),
      G: cell('docs-prompt-v1'),
      I: cell('{"pageIds":[],"changedSince":"2026-09-21T03:40:00Z"}'),
      J: cell('0'),
      K: cell('[]'),
      L: cell('0'),
      M: cell('0'),
      N: cell('0'),
    },
  });

  test('pages through the Runs sheet with the bearer token', async () => {
    const requests: { body: Record<string, unknown>; auth: string | null }[] =
      [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({
        body,
        auth: new Headers(init?.headers).get('Authorization'),
      });
      const first = body.fromRow === 0;
      return new Response(
        JSON.stringify({
          rows: first ? [header, row(1, 'dabc')] : [row(2, 'ddef')],
          hasMore: first,
          nextFromRow: first ? 2 : null,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const records = await readRunRecords({
      runsSheetId: 'runs-sheet',
      token: 'tok',
      apiUrl: 'https://pagespace.test',
      fetchImpl,
    });
    assert({
      given: 'a sheet that answers in two pages',
      should: 'follow nextFromRow and return every record, authenticated',
      actual: {
        runIds: records.map((record) => record.runId),
        fromRows: requests.map((request) => request.body.fromRow),
        auth: requests.map((request) => request.auth),
      },
      expected: {
        runIds: ['dabc', 'ddef'],
        fromRows: [0, 2],
        auth: ['Bearer tok', 'Bearer tok'],
      },
    });
  });

  test('fails loudly when PageSpace refuses the read', async () => {
    const fetchImpl = (async () =>
      new Response('{"error":"forbidden"}', {
        status: 403,
      })) as unknown as typeof fetch;
    let message = 'no throw';
    try {
      await readRunRecords({
        runsSheetId: 'runs-sheet',
        token: 'tok',
        apiUrl: 'https://pagespace.test',
        fetchImpl,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    assert({
      given: 'a 403 from the sheets route',
      should: 'throw rather than reconcile against no records',
      actual: message,
      expected:
        'Reading Documentation Runs responded 403: {"error":"forbidden"}',
    });
  });

  const readWith = async (pages: readonly unknown[]) => {
    let call = 0;
    const fetchImpl = (async () =>
      new Response(JSON.stringify(pages[call++] ?? pages.at(-1)), {
        status: 200,
      })) as unknown as typeof fetch;
    try {
      await readRunRecords({
        runsSheetId: 'runs-sheet',
        token: 'tok',
        apiUrl: 'https://pagespace.test',
        fetchImpl,
      });
      return 'no throw';
    } catch (error) {
      return (error as Error).message;
    }
  };

  test('refuses a page without a usable pagination envelope', async () => {
    assert({
      given: 'a 200 page with no hasMore flag',
      should: 'throw rather than treat one page as the whole sheet',
      actual: (await readWith([{ rows: [header] }])).startsWith(
        'Reading Documentation Runs returned an invalid page',
      ),
      expected: true,
    });
  });

  test('refuses a cursor that does not advance', async () => {
    assert({
      given: 'a page that promises more rows but points back at itself',
      should: 'throw rather than request the same page forever',
      actual: (
        await readWith([{ rows: [header], hasMore: true, nextFromRow: 0 }])
      ).startsWith('Reading Documentation Runs returned an invalid page'),
      expected: true,
    });
  });

  test('gives up on a sheet read PageSpace never answers', async () => {
    const fetchImpl = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('timed out', 'TimeoutError')),
        );
      })) as unknown as typeof fetch;
    let message = 'no throw';
    try {
      await readRunRecords({
        runsSheetId: 'runs-sheet',
        token: 'tok',
        apiUrl: 'https://pagespace.test',
        fetchImpl,
        timeoutMs: 20,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    assert({
      given: 'a sheets read that is accepted and never answered',
      should: 'throw at its deadline instead of hanging the sweep',
      actual: message.startsWith(
        'Reading Documentation Runs did not answer within',
      ),
      expected: true,
    });
  });

  test('bounds the whole sheet read by one deadline', async () => {
    let page = 0;
    const fetchImpl = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('timed out', 'TimeoutError')),
        );
        setTimeout(() => {
          page += 1;
          resolve(
            new Response(
              JSON.stringify({
                rows: [header],
                hasMore: true,
                nextFromRow: page,
              }),
              { status: 200 },
            ),
          );
        }, 15);
      })) as unknown as typeof fetch;
    let message = 'no throw';
    try {
      await readRunRecords({
        runsSheetId: 'runs-sheet',
        token: 'tok',
        apiUrl: 'https://pagespace.test',
        fetchImpl,
        timeoutMs: 50,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    assert({
      given: 'pages that each answer inside the limit but never end',
      should: 'stop when the read as a whole runs out of time',
      actual: message.startsWith(
        'Reading Documentation Runs did not answer within',
      ),
      expected: true,
    });
  });
});
