import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_CLI, MAX_OUTPUT_CHARS } from './constants.mjs';

export function isAbortError(error) {
  return error?.name === 'AbortError';
}

export function killProcessTree(pid, options = {}) {
  if (!pid) return;

  const platform = options.platform ?? process.platform;
  const killImpl = options.killProcessTreeImpl ?? defaultKillProcessTree;
  killImpl(pid, platform);
}

export function runCommand({
  command,
  args,
  signal,
  timeoutMs,
  spawnImpl,
  platform = process.platform,
  killProcessTreeImpl,
}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    let settled = false;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;

    function settle(fn, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      fn(value);
    }

    function killChild() {
      if (child && !child.killed) {
        child.kill();
        killProcessTree(child.pid, { platform, killProcessTreeImpl });
      }
    }

    function onAbort() {
      killChild();
      settle(reject, abortError());
    }

    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killChild();
        }, timeoutMs)
      : null;

    try {
      child = spawnImpl(command, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      settle(reject, new Error(`Failed to start JS Eyes CLI: ${error.message}`));
      return;
    }

    signal?.addEventListener?.('abort', onAbort, { once: true });

    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on?.('data', (chunk) => {
      stdout = appendOutput(stdout, chunk);
    });
    child.stderr?.on?.('data', (chunk) => {
      stderr = appendOutput(stderr, chunk);
    });
    child.on?.('error', (error) => {
      settle(reject, new Error(`JS Eyes CLI failed to start: ${error.message}`));
    });
    child.on?.('close', (code, signalName) => {
      if (timedOut) {
        settle(reject, new Error(`JS Eyes search timed out after ${timeoutMs}ms. Run "js-eyes doctor --json" for diagnostics.`));
        return;
      }
      if (code !== 0) {
        const detail = summarize(stderr || stdout || signalName || 'no output');
        settle(reject, new Error(`JS Eyes search exited with code ${code}: ${detail}. Run "js-eyes doctor --json" for diagnostics.`));
        return;
      }
      settle(resolve, { stdout, stderr });
    });
  });
}

export function parseJsonOutput(stdout, stderr) {
  const text = String(stdout || '').trim();
  if (!text) {
    throw new Error(`JS Eyes search returned empty stdout${stderr ? `: ${summarize(stderr)}` : ''}`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`JS Eyes search returned invalid JSON: ${error.message}. stdout=${summarize(text)}`, { cause: error });
  }
}

export function formatPayloadError(payload, result) {
  const detail = describePayloadError(payload)
    || summarize(result.stderr)
    || 'Unknown JS Eyes failure';
  return `JS Eyes search failed: ${detail}. Run "js-eyes doctor --json" for diagnostics.`;
}

function describePayloadError(payload) {
  const err = payload?.error;
  if (typeof err === 'string') return err;
  if (!err || typeof err !== 'object') return '';

  return [
    err.message,
    err.code,
    err.detail?.reason,
    err.detail?.hint,
  ].filter(Boolean).join(': ');
}

export function resolveCliCommand(command, options = {}) {
  const value = String(command || DEFAULT_CLI);
  const platform = options.platform ?? process.platform;
  const pathValue = options.pathValue ?? process.env.PATH ?? '';

  if (path.isAbsolute(value)) {
    return resolveAbsoluteExecutable(value, platform);
  }

  return lookupExecutableInPath(value, pathValue, platform) || value;
}

export function resolveSpawnTarget(command, args, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    return {
      command: options.comSpec || process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', command, ...args],
    };
  }
  return { command, args };
}

export function appendFlag(args, key, value) {
  if (value === undefined || value === null || value === false || value === '') return;

  const flag = key.startsWith('--') ? key : `--${camelToKebab(key)}`;
  if (value === true) {
    args.push(flag);
    return;
  }
  args.push(flag, String(value));
}

function resolveAbsoluteExecutable(filePath, platform) {
  if (fileExists(filePath)) return filePath;
  if (platform === 'win32' && !path.extname(filePath)) {
    for (const ext of ['.cmd', '.exe', '.bat']) {
      const candidate = `${filePath}${ext}`;
      if (fileExists(candidate)) return candidate;
    }
  }
  return filePath;
}

function lookupExecutableInPath(name, pathValue, platform) {
  const dirs = pathValue.split(path.delimiter).filter(Boolean);
  if (platform === 'win32') {
    const extensions = path.extname(name) ? [''] : ['.cmd', '.exe', '.bat', ''];
    for (const dir of dirs) {
      for (const ext of extensions) {
        const candidate = path.join(dir, `${name}${ext}`);
        if (fileExists(candidate)) return candidate;
      }
    }
    return null;
  }

  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return fileExists(filePath);
  }
}

function camelToKebab(value) {
  return String(value).replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

function appendOutput(current, chunk) {
  const next = current + String(chunk || '');
  if (next.length <= MAX_OUTPUT_CHARS) return next;
  return next.slice(next.length - MAX_OUTPUT_CHARS);
}

function summarize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 800);
}

function abortError() {
  const error = new Error('JS Eyes search aborted');
  error.name = 'AbortError';
  return error;
}

function defaultKillProcessTree(pid, platform) {
  if (platform !== 'win32') return;

  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch {
    // Ignore taskkill failures during cancellation.
  }
}
