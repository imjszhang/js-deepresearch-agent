import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function isAbortError(error) {
  return error?.name === 'AbortError';
}

export function abortError(message = 'Research aborted') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw abortError();
  }
}

export function expandUserPath(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text === '~') return os.homedir();
  if (text.startsWith('~/') || text.startsWith('~\\')) {
    return path.join(os.homedir(), text.slice(2));
  }
  return text;
}

export function parseCorpusDirList(value) {
  const raw = Array.isArray(value)
    ? value
    : (value === true || value == null || value === ''
      ? []
      : String(value).split(/[,;\n]+/));

  const dirs = [];
  const seen = new Set();
  for (const entry of raw) {
    const expanded = expandUserPath(entry);
    if (!expanded) continue;
    const resolved = path.normalize(path.resolve(expanded));
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    dirs.push(resolved);
  }
  return dirs;
}

export function isFileUrl(value = '') {
  try {
    return new URL(String(value).trim()).protocol === 'file:';
  } catch {
    return false;
  }
}

export function toFileUrl(absolutePath) {
  return pathToFileURL(path.normalize(String(absolutePath))).href;
}

export function fileUrlToFsPath(value = '') {
  try {
    return fileURLToPath(new URL(String(value).trim()));
  } catch {
    return '';
  }
}

export function extensionOf(filePath = '') {
  const ext = path.extname(String(filePath || '')).slice(1).toLowerCase();
  return ext;
}

export function isPathInsideRoot(targetPath, rootPath) {
  const target = path.normalize(String(targetPath || ''));
  const root = path.normalize(String(rootPath || ''));
  if (!target || !root) return false;
  const relative = path.relative(root, target);
  if (!relative) return false;
  if (relative.startsWith('..')) return false;
  if (path.isAbsolute(relative)) return false;
  return true;
}

export function directoryLabel(absolutePath, used = new Set()) {
  const base = path.basename(String(absolutePath || '')) || 'dir';
  let label = base;
  let index = 2;
  while (used.has(label)) {
    label = `${base}-${index}`;
    index += 1;
  }
  used.add(label);
  return label;
}

export async function resolveCorpusRoot(dir, fsImpl = fs) {
  const resolved = path.normalize(path.resolve(expandUserPath(dir)));
  let stat;
  try {
    stat = await fsImpl.promises.stat(resolved);
  } catch (error) {
    const detail = error?.code || error?.message || 'unreadable';
    throw new Error(`Directory not found or unreadable: ${resolved} (${detail})`, { cause: error });
  }
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }
  try {
    await fsImpl.promises.access(resolved, fsImpl.constants?.R_OK ?? fs.constants.R_OK);
  } catch {
    throw new Error(`Directory not readable: ${resolved}`);
  }
  try {
    return await fsImpl.promises.realpath(resolved);
  } catch (error) {
    const detail = error?.code || error?.message || 'unreadable';
    throw new Error(`Directory not readable: ${resolved} (${detail})`, { cause: error });
  }
}

export async function resolveSafeLocalFile(url, rootPaths = [], fsImpl = fs) {
  if (!isFileUrl(url)) {
    return { ok: false, error: 'Not a file:// URL' };
  }

  let requested;
  try {
    requested = path.resolve(fileURLToPath(new URL(String(url).trim())));
  } catch {
    return { ok: false, error: 'Invalid file:// URL' };
  }

  if (requested.includes('\0')) {
    return { ok: false, error: 'Invalid local path' };
  }

  const roots = [];
  for (const root of rootPaths) {
    try {
      const abs = path.normalize(path.resolve(expandUserPath(root)));
      const real = await fsImpl.promises.realpath(abs);
      roots.push({ abs, real });
    } catch {
      // Missing or unreadable corpus roots are ignored for this check.
    }
  }

  if (roots.length === 0) {
    return { ok: false, error: 'No readable corpus directories' };
  }

  const insideConfigured = roots.some(({ abs, real }) => (
    isPathInsideRoot(requested, abs) || isPathInsideRoot(requested, real)
  ));
  if (!insideConfigured) {
    return { ok: false, error: 'Path is outside configured corpus directories' };
  }

  let realFile;
  try {
    realFile = await fsImpl.promises.realpath(requested);
  } catch {
    return { ok: false, error: 'Local file is not readable' };
  }

  if (!roots.some(({ real }) => isPathInsideRoot(realFile, real))) {
    return { ok: false, error: 'Path is outside configured corpus directories' };
  }

  let stat;
  try {
    stat = await fsImpl.promises.stat(realFile);
  } catch {
    return { ok: false, error: 'Local file is not readable' };
  }
  if (!stat.isFile()) {
    return { ok: false, error: 'Local path is not a file' };
  }

  return { ok: true, path: realFile };
}
