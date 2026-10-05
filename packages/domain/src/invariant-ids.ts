/**
 * Every invariant the domain may reject with, by stable public id.
 * `spec/invariants.json` registers each id with a fixture and a test
 * (`bun invariants`); an id added here without registering it fails the gate.
 */
export const projectInvariantIds = {
  nameValid: 'project.name.valid',
  renameChangesName: 'project.rename.changes-name',
  archivedIsTerminal: 'project.archived.terminal',
} as const;
