export type DatabaseEventSink = (
  event: 'db.query.failed',
  fields: Readonly<Record<string, unknown>>,
  message: string,
) => void;

/**
 * The one failure wrapper every area operation runs through (ISSUE-8 AC2):
 * runs `fn`, and on rejection reports `operation` to `eventSink` as
 * `db.query.failed` before rethrowing unchanged. Replaces the
 * `try { … } catch { reportFailure(op); throw }` block that used to be
 * copied into every operation across the package.
 */
export async function instrumented<T>(
  eventSink: DatabaseEventSink | undefined,
  operation: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    eventSink?.('db.query.failed', { operation }, 'Database query failed');
    throw error;
  }
}
