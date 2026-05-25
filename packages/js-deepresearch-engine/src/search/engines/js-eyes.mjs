import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SEARCH_CAPABILITIES } from '../search-capabilities.mjs';

const DEFAULT_CLI = 'js-eyes';
const DEFAULT_SKILL = 'js-zhihu-ops-skill';
const DEFAULT_MAX_PAGES = 1;
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_OUTPUT_CHARS = 1024 * 1024;

export function parseJsEyesSkills(value) {
  const rawValues = Array.isArray(value)
    ? value
    : String(value || '').split(/[,;\s]+/);

  const skills = [];
  const seen = new Set();

  for (const entry of rawValues) {
    const skill = String(entry || '').trim();
    if (!skill || seen.has(skill)) continue;
    seen.add(skill);
    skills.push(skill);
  }

  return skills.length ? skills : [DEFAULT_SKILL];
}

export function resolveJsEyesSkills(config = {}) {
  if (Array.isArray(config.jsEyesSkills) && config.jsEyesSkills.length > 0) {
    return parseJsEyesSkills(config.jsEyesSkills);
  }
  if (config.jsEyesSkill) {
    return parseJsEyesSkills(config.jsEyesSkill);
  }
  return [DEFAULT_SKILL];
}

export class JsEyesCliSearchEngine {
  constructor(config = {}, options = {}) {
    this.config = config;
    this.spawn = options.spawn || spawn;
    this.capabilities = {
      ...DEFAULT_SEARCH_CAPABILITIES,
      maxQuestionConcurrency: 1,
      ...(options.capabilities || {}),
    };
  }

  async search(query, { signal } = {}) {
    const trimmedQuery = String(query || '').trim();
    if (!trimmedQuery) return [];

    const { command, args } = this.buildCommand(trimmedQuery);
    const spawnTarget = resolveSpawnTarget(command, args);
    const result = await runCommand({
      command: spawnTarget.command,
      args: spawnTarget.args,
      signal,
      timeoutMs: normalizePositiveNumber(this.config.jsEyesTimeoutMs, DEFAULT_TIMEOUT_MS),
      spawnImpl: this.spawn,
    });

    const payload = parseJsonOutput(result.stdout, result.stderr);
    if (!payload || payload.ok === false) {
      throw new Error(formatPayloadError(payload, result));
    }

    return normalizeUnifiedItems(payload, this.config);
  }

  buildCommand(query) {
    const command = resolveCliCommand(this.config.jsEyesCli || DEFAULT_CLI);
    const skills = resolveJsEyesSkills(this.config);
    const maxResults = normalizePositiveNumber(this.config.maxResults, 8);
    const maxPages = normalizePositiveNumber(this.config.jsEyesMaxPages, DEFAULT_MAX_PAGES);

    const args = [
      'search',
      query,
      '--skills',
      skills.join(','),
      '--max-results',
      String(maxResults),
      '--json',
    ];

    if (maxPages) {
      args.push('--max-pages', String(maxPages));
    }

    const serverUrl = this.config.jsEyesServerUrl;
    if (serverUrl) {
      args.push('--server', String(serverUrl));
    }

    const timeoutMs = normalizePositiveNumber(this.config.jsEyesTimeoutMs, DEFAULT_TIMEOUT_MS);
    if (timeoutMs) {
      args.push('--timeout-ms', String(timeoutMs));
    }

    for (const [key, value] of Object.entries(this.config.jsEyesArgs || {})) {
      appendFlag(args, key, value);
    }

    return { command, args };
  }
}

export function mergeSkillResults(batches, maxResults) {
  const merged = [];
  const seenUrls = new Set();
  const indices = batches.map(() => 0);
  let hasMore = batches.some((batch) => batch.length > 0);

  while (hasMore && merged.length < maxResults) {
    hasMore = false;

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const batch = batches[batchIndex];
      while (indices[batchIndex] < batch.length) {
        const source = batch[indices[batchIndex]];
        indices[batchIndex] += 1;

        const url = String(source.url || '').trim();
        if (url && seenUrls.has(url)) {
          continue;
        }
        if (url) {
          seenUrls.add(url);
        }

        merged.push(source);
        if (merged.length >= maxResults) {
          return merged;
        }
        break;
      }

      if (indices[batchIndex] < batch.length) {
        hasMore = true;
      }
    }
  }

  return merged;
}

function normalizeUnifiedItems(payload, config = {}) {
  return (Array.isArray(payload.items) ? payload.items : [])
    .map((item) => ({
      title: firstString(item.title, item.url, 'Untitled source'),
      url: firstString(item.url, item.link, item.href),
      snippet: firstString(item.snippet, item.excerpt, item.desc, item.description, item.content),
      engine: firstString(item.engine, item.platform ? `js-eyes:${item.platform}` : 'js-eyes'),
    }))
    .filter((item) => item.url || item.snippet)
    .slice(0, normalizePositiveNumber(config.maxResults, 8));
}

function formatPayloadError(payload, result) {
  const detail = describePayloadError(payload)
    || summarize(result.stderr)
    || 'Unknown JS Eyes failure';
  return `JS Eyes search failed: ${detail}. Run "js-eyes doctor --json" for diagnostics.`;
}

function describePayloadError(payload) {
  const err = payload?.error;
  if (typeof err === 'string') return err;
  if (!err || typeof err !== 'object') return '';

  const parts = [
    err.message,
    err.code,
    err.detail?.reason,
    err.detail?.hint,
  ].filter(Boolean);

  return parts.join(': ');
}

function runCommand({ command, args, signal, timeoutMs, spawnImpl }) {
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

function parseJsonOutput(stdout, stderr) {
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

function appendFlag(args, key, value) {
  if (value === undefined || value === null || value === false || value === '') return;

  const flag = `--${camelToKebab(key)}`;
  if (value === true) {
    args.push(flag);
    return;
  }
  args.push(flag, String(value));
}

function camelToKebab(value) {
  return String(value).replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

function normalizePositiveNumber(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

function firstString(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
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
