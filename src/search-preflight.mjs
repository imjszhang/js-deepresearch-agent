import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { resolveCliCommand, resolveSpawnTarget, runCommand } from './search-providers/js-eyes/cli-process.mjs';

export const SEARCH_PREFLIGHT_TIMEOUT_MS = 4000;

export async function probeSearchProvider(settings, {
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
  timeoutMs = SEARCH_PREFLIGHT_TIMEOUT_MS,
} = {}) {
  const engine = settings?.search?.engine || 'searxng';
  if (engine === 'local') return { ok: true, engine };
  if (engine === 'js-eyes') {
    return probeJsEyes(settings, { spawnImpl, timeoutMs });
  }
  return probeSearxng(settings, { fetchImpl, timeoutMs });
}

async function probeSearxng(settings, { fetchImpl, timeoutMs }) {
  const baseUrl = settings?.search?.baseUrl || 'http://127.0.0.1:8080';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetchImpl(baseUrl, { method: 'GET', signal: controller.signal });
    return { ok: true, engine: 'searxng' };
  } catch {
    throw new Error(
      `SearXNG is not reachable at ${baseUrl}. Start SearXNG before research.`,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function probeJsEyes(settings, { spawnImpl, timeoutMs }) {
  const serverUrl = settings?.search?.provider?.serverUrl
    || settings?.search?.jsEyesServerUrl
    || '';
  if (serverUrl) {
    try {
      await probeTcp(serverUrl, timeoutMs);
      return { ok: true, engine: 'js-eyes' };
    } catch {
      /* fall through to doctor */
    }
  }
  const cli = settings?.search?.provider?.cli || settings?.search?.jsEyesCli || 'js-eyes';
  try {
    const command = resolveCliCommand(cli);
    const target = resolveSpawnTarget(command, ['doctor', '--json']);
    await runCommand({
      command: target.command,
      args: target.args,
      timeoutMs,
      spawnImpl,
    });
    return { ok: true, engine: 'js-eyes' };
  } catch {
    throw new Error(
      'JS Eyes search is not ready. Run "js-eyes doctor --json" and start `js-eyes server` before research.',
    );
  }
}

function probeTcp(url, timeoutMs) {
  const parsed = new URL(url);
  const port = Number(parsed.port) || (parsed.protocol === 'wss:' ? 443 : 80);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: parsed.hostname, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timeout'));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
