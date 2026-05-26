function yamlValue(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return value.map((item) => `  - ${yamlScalar(item)}`).join('\n');
  }
  return yamlScalar(value);
}

function yamlScalar(value) {
  const str = String(value);
  if (/[:#\[\]{}&*!|>'"%@`]/.test(str) || str.includes('\n')) {
    return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return str;
}

export function frontmatter(object = {}) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(object)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - ${yamlScalar(item)}`);
      }
    } else {
      lines.push(`${key}: ${yamlValue(value)}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}
