export class ResultCommitService {
  constructor({ db, researchRepository, sourceRepository }) {
    Object.assign(this, { db, researchRepository, sourceRepository });
  }

  commit(id, result, artifacts = null) {
    return this.db.transaction(() => {
      if (!this.researchRepository.get(id)) throw new Error('Research record missing during result commit');
      this.sourceRepository.replaceForResearch(id, result.sources);
      this.db.prepare('UPDATE research_history SET result_revision=?, result_manifest_path=?, delivery_json=NULL WHERE id=?')
        .run(artifacts?.resultRevision || result.resultRevision || null, artifacts?.manifestPath || null, id);
      return this.researchRepository.updateStatus(id, 'completed', {
        report: result.report, quality: result.quality, error: null,
        completedAt: new Date().toISOString(),
      });
    })();
  }
}
