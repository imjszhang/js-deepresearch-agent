import crypto from 'node:crypto';
import { publishResearchArtifacts, writeLegacyArtifactCopies, readArtifactManifest } from 'js-deepresearch-engine';
import { archiveResearchResultSafe } from './storage/intel-store.mjs';
import { ResultCommitService } from './storage/result-commit-service.mjs';

export function deliveryFailure(stage, error, resultRevision = null) {
  // No provider messages, paths, prompts or arbitrary error codes in persisted diagnostics.
  const code = ['EACCES', 'EPERM', 'ENOENT', 'ENOSPC', 'EIO', 'EROFS'].includes(error?.code)
    ? error.code : 'DELIVERY_FAILED';
  return { stage, code, retryable: true, resultRevision };
}

export function recordResearchFailure({ recorder, repository, id, error, cancelled = false }) {
  const status = cancelled ? 'cancelled' : 'failed';
  const failures = [];
  for (const [stage, operation] of [
    ['recorder', () => recorder?.finalize?.(status, { error })],
    ['history', () => id && repository.updateStatus(id, status, {
      error: error.message, completedAt: new Date().toISOString(),
    })],
  ]) {
    try { operation(); } catch (secondary) { failures.push(deliveryFailure(stage, secondary)); }
  }
  if (failures.length && id) {
    try { repository.saveDelivery?.(id, { failures }); } catch { /* other channels already attempted */ }
  }
  return failures;
}

export async function completeResearch({
  id, result, query, strategy, settings, sessionDir, recorder, services,
  saveArtifacts, writeFile, output, signal, onWarning = () => {}, onStatus,
  archive = archiveResearchResultSafe,
}) {
  result.resultRevision ||= crypto.randomUUID();
  const existing = id ? services.researchRepository.get?.(id) : null;
  const alreadyCommitted = existing?.status === 'completed' && existing.resultRevision === result.resultRevision;
  let artifacts = null;
  if (!alreadyCommitted) {
    signal?.throwIfAborted();
    artifacts = sessionDir ? saveArtifacts({
      sessionDir, query, strategy, settings, result, researchId: id, publish: false,
    }) : null;
    signal?.throwIfAborted();
  }
  if (id && !alreadyCommitted) {
    const service = services.resultCommitService || (services.researchRepository.db
      ? new ResultCommitService({ db: services.researchRepository.db, ...services }) : null);
    if (service) service.commit(id, result, artifacts);
    else {
      // Repository adapters without SQLite may supply their own commit service.
      services.sourceRepository.addMany(id, result.sources);
      services.researchRepository.updateStatus(id, 'completed', {
        report: result.report, quality: result.quality, error: null, completedAt: new Date().toISOString(),
      });
    }
  } else if (artifacts) {
    // Without SQLite this atomic pointer is the durable commit point.
    publishResearchArtifacts(artifacts);
  }

  // All operations after the core commit are isolated. Never throw into a research-failure handler.
  const delivery = { resultRevision: result.resultRevision, completed: [], failures: [] };
  const attempt = async (stage, operation) => {
    try { await operation(); delivery.completed.push(stage); } catch (error) {
      const diagnostic = deliveryFailure(stage, error, result.resultRevision);
      delivery.failures.push(diagnostic);
      try { onWarning(diagnostic); } catch { /* notification cannot invalidate the result */ }
    }
  };
  if (alreadyCommitted && sessionDir) await attempt('prepare', () => {
    artifacts = existing.resultManifestPath
      ? readArtifactManifest(sessionDir, existing.resultManifestPath)
      : saveArtifacts({ sessionDir, query, strategy, settings, result, researchId: id, publish: false });
  });
  if (id && artifacts) await attempt('publish', () => publishResearchArtifacts(artifacts));
  if (artifacts) await attempt('compatibility', () => writeLegacyArtifactCopies(artifacts));
  await attempt('recorder', () => recorder?.finalize?.('completed', { ...(artifacts ? { artifacts } : {}), resultRevision: result.resultRevision }));
  const archiveDone = alreadyCommitted && existing.delivery?.resultRevision === result.resultRevision
    && existing.delivery?.completed?.includes('archive');
  if (archiveDone) delivery.completed.push('archive');
  else if (id && (!sessionDir || artifacts)) await attempt('archive', async () => {
    const outcome = await archive({ researchId: id, query, strategy, result, artifacts, settings });
    if (!outcome?.ok) throw new Error('Archive incomplete');
  });
  if (output) await attempt('output', () => writeFile(output, result.report, 'utf8'));
  if (onStatus) await attempt('notification', () => onStatus({ ...services.researchRepository.get(id), delivery }));
  await attempt('delivery-journal', () => recorder?.event?.('delivery_finished', delivery));
  if (id) await attempt('delivery', () => services.researchRepository.saveDelivery?.(id, delivery));
  return { result, artifacts, delivery, exitCode: delivery.failures.some((item) => item.stage === 'output') ? 1 : 0 };
}
