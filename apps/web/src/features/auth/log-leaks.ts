/** Captured logger calls: one `[event, fields, message]` tuple per entry. */
export type RecordedLogs = (readonly unknown[])[];

/**
 * Test support for the auth suites: true when any captured log entry carries
 * one of the given secrets (recipient, token, provider detail) anywhere in
 * its serialized form.
 */
export const logsLeakSecrets = (
  logs: readonly unknown[],
  secrets: readonly string[],
) => {
  const serialized = JSON.stringify(logs);
  return secrets.some((secret) => serialized.includes(secret));
};
