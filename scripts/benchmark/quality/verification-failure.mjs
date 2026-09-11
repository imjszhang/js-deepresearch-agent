const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

// This is a replay coordinate schema, not a serializer for arbitrary errors.
export function safeVerificationFailure(error) {
  for (let depth = 0; error && depth < 3; depth++, error = error.cause) {
    const value = error.verificationFailure;
    if (!value || value.schemaVersion !== 1 || !integer(value.seed, 1, 64) || !integer(value.step, 0, 39)
      || !Array.isArray(value.operations) || value.operations.length !== value.step + 1) continue;
    const operations = [];
    for (let step = 0; step < value.operations.length; step++) {
      const row = value.operations[step];
      if (!row || row.step !== step || !['a', 'b', 'c'].includes(row.item) || !integer(row.version, 0, 2) || !integer(row.op, 0, 6)) break;
      operations.push({ step, item: row.item, version: row.version, op: row.op });
    }
    if (operations.length === value.operations.length) return { schemaVersion: 1, seed: value.seed, step: value.step, operations };
  }
  return undefined;
}
