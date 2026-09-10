import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWriteResultFile } from '../../../packages/js-deepresearch-engine/src/research/result-artifacts.mjs';

export const SCHEMA_VERSION = 1;
export const JUDGE_VERSION = 'quality-judge-4';
export const EVALUATION_SCHEMA_VERSION = 2;
export const SCORING_VERSION = 'quality-scoring-2';
export const hash = (value) => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteResultFile(file, JSON.stringify(value, null, 2) + '\n');
}
export function invariant(condition, message) { if (!condition) throw new Error(message); }
export function exactIds(items, ids, key = 'id') {
  invariant(Array.isArray(items) && items.length === ids.length && new Set(items.map(x => x?.[key])).size === ids.length
    && items.every(x => ids.includes(x?.[key])), `Invalid exact ${key} set`);
}
export function span(text, range) {
  invariant(Array.isArray(range) && range.length === 2 && range.every(Number.isInteger)
    && range[0] >= 0 && range[1] > range[0] && range[1] <= text.length, 'Invalid UTF-16 span');
  return text.slice(...range);
}
export function within(root, relative) {
  const file = path.resolve(root, relative);
  invariant(file.startsWith(path.resolve(root) + path.sep), 'Path escapes package');
  if (fs.existsSync(file)) invariant(fs.realpathSync(file).startsWith(fs.realpathSync(root) + path.sep), 'Symlink escapes package');
  return file;
}
export function validateCase(c) {
  invariant(c && /^[a-z0-9-]+$/.test(c.id) && /^[a-z0-9-]+$/.test(c.topicId), 'Invalid case ID');
  invariant(['explicit', 'open'].includes(c.variant) && typeof c.query === 'string' && c.query.trim(), 'Invalid case query');
  invariant(Object.keys(c).every(k => ['id', 'topicId', 'variant', 'query', 'scope', 'language', 'requirements'].includes(k)), 'Private or unknown case field');
  invariant(Array.isArray(c.requirements), 'Missing requirements');
  if (c.variant === 'open') invariant(c.requirements.length === 0, 'Open query cannot have hidden requirements');
  exactIds(c.requirements, [...new Set(c.requirements.map(x => x.id))]);
  for (const req of c.requirements) invariant(span(c.query, req.span) === req.text, 'Requirement differs from original query');
  return c;
}
export function loadSuite(file) {
  const suite = readJson(file);
  invariant(suite.schemaVersion === SCHEMA_VERSION && suite.protocolVersion && suite.cases?.length, 'Invalid suite');
  const cases = suite.cases.map(f => validateCase(readJson(within(path.dirname(file), f))));
  exactIds(cases, [...new Set(cases.map(c => c.id))]);
  invariant(Number.isInteger(suite.repeats) && suite.repeats > 0, 'Invalid repeats');
  return { ...suite, cases, suiteHash: hash({ ...suite, cases }) };
}
export function loadGold(root, topicId) {
  const g = readJson(within(root, `${topicId}.json`));
  invariant(g.schemaVersion === SCHEMA_VERSION && g.topicId === topicId && g.rubricVersion, 'Invalid rubric');
  invariant(['agent_verified', 'human_verified'].includes(g.reviewStatus), 'Unverified rubric');
  invariant(Array.isArray(g.criteria) && g.criteria.length > 0, 'Empty rubric');
  exactIds(g.criteria, [...new Set(g.criteria.map(x => x.id))]);
  const sources = new Map();
  for (const source of g.sources) {
    invariant(!sources.has(source.id), 'Duplicate gold source');
    const text = fs.readFileSync(within(root, source.bodyFile), 'utf8');
    invariant(hash(text) === source.bodyHash, 'Gold body hash mismatch');
    sources.set(source.id, { ...source, text });
  }
  for (const criterion of g.criteria) {
    invariant(typeof criterion.expectedAnswer === 'string' && criterion.expectedAnswer && [1, 2].includes(criterion.weight)
      && typeof criterion.critical === 'boolean' && typeof criterion.core === 'boolean' && criterion.anchors?.length, 'Incomplete criterion');
    invariant(Array.isArray(criterion.qualifiers) && Array.isArray(criterion.commonErrors) && criterion.reviewRecord, 'Missing criterion review');
    for (const a of criterion.anchors) {
      invariant(sources.has(a.sourceId), 'Unknown gold source');
      invariant(hash(span(sources.get(a.sourceId).text, a.span)) === a.textHash, 'Gold anchor hash mismatch');
    }
  }
  return { ...g, sources: [...sources.values()], goldHash: hash(g) };
}
export function validateGoldForCase(gold, c) {
  invariant(gold.topicId === c.topicId, 'Gold topic differs from case');
  if (c.variant === 'explicit') {
    const ids = c.requirements.map(r => r.id);
    invariant(gold.criteria.every(r => Array.isArray(r.requirementIds) && r.requirementIds.every(id => ids.includes(id))), 'Unknown explicit requirement in gold');
    invariant(ids.every(id => gold.criteria.some(r => r.requirementIds.includes(id))), 'Unmapped explicit requirement');
  }
}
