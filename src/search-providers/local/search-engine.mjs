import fs from 'node:fs';
import path from 'node:path';
import { mergeSkillResults } from '../js-eyes/merge-results.mjs';
import {
  LOCAL_SEARCH_PREVIEW_CHARS,
  LOCAL_SEARCH_SNIPPET_CHARS,
  TEXT_SEARCH_EXTENSIONS,
} from './defaults.mjs';
import { normalizeLocalSearchConfig } from './normalize-config.mjs';
import {
  directoryLabel,
  extensionOf,
  isAbortError,
  isPathInsideRoot,
  resolveCorpusRoot,
  throwIfAborted,
  toFileUrl,
} from './paths.mjs';

export class LocalDirectorySearchEngine {
  constructor(config = {}, options = {}) {
    this.config = normalizeLocalSearchConfig(config);
    this.fs = options.fs || fs;
    this.capabilities = { ...(options.capabilities || {}) };
    this.lastChannelDiagnostics = [];
  }

  async search(query, { signal } = {}) {
    const trimmedQuery = String(query || '').trim();
    if (!trimmedQuery) return [];

    const dirs = this.config.local?.dirs || [];
    if (dirs.length === 0) {
      throw new Error(
        'Local search failed: no corpus directories configured. Use --corpus-dirs or search.local.dirs.',
      );
    }

    const maxResults = Math.max(1, Number(this.config.maxResults) || 8);
    const labels = new Set();
    const batches = [];
    const failures = [];
    const diagnostics = [];

    for (const dir of dirs) {
      throwIfAborted(signal);
      const label = directoryLabel(dir, labels);
      try {
        const results = await searchDirectoryChannel({
          dir,
          label,
          query: trimmedQuery,
          config: this.config,
          maxResults,
          signal,
          fsImpl: this.fs,
        });
        batches.push(results);
        diagnostics.push({
          channel: label,
          dir,
          status: 'ok',
          resultCount: results.length,
        });
      } catch (error) {
        if (isAbortError(error)) throw error;
        const message = error?.message || 'Directory search failed';
        failures.push({ channel: label, dir, error: message });
        diagnostics.push({
          channel: label,
          dir,
          status: 'failed',
          resultCount: 0,
          error: message,
        });
      }
    }

    this.lastChannelDiagnostics = diagnostics;

    if (batches.length === 0) {
      const details = failures.map((item) => `${item.channel}: ${item.error}`).join('; ');
      throw new Error(`Local search failed for all directories: ${details}`);
    }

    return mergeSkillResults(batches, maxResults);
  }
}

export async function searchDirectoryChannel({
  dir,
  label,
  query,
  config,
  maxResults,
  signal,
  fsImpl = fs,
}) {
  throwIfAborted(signal);
  const rootReal = await resolveCorpusRoot(dir, fsImpl);
  const files = await enumerateCorpusFiles({
    root: rootReal,
    ignore: config.local.ignore,
    extensions: config.local.extensions,
    signal,
    fsImpl,
  });

  const tokens = tokenizeQuery(query);
  const hits = [];

  for (const file of files) {
    throwIfAborted(signal);
    const scored = await scoreCorpusFile({
      file,
      tokens,
      query,
      fsImpl,
    });
    if (scored.score <= 0) continue;
    hits.push({
      ...file,
      ...scored,
    });
  }

  hits.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.relativePath.localeCompare(right.relativePath);
  });

  return hits.slice(0, maxResults).map((hit) => ({
    title: path.basename(hit.path),
    url: toFileUrl(hit.path),
    snippet: hit.snippet,
    engine: `local:${label}`,
    corpusRoot: rootReal,
    relativePath: hit.relativePath,
    channel: label,
  }));
}

export async function enumerateCorpusFiles({
  root,
  ignore = [],
  extensions = [],
  signal,
  fsImpl = fs,
}) {
  const ignoreSet = new Set(ignore);
  const extSet = new Set(extensions.map((item) => String(item).toLowerCase().replace(/^\./, '')));
  const files = [];
  const visited = new Set();

  async function walk(current) {
    throwIfAborted(signal);
    let realCurrent;
    try {
      realCurrent = await fsImpl.promises.realpath(current);
    } catch {
      return;
    }
    if (visited.has(realCurrent)) return;
    if (realCurrent !== root && !isPathInsideRoot(realCurrent, root)) return;
    visited.add(realCurrent);
    let entries;
    try {
      entries = await fsImpl.promises.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      throwIfAborted(signal);
      if (ignoreSet.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      let lstat;
      try {
        lstat = await fsImpl.promises.lstat(full);
      } catch {
        continue;
      }

      if (lstat.isSymbolicLink()) {
        let real;
        try {
          real = await fsImpl.promises.realpath(full);
        } catch {
          continue;
        }
        if (!isPathInsideRoot(real, root) && real !== root) continue;
        let realStat;
        try {
          realStat = await fsImpl.promises.stat(real);
        } catch {
          continue;
        }
        if (realStat.isDirectory()) {
          if (real === root || isPathInsideRoot(real, root)) {
            await walk(real);
          }
          continue;
        }
        if (realStat.isFile() && extSet.has(extensionOf(real))) {
          files.push({
            path: real,
            relativePath: path.relative(root, real),
          });
        }
        continue;
      }

      if (lstat.isDirectory()) {
        await walk(full);
        continue;
      }

      if (lstat.isFile() && extSet.has(extensionOf(full))) {
        let real;
        try {
          real = await fsImpl.promises.realpath(full);
        } catch {
          continue;
        }
        if (!isPathInsideRoot(real, root)) continue;
        files.push({
          path: real,
          relativePath: path.relative(root, real),
        });
      }
    }
  }

  await walk(root);
  return files;
}

export function tokenizeQuery(query = '') {
  const normalized = String(query || '').normalize('NFKC').toLowerCase().trim();
  if (!normalized) return [];
  const tokens = normalized.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 0);
  const extra = [];
  for (const token of tokens) {
    if (/[\u4e00-\u9fff]/.test(token) && token.length >= 4) {
      for (let index = 0; index <= token.length - 2; index += 1) {
        extra.push(token.slice(index, index + 2));
      }
    }
  }
  return [...new Set([normalized, ...tokens, ...extra])];
}

async function scoreCorpusFile({ file, tokens, query, fsImpl }) {
  const fileName = path.basename(file.path);
  const relativePath = String(file.relativePath || '').replaceAll('\\', '/');
  const segments = relativePath.split('/').filter(Boolean);
  const hayName = fileName.toLowerCase();
  let preview = '';
  const ext = extensionOf(file.path);
  if (TEXT_SEARCH_EXTENSIONS.includes(ext)) {
    preview = await readTextPreview(file.path, fsImpl);
  }

  let score = 0;
  const matched = [];
  let reason = 'path match';

  for (const token of tokens) {
    if (!token) continue;
    if (hayName.includes(token)) {
      score += 5;
      matched.push(token);
      reason = 'filename match';
    }
    if (segments.some((segment) => segment.toLowerCase().includes(token))) {
      score += 3;
      if (!matched.includes(token)) matched.push(token);
      if (reason !== 'filename match') reason = 'path match';
    }
    if (preview && preview.toLowerCase().includes(token)) {
      score += 1;
      if (!matched.includes(token)) matched.push(token);
      if (reason === 'path match' && !hayName.includes(token)) reason = 'content match';
    }
  }

  if (score <= 0 && String(query || '').trim()) {
    return { score: 0, snippet: '', matched: [] };
  }

  return {
    score,
    matched,
    snippet: buildSnippet({
      relativePath,
      preview,
      matched,
      reason,
    }),
  };
}

async function readTextPreview(filePath, fsImpl) {
  try {
    const text = await fsImpl.promises.readFile(filePath, 'utf8');
    return String(text || '').slice(0, LOCAL_SEARCH_PREVIEW_CHARS);
  } catch {
    return '';
  }
}

function buildSnippet({ relativePath, preview, matched, reason }) {
  const text = String(preview || '');
  const lower = text.toLowerCase();
  for (const token of matched) {
    const index = lower.indexOf(String(token).toLowerCase());
    if (index < 0) continue;
    const start = Math.max(0, index - 80);
    const end = Math.min(text.length, index + String(token).length + LOCAL_SEARCH_SNIPPET_CHARS - 80);
    const slice = text.slice(start, end).replace(/\s+/g, ' ').trim();
    if (!slice) continue;
    return `${start > 0 ? '…' : ''}${slice}${end < text.length ? '…' : ''}`;
  }
  return `${relativePath} (${reason})`;
}

