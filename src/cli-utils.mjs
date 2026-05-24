export function parseArgs(argv) {
  const args = [];
  const flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      args.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      index += 1;
    }
  }

  return { args, flags };
}

export function setDeepValue(object, dottedKey, rawValue) {
  const parts = dottedKey.split('.');
  let cursor = object;
  for (const part of parts.slice(0, -1)) {
    cursor[part] ||= {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = coerceValue(rawValue);
  return object;
}

export function getDeepValue(object, dottedKey) {
  return dottedKey.split('.').reduce((cursor, key) => cursor?.[key], object);
}

export function formatHistory(records) {
  if (records.length === 0) return 'No research history.';
  return records.map((record) => [
    record.id,
    record.status.padEnd(9),
    new Date(record.createdAt).toLocaleString(),
    record.query,
  ].join('  ')).join('\n');
}

function coerceValue(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value !== '' && !Number.isNaN(Number(value))) return Number(value);
  return value;
}
