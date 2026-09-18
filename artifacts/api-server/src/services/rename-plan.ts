export type RenameMapping = { id: string; sourcePath: string; destinationPath: string };
export type RenamePlanStep = { id: string; from: string; to: string; temporary: boolean };

export function buildCollisionSafeRenamePlan(mappings: RenameMapping[], occupiedPaths: Iterable<string> = []): { steps: RenamePlanStep[]; errors: string[] } {
  const errors: string[] = [];
  const sources = new Set<string>();
  const destinations = new Set<string>();
  const occupied = new Set([...occupiedPaths].map((path) => path.toLowerCase()));
  for (const mapping of mappings) {
    const source = mapping.sourcePath.toLowerCase();
    const destination = mapping.destinationPath.toLowerCase();
    if (sources.has(source)) errors.push(`Duplicate source: ${mapping.sourcePath}`);
    if (destinations.has(destination)) errors.push(`Duplicate destination: ${mapping.destinationPath}`);
    if (source !== destination && occupied.has(destination) && !mappings.some((candidate) => candidate.sourcePath.toLowerCase() === destination)) {
      errors.push(`Destination is occupied by an unrelated file: ${mapping.destinationPath}`);
    }
    sources.add(source);
    destinations.add(destination);
  }
  if (errors.length) return { steps: [], errors };
  const steps: RenamePlanStep[] = [];
  const remaining = mappings.filter((mapping) => mapping.sourcePath.toLowerCase() !== mapping.destinationPath.toLowerCase());
  const reserved = new Set([...occupied, ...mappings.flatMap((mapping) => [mapping.sourcePath.toLowerCase(), mapping.destinationPath.toLowerCase()])]);
  let temporaryIndex = 0;
  // First move every source to a unique sibling temporary name. This breaks
  // A→B/B→A and larger cycles without overwriting any destination. Temporary
  // names are checked against all known paths too: an unrelated pre-existing
  // `file.mkv.archive-assistant-tmp-0` must not be overwritten accidentally.
  for (const mapping of remaining) {
    let temporaryPath = `${mapping.sourcePath}.archive-assistant-tmp-${temporaryIndex++}`;
    while (reserved.has(temporaryPath.toLowerCase())) {
      temporaryPath = `${mapping.sourcePath}.archive-assistant-tmp-${temporaryIndex++}`;
    }
    reserved.add(temporaryPath.toLowerCase());
    steps.push({ id: mapping.id, from: mapping.sourcePath, to: temporaryPath, temporary: true });
  }
  for (const mapping of remaining) {
    const temporary = steps.find((step) => step.id === mapping.id && step.temporary)!;
    steps.push({ id: mapping.id, from: temporary.to, to: mapping.destinationPath, temporary: false });
  }
  return { steps, errors: [] };
}
