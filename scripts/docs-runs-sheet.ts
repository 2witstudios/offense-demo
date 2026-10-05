import { parseRunRecord, type DocumentationRunRecord } from './docs-contracts';

type Encoding = 'text' | 'count' | 'json';

// The Documentation Runs sheet holds one run record per row and one record
// field per column, with objects and arrays stored as JSON. This is the only
// statement of that layout: the consult prompt writes rows in it and
// docs:reconcile reads them back through parseRunRecord, so the sheet cannot
// drift from the enforced contract without failing loudly.
export const RUN_RECORD_COLUMNS = [
  { column: 'A', field: 'runId', encoding: 'text' },
  { column: 'B', field: 'workflow', encoding: 'text' },
  { column: 'C', field: 'startedAt', encoding: 'text' },
  { column: 'D', field: 'completedAt', encoding: 'text' },
  { column: 'E', field: 'status', encoding: 'text' },
  { column: 'F', field: 'sourceSnapshot', encoding: 'text' },
  { column: 'G', field: 'promptVersion', encoding: 'text' },
  { column: 'H', field: 'idempotencyKey', encoding: 'text' },
  { column: 'I', field: 'scope', encoding: 'json' },
  { column: 'J', field: 'pagesReviewed', encoding: 'count' },
  { column: 'K', field: 'findings', encoding: 'json' },
  { column: 'L', field: 'autoFixed', encoding: 'count' },
  { column: 'M', field: 'tasksCreated', encoding: 'count' },
  { column: 'N', field: 'pagesInvalidated', encoding: 'count' },
  { column: 'O', field: 'baseRevision', encoding: 'text' },
  { column: 'P', field: 'resultingRevision', encoding: 'text' },
  { column: 'Q', field: 'notes', encoding: 'text' },
] as const satisfies readonly {
  readonly column: string;
  readonly field: keyof DocumentationRunRecord;
  readonly encoding: Encoding;
}[];

export type RunRecordField = (typeof RUN_RECORD_COLUMNS)[number]['field'];

type SheetCell = {
  readonly raw: string;
  readonly value?: string | number | boolean | null;
};

export type SheetRow = {
  readonly rowIndex: number;
  readonly cells: Readonly<Record<string, SheetCell | undefined>>;
};

const SHEET = 'Documentation Runs';

const isBlank = (cell: SheetCell | undefined): cell is undefined =>
  cell === undefined || cell.raw.trim() === '';

function decodeCell(
  cell: SheetCell,
  column: (typeof RUN_RECORD_COLUMNS)[number],
  sheetRow: number,
): unknown {
  if (column.encoding === 'text') return cell.raw;
  if (column.encoding === 'count')
    return typeof cell.value === 'number' ? cell.value : Number(cell.raw);
  try {
    return JSON.parse(cell.raw) as unknown;
  } catch {
    throw new Error(
      `${SHEET} row ${sheetRow}: column ${column.column} (${column.field}) is not JSON`,
    );
  }
}

function recordFromRow(row: SheetRow): DocumentationRunRecord {
  const sheetRow = row.rowIndex + 1;
  const raw: Record<string, unknown> = {};
  for (const column of RUN_RECORD_COLUMNS) {
    const cell = row.cells[column.column];
    if (!isBlank(cell)) raw[column.field] = decodeCell(cell, column, sheetRow);
  }
  try {
    return parseRunRecord(raw);
  } catch (error) {
    throw new Error(`${SHEET} row ${sheetRow}: ${(error as Error).message}`);
  }
}

// The inverse of runRecordsFromSheet: a record as the cell text of one row.
// An absent optional field writes no cell.
export function encodeRunRecord(
  record: DocumentationRunRecord,
): Readonly<Record<string, string>> {
  const cells: Record<string, string> = {};
  for (const { column, field, encoding } of RUN_RECORD_COLUMNS) {
    const value = record[field];
    if (value === undefined) continue;
    cells[column] = encoding === 'json' ? JSON.stringify(value) : String(value);
  }
  return cells;
}

export function runRecordsFromSheet(
  rows: readonly SheetRow[],
): readonly DocumentationRunRecord[] {
  const header = rows.find((row) => row.rowIndex === 0);
  if (!header) throw new Error(`${SHEET} has no header row`);
  for (const { column, field } of RUN_RECORD_COLUMNS) {
    const name = header.cells[column]?.raw ?? '';
    if (name !== field)
      throw new Error(
        `${SHEET} header column ${column} is "${name}", expected "${field}"`,
      );
  }
  return rows
    .filter(
      (row) =>
        row.rowIndex > 0 &&
        Object.values(row.cells).some((cell) => !isBlank(cell)),
    )
    .sort((left, right) => left.rowIndex - right.rowIndex)
    .map(recordFromRow);
}
