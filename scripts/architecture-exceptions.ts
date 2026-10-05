export type ArchitectureException = {
  readonly id: string;
  readonly owner: string;
  readonly reason: string;
  readonly expires: string;
};

export const architectureExceptionRegistry: readonly ArchitectureException[] =
  [];

const markerPattern =
  /\/\/\s*architecture-exception:\s*([A-Z]+-\d+(?:\.\d+)*)/g;

export function findArchitectureExceptionMarkers(
  source: string,
): readonly string[] {
  return [
    ...new Set(
      [...source.matchAll(markerPattern)].map(([, id]) => id!).filter(Boolean),
    ),
  ];
}

export function checkArchitectureExceptions(
  registry: readonly ArchitectureException[],
  markers: readonly string[],
  today: string,
): readonly string[] {
  const entries = new Map(registry.map((entry) => [entry.id, entry]));
  return [
    ...markers
      .filter((id) => !entries.has(id))
      .map((id) => `architecture exception ${id} is not registered`),
    ...markers.flatMap((id) => {
      const entry = entries.get(id);
      return entry !== undefined && today > entry.expires
        ? [`architecture exception ${id} expired on ${entry.expires}`]
        : [];
    }),
  ];
}
