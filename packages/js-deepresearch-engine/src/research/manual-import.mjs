import fs from 'node:fs';
import path from 'node:path';
import { hostnameOf, hostnamesMatch } from './adaptive/source-policy.mjs';
import { normalizeCacheUrl } from './content-cache.mjs';

const SOURCE_URL_KEYS = ['sourceUrl', 'source_url', 'canonicalUrl', 'canonical_url'];
const TEXT_EXTENSIONS = new Set(['md', 'txt', 'markdown', 'html', 'htm']);

export function parseSourceUrlFrontMatter(text = '') {
  const raw = String(text || '');
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { sourceUrl: '', body: raw, metadata: {} };
  const metadata = parseSimpleYamlMap(match[1]);
  return {
    sourceUrl: pickSourceUrl(metadata),
    body: match[2],
    metadata,
  };
}

function parseSimpleYamlMap(block = '') {
  const metadata = {};
  for (const line of String(block).split(/\r?\n/)) {
    const item = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!item) continue;
    metadata[item[1]] = String(item[2] || '').trim().replace(/^['"]|['"]$/g, '');
  }
  return metadata;
}

function pickSourceUrl(record = {}) {
  for (const key of SOURCE_URL_KEYS) {
    const value = String(record[key] || '').trim();
    if (value) return value;
  }
  return '';
}

export function readManualImportSidecar(filePath, fsImpl = fs) {
  const candidates = [
    `${filePath}.meta.json`,
    filePath.replace(/(\.[^.]+)$/, '.meta.json'),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(candidate, 'utf8'));
      const sourceUrl = pickSourceUrl(parsed || {});
      if (sourceUrl) {
        return { sourceUrl, sidecarPath: candidate, metadata: parsed };
      }
    } catch {
      // Missing or invalid sidecar is not fatal.
    }
  }
  return { sourceUrl: '', sidecarPath: null, metadata: {} };
}

function extensionOf(filePath = '') {
  return path.extname(String(filePath || '')).slice(1).toLowerCase();
}

function walkFiles(root, fsImpl, files = []) {
  let entries = [];
  try {
    entries = fsImpl.readdirSync(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.DS_Store') continue;
    if (entry.isDirectory()) {
      walkFiles(full, fsImpl, files);
      continue;
    }
    if (entry.isFile()) files.push(full);
  }
  return files;
}

function inspectManualFile(filePath, fsImpl) {
  const sidecar = readManualImportSidecar(filePath, fsImpl);
  const ext = extensionOf(filePath);
  if (!TEXT_EXTENSIONS.has(ext)) {
    return sidecar.sourceUrl ? { filePath, ...sidecar, body: null } : null;
  }
  let text = '';
  try {
    text = fsImpl.readFileSync(filePath, 'utf8');
  } catch {
    return sidecar.sourceUrl ? { filePath, ...sidecar, body: null } : null;
  }
  const front = parseSourceUrlFrontMatter(text);
  const sourceUrl = sidecar.sourceUrl || front.sourceUrl;
  if (!sourceUrl) return null;
  return {
    filePath,
    sourceUrl,
    body: front.body,
    sidecarPath: sidecar.sidecarPath,
    metadata: { ...front.metadata, ...sidecar.metadata },
  };
}

export function indexManualImports(dirs = [], fsImpl = fs) {
  const index = new Map();
  for (const dir of dirs || []) {
    const root = path.resolve(String(dir || ''));
    for (const filePath of walkFiles(root, fsImpl)) {
      const record = inspectManualFile(filePath, fsImpl);
      if (!record?.sourceUrl) continue;
      index.set(normalizeCacheUrl(record.sourceUrl), record);
    }
  }
  return index;
}

export function lookupManualImport(url, context = {}) {
  const dirs = context.settings?.search?.local?.dirs || [];
  if (!dirs.length) return null;
  const fsImpl = context.fs || fs;
  const cache = context.manualImportIndex || indexManualImports(dirs, fsImpl);
  if (context && !context.manualImportIndex) context.manualImportIndex = cache;
  return cache.get(normalizeCacheUrl(url)) || null;
}

export function manualImportResult(record, extras = {}) {
  const content = String(extras.content ?? record?.body ?? '').trim();
  if (!content) {
    return {
      status: 'failed',
      error: 'Empty manual import',
      retrievedVia: 'manual_import',
      backend: 'local-file',
      sourceUrl: record?.sourceUrl || null,
      manualImportPath: record?.filePath || null,
    };
  }
  return {
    status: 'ok',
    title: extras.title || path.basename(record?.filePath || 'manual-import'),
    content,
    retrievedVia: 'manual_import',
    retrievedAt: extras.retrievedAt || new Date().toISOString(),
    backend: 'local-file',
    retrievalPath: 'manual_import',
    sourceUrl: record.sourceUrl,
    finalUrl: record.sourceUrl,
    manualImportPath: record.filePath,
    evidenceRole: 'body',
    accessStatus: 'ok',
  };
}

export function collectManualImportHints({
  gaps = [],
  readiness = null,
  findings = [],
  corpusDirs = [],
} = {}) {
  const hosts = [];
  const seen = new Set();
  for (const gap of gaps || []) {
    for (const host of gap.requiredHosts || []) {
      const key = String(host || '').toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      hosts.push(host);
    }
  }
  for (const failure of readiness?.failures || []) {
    if (failure.code !== 'required_host_missing') continue;
    for (const item of failure.hostDiagnostics || []) {
      const key = String(item.host || '').toLowerCase();
      if (!key || seen.has(key)) continue;
      if (item.reason === 'body_rejected') continue;
      seen.add(key);
      hosts.push(item.host);
    }
  }
  for (const finding of findings || []) {
    for (const source of finding.sources || []) {
      if (source.fetchStatus === 'ok' || source.retrievedVia === 'manual_import') continue;
      const host = hostnameOf(source.sourceUrl || source.url || source.id);
      if (!host || seen.has(host)) continue;
      if (!(gaps || []).some((gap) => (gap.requiredHosts || []).some((item) => hostnamesMatch(host, item)))) {
        continue;
      }
      seen.add(host);
      hosts.push(host);
    }
  }
  if (!hosts.length) return [];
  const target = corpusDirs[0] || '<corpus-dir>';
  return hosts.map((host) => (
    `Required host ${host} was not retrieved. Save the page as HTML/Markdown/PDF under ${target} with front-matter or sidecar sourceUrl, then rerun with --corpus-dirs.`
  ));
}
