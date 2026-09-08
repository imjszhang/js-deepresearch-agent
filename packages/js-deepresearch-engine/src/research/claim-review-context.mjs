import { tokenOverlapScore } from './passage-utils.mjs';
import { cosineSimilarity } from './providers/openai-embedding-provider.mjs';

// Retrieve counter-check context from bodies already captured by this run. This
// cannot add a source or rescue an unsupported claim with uncited evidence.
export async function selectClaimReviewContext({ graph, store, gaps = [], query = '', embedding = null, signal, topK = 6 } = {}) {
  signal?.throwIfAborted();
  const claims = graph.records.filter(record => !record.premiseOnly);
  const passages = [...store.passages.values()];
  const result = new Map();
  if (!claims.length || !passages.length) return result;
  const questions = claims.map(record => [query, ...graph.bindings.filter(binding => binding.claimId === record.claimId)
    .map(binding => gaps.find(gap => gap.id === binding.taskId)?.question), record.proposition].filter(Boolean).join('\n'));
  let questionVectors = null, passageVectors = null;
  if (embedding?.embedDocuments) {
    try {
      [questionVectors, passageVectors] = await Promise.all([
        embedding.embedDocuments(questions, { signal, purpose: 'evidence_question' }),
        embedding.embedDocuments(passages.map(passage => passage.text), { signal, purpose: 'evidence_passages' }),
      ]);
    } catch (error) {
      if (error.name === 'AbortError' || error.name === 'BudgetExceededError') throw error;
      questionVectors = null; passageVectors = null;
    }
  }
  for (const [index, record] of claims.entries()) {
    const supportIds = new Set(record.supportRefs.map(ref => ref.passageId));
    const supportVersions = new Set(record.supportRefs.map(ref => ref.documentVersionId));
    const ranked = passages.map((passage, passageIndex) => ({ passage,
      score: questionVectors && passageVectors ? cosineSimilarity(questionVectors[index], passageVectors[passageIndex])
        : tokenOverlapScore(questions[index], `${passage.section || ''} ${passage.text}`),
    })).filter(item => !supportIds.has(item.passage.id))
      .sort((a, b) => b.score - a.score || a.passage.id.localeCompare(b.passage.id));
    const selected = [], versions = new Set();
    // First compare independent document versions, then remaining local context.
    for (const { passage } of [...ranked.filter(item => !supportVersions.has(item.passage.documentVersionId)), ...ranked]) {
      if (versions.has(passage.documentVersionId)) continue;
      selected.push(passage); versions.add(passage.documentVersionId);
      if (selected.length >= topK) break;
    }
    result.set(record.claimId, selected);
  }
  return result;
}
