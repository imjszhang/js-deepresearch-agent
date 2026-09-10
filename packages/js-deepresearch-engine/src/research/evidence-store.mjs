import { createHash } from 'node:crypto';
import { normalizeSourceUrl } from './source-candidates.mjs';
import { isSuccessfulBody } from './body-quality.mjs';
import { PASSAGE_CHUNKING_VERSION, splitContentForPassages } from './passage-utils.mjs';

const hash = (value) => createHash('sha256').update(String(value)).digest('hex');
const id = (prefix, values) => `${prefix}-${hash(JSON.stringify(values)).slice(0, 24)}`;
const verdicts = new Set(['not_checked', 'checked_without_support', 'supported', 'contradicted']);
function integrity(message) { const error = new Error(message); error.code = 'EVIDENCE_INTEGRITY'; throw error; }

export class EvidenceStore {
  constructor(snapshot = null) {
    this.documents = new Map();
    this.versions = new Map();
    this.bodies = new Map();
    this.passages = new Map();
    this.associations = new Map();
    this.inspections = new Map();
    if (snapshot) this.restore(snapshot);
  }

  register(source, taskId = null) {
    if (source.documentVersionId) {
      const version = this.versions.get(source.documentVersionId);
      if (!version) integrity('Missing document version.');
      if (source.content && hash(source.content) !== version.bodyHash) integrity('Document version body changed.');
      if (taskId) this.associate(taskId, version.documentVersionId, source);
      return version;
    }
    if (!isSuccessfulBody({ ...source, assessment: null }) || !source.content || ['metadata', 'snippet', 'summary'].includes(source.contentOrigin)
      || (source.fetchStatus !== 'ok' && !['fetched', 'provided', 'local'].includes(source.contentOrigin))) return null;
    const body = String(source.content);
    const canonicalUrl = normalizeSourceUrl(source.finalUrl || source.url) || String(source.id || '');
    const sourceId = `source-${hash(canonicalUrl).slice(0, 16)}`;
    const bodyHash = hash(body);
    const extractionVersion = source.extractionVersion || 'extracted-text-v1';
    const documentVersionId = id('document', [sourceId, bodyHash, extractionVersion]);
    const aliases = [...new Set([source.originalUrl, source.url, source.finalUrl].filter(Boolean))];
    const old = this.documents.get(sourceId);
    this.documents.set(sourceId, { sourceId, canonicalUrl, redirectAliases: [...new Set([...(old?.redirectAliases || []), ...aliases])] });
    if (!this.versions.has(documentVersionId)) {
      this.bodies.set(bodyHash, body);
      this.versions.set(documentVersionId, Object.freeze({ documentVersionId, sourceId, bodyHash,
        bodyRef: `evidence-bodies/${bodyHash}.txt`, extractionVersion,
        retrievedAt: source.retrievedAt || source.fetchedAt || source.accessedAt || null,
        coverage: source.contentTruncated || source.truncated ? 'partial' : 'extracted', evidenceOrigin: 'source_content',
        title: source.title || '', url: canonicalUrl, bodyLength: body.length,
      }));
    }
    if (taskId) this.associate(taskId, documentVersionId, source);
    return this.versions.get(documentVersionId);
  }

  body(documentVersionId) {
    const version = this.versions.get(documentVersionId);
    if (!version || !this.bodies.has(version.bodyHash)) integrity('Unresolved evidence body.');
    return this.bodies.get(version.bodyHash);
  }

  associate(taskId, documentVersionId, source = {}) {
    if (!this.versions.has(documentVersionId)) integrity('Association references an unknown document.');
    const key = id('association', [taskId, documentVersionId]);
    const previous = this.associations.get(key);
    this.associations.set(key, { ...previous, associationId: key, taskId, documentVersionId,
      passageIds: previous?.passageIds || [], relevance: source.relevanceDecision || previous?.relevance || null,
      assessment: source.assessment || previous?.assessment || null, assessmentStatus: source.assessmentStatus || previous?.assessmentStatus || null });
    return this.associations.get(key);
  }

  addPassage(documentVersionId, startChar, endChar, extra = {}) {
    const body = this.body(documentVersionId);
    if (!Number.isInteger(startChar) || !Number.isInteger(endChar) || startChar < 0 || endChar <= startChar || endChar > body.length) integrity('Invalid passage range.');
    const text = body.slice(startChar, endChar);
    const passageId = id('passage', [documentVersionId, startChar, endChar, hash(text)]);
    const version = this.versions.get(documentVersionId);
    if (!this.passages.has(passageId)) this.passages.set(passageId, {
      ...extra, id: passageId, passageId, documentVersionId, sourceId: version.sourceId, url: version.url,
      startChar, endChar, textHash: hash(text), text, evidenceOrigin: 'source_content', neighborIds: [],
    });
    return this.passages.get(passageId);
  }

  chunks(documentVersionId, chunkChars = 2400) {
    const chunks = splitContentForPassages(this.body(documentVersionId), chunkChars)
      .map((chunk) => this.addPassage(documentVersionId, chunk.startChar, chunk.endChar, { section: chunk.section, chunkingVersion: PASSAGE_CHUNKING_VERSION }));
    chunks.forEach((chunk, index) => { chunk.neighborIds = [chunks[index - 1]?.id, chunks[index + 1]?.id].filter(Boolean); });
    return chunks;
  }

  recordInspection({ taskId, questionRevision = 1, criterionRevision = 1, validationProtocolVersion, documentVersionId, passageIds = [], verdict, missingFacets = [] }) {
    if (!verdicts.has(verdict)) integrity('Invalid inspection verdict.');
    const selected = passageIds.map((key) => this.passages.get(key));
    if (selected.some((passage) => !passage || passage.documentVersionId !== documentVersionId)) integrity('Inspection references another document.');
    const identity = [taskId, questionRevision, criterionRevision, documentVersionId, [...passageIds].sort()];
    if (validationProtocolVersion != null) identity.push(validationProtocolVersion);
    const key = id('inspection', identity);
    const inspection = { inspectionId: key, taskId, questionRevision, criterionRevision, documentVersionId,
      ...(validationProtocolVersion != null ? { validationProtocolVersion } : {}),
      checkedRanges: selected.map((passage) => [passage.startChar, passage.endChar]), passageIds, verdict, missingFacets };
    this.inspections.set(key, inspection);
    const association = this.associate(taskId, documentVersionId);
    association.passageIds = [...new Set([...association.passageIds, ...passageIds])];
    return inspection;
  }

  checked(taskId, passage, { questionRevision = 1, criterionRevision = 1, validationProtocolVersion } = {}) {
    return [...this.inspections.values()].some((item) => item.taskId === taskId
      && item.questionRevision === questionRevision && item.criterionRevision === criterionRevision
      && (validationProtocolVersion == null || item.validationProtocolVersion === validationProtocolVersion)
      && item.documentVersionId === passage.documentVersionId && item.verdict !== 'not_checked'
      && item.checkedRanges.some(([start, end]) => start <= passage.startChar && end >= passage.endChar));
  }

  captureFindings(findings) {
    for (const finding of findings) for (const source of finding.sources || []) {
      const version = this.register(source, finding.gapId || finding.contractSlotId || finding.id);
      if (version) {
        source.documentVersionId = version.documentVersionId;
        source.canonicalSourceId = version.sourceId;
        source.bodyRef = version.bodyRef;
        // Compatibility view resolves through the store; it is never a second source of truth.
        Object.defineProperty(source, 'content', { enumerable: true, configurable: true, get: () => this.body(version.documentVersionId) });
      }
    }
    return findings;
  }

  compactFindings(findings) {
    return findings.map((finding) => ({ ...finding, sources: (finding.sources || []).map((source) => {
      const result = { ...source };
      if (result.documentVersionId) delete result.content;
      return result;
    }) }));
  }

  export({ inlineBodies = true } = {}) {
    return { schemaVersion: 1, documents: [...this.documents.values()], versions: [...this.versions.values()],
      passages: [...this.passages.values()], associations: [...this.associations.values()], inspections: [...this.inspections.values()],
      ...(inlineBodies ? { documentsByHash: Object.fromEntries(this.bodies) } : {}) };
  }

  restore(snapshot) {
    if (snapshot.schemaVersion !== 1) integrity('Unsupported evidence schema.');
    this.bodies = new Map(Object.entries(snapshot.documentsByHash || {}));
    for (const [key, body] of this.bodies) if (typeof body !== 'string' || hash(body) !== key) integrity('Evidence body hash mismatch.');
    this.documents = new Map((snapshot.documents || []).map((item) => [item.sourceId, item]));
    if (this.documents.size !== (snapshot.documents || []).length) integrity('Duplicate document identity.');
    for (const document of this.documents.values()) if (document.sourceId !== `source-${hash(document.canonicalUrl).slice(0, 16)}`) integrity('Document identity mismatch.');
    this.versions = new Map((snapshot.versions || []).map((item) => [item.documentVersionId, Object.freeze(item)]));
    for (const version of this.versions.values()) {
      if (version.documentVersionId !== id('document', [version.sourceId, version.bodyHash, version.extractionVersion]) || !this.documents.has(version.sourceId) || version.bodyRef !== `evidence-bodies/${version.bodyHash}.txt`
        || !this.bodies.has(version.bodyHash) || this.body(version.documentVersionId).length !== version.bodyLength) integrity('Invalid document reference.');
    }
    for (const passage of snapshot.passages || []) {
      const actual = this.addPassage(passage.documentVersionId, passage.startChar, passage.endChar, passage);
      if (actual.id !== passage.id || actual.textHash !== passage.textHash || actual.text !== passage.text) integrity('Passage anchor mismatch.');
    }
    for (const passage of snapshot.passages || []) {
      if ((passage.neighborIds || []).some((key) => this.passages.get(key)?.documentVersionId !== passage.documentVersionId)) integrity('Invalid passage neighbor.');
      this.passages.get(passage.id).neighborIds = [...(passage.neighborIds || [])];
    }
    this.associations = new Map((snapshot.associations || []).map((item) => {
      if (!this.versions.has(item.documentVersionId) || item.passageIds.some((key) => this.passages.get(key)?.documentVersionId !== item.documentVersionId)) integrity('Invalid association.');
      return [item.associationId, item];
    }));
    for (const inspection of snapshot.inspections || []) this.recordInspection(inspection);
    return this;
  }
}
