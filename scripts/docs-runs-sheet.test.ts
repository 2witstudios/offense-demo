import { describe, test } from 'riteway/bun';
import { setupRitewayBun, assert } from 'riteway/bun';
import {
  encodeRunRecord,
  RUN_RECORD_COLUMNS,
  runRecordsFromSheet,
  type SheetRow,
} from './docs-runs-sheet';

setupRitewayBun();

const cell = (raw: string) => ({ raw, value: raw });

const headerRow: SheetRow = {
  rowIndex: 0,
  cells: Object.fromEntries(
    RUN_RECORD_COLUMNS.map(({ column, field }) => [column, cell(field)]),
  ),
};

const recordRow = (
  rowIndex: number,
  overrides: Readonly<Record<string, string>> = {},
): SheetRow => ({
  rowIndex,
  cells: Object.fromEntries(
    Object.entries({
      A: 'dabc',
      B: 'technical-docs',
      C: '2026-09-21T03:50:00Z',
      D: '2026-09-21T03:56:00Z',
      E: 'complete',
      F: '2witstudios/offense-demo@fd6340b',
      G: 'docs-prompt-v1',
      H: '2witstudios/offense-demo:fd6340b:pull_request.merged',
      I: '{"pageIds":["aug9"],"changedSince":"2026-09-21T03:40:00Z"}',
      J: '1',
      K: '[]',
      L: '0',
      M: '0',
      N: '0',
      Q: 'Data-only change; no section cites it.',
      ...overrides,
    })
      .filter(([, raw]) => raw !== '')
      .map(([column, raw]) => [column, cell(raw)]),
  ),
});

const message = (run: () => unknown): string => {
  try {
    run();
    return 'no throw';
  } catch (error) {
    return (error as Error).message;
  }
};

describe('runRecordsFromSheet', async () => {
  test('reads each row as one validated run record', async () => {
    const [record] = runRecordsFromSheet([headerRow, recordRow(1)]);
    assert({
      given: 'a header row and one conformant record row',
      should: 'decode numbers and JSON cells into the canonical record',
      actual: {
        runId: record?.runId,
        sourceSnapshot: record?.sourceSnapshot,
        scope: record?.scope,
        pagesReviewed: record?.pagesReviewed,
        findings: record?.findings,
        notes: record?.notes,
      },
      expected: {
        runId: 'dabc',
        sourceSnapshot: '2witstudios/offense-demo@fd6340b',
        scope: { pageIds: ['aug9'], changedSince: '2026-09-21T03:40:00Z' },
        pagesReviewed: 1,
        findings: [],
        notes: 'Data-only change; no section cites it.',
      },
    });
  });

  test('accepts numbers stored as numeric cells', async () => {
    const row = recordRow(1);
    const [record] = runRecordsFromSheet([
      headerRow,
      { ...row, cells: { ...row.cells, J: { raw: '3', value: 3 } } },
    ]);
    assert({
      given: 'a count the sheet stored as a number',
      should: 'keep it as that integer',
      actual: record?.pagesReviewed,
      expected: 3,
    });
  });

  test('omits optional fields left empty', async () => {
    const [record] = runRecordsFromSheet([headerRow, recordRow(1)]);
    assert({
      given: 'a row with no revision columns filled',
      should: 'leave baseRevision and resultingRevision absent',
      actual: {
        base: record !== undefined && 'baseRevision' in record,
        resulting: record !== undefined && 'resultingRevision' in record,
      },
      expected: { base: false, resulting: false },
    });
  });

  test('ignores rows with no cells at all', async () => {
    assert({
      given: 'an empty row between records',
      should: 'read only the rows that hold data',
      actual: runRecordsFromSheet([
        headerRow,
        recordRow(1),
        { rowIndex: 2, cells: {} },
        recordRow(3, { A: 'ddef' }),
      ]).map((record) => record.runId),
      expected: ['dabc', 'ddef'],
    });
  });

  test('refuses a sheet whose header has drifted from the contract', async () => {
    assert({
      given: 'a header naming the wrong field in column F',
      should: 'throw naming the column and both names',
      actual: message(() =>
        runRecordsFromSheet([
          {
            rowIndex: 0,
            cells: { ...headerRow.cells, F: cell('pagesWritten') },
          },
          recordRow(1),
        ]),
      ),
      expected:
        'Documentation Runs header column F is "pagesWritten", expected "sourceSnapshot"',
    });
  });

  test('refuses a sheet with no header row', async () => {
    assert({
      given: 'rows without row 1',
      should: 'throw rather than guess the layout',
      actual: message(() => runRecordsFromSheet([recordRow(1)])),
      expected: 'Documentation Runs has no header row',
    });
  });

  test('names the row and column of a malformed JSON cell', async () => {
    assert({
      given: 'a findings cell that is not JSON',
      should: 'throw naming the sheet row and the field',
      actual: message(() =>
        runRecordsFromSheet([headerRow, recordRow(4, { K: 'none' })]),
      ),
      expected: 'Documentation Runs row 5: column K (findings) is not JSON',
    });
  });

  test('names the row of a record that breaks the schema', async () => {
    assert({
      given: 'a status outside the allowed set',
      should: 'throw prefixed with the sheet row',
      actual: message(() =>
        runRecordsFromSheet([headerRow, recordRow(1, { E: 'done' })]),
      ).startsWith('Documentation Runs row 2: '),
      expected: true,
    });
  });

  test('reads back exactly what encodeRunRecord writes', async () => {
    const record = {
      runId: 'dabc',
      workflow: 'technical-docs',
      startedAt: '2026-09-21T03:50:00Z',
      completedAt: '2026-09-21T03:50:00Z',
      status: 'failed' as const,
      sourceSnapshot: '2witstudios/offense-demo@fd6340b',
      promptVersion: 'docs-prompt-v1',
      idempotencyKey: '2witstudios/offense-demo:fd6340b:pull_request.merged',
      scope: { pageIds: [], changedSince: '2026-09-21T03:40:00Z' },
      pagesReviewed: 0,
      findings: [],
      autoFixed: 0,
      tasksCreated: 0,
      pagesInvalidated: 0,
      notes: 'Awaiting the agent.',
    };
    const encoded = encodeRunRecord(record);
    assert({
      given: 'a run record encoded into sheet cells, optional revisions absent',
      should: 'decode to the same record and leave the absent columns empty',
      actual: {
        roundTrip: runRecordsFromSheet([
          headerRow,
          {
            rowIndex: 1,
            cells: Object.fromEntries(
              Object.entries(encoded).map(([column, raw]) => [
                column,
                cell(raw),
              ]),
            ),
          },
        ])[0],
        revisionColumns: ['O', 'P'].filter((column) => column in encoded),
      },
      expected: { roundTrip: record, revisionColumns: [] },
    });
  });
});
