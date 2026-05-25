import { appendFlag } from './cli-process.mjs';

export function buildUnifiedCommand(query, provider) {
  const args = [
    'search',
    query,
    '--skills',
    provider.skills.join(','),
    '--max-results',
    String(provider.maxResults),
    '--json',
  ];

  if (provider.maxPages) {
    args.push('--max-pages', String(provider.maxPages));
  }

  if (provider.serverUrl) {
    args.push('--server', String(provider.serverUrl));
  }

  if (provider.timeoutMs) {
    args.push('--timeout-ms', String(provider.timeoutMs));
  }

  for (const [key, value] of Object.entries(provider.args || {})) {
    appendFlag(args, key, value);
  }

  return args;
}
