import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  readArtifactManifest,
  providerMetadata,
  searchEngineMetadata,
  strategyMetadata,
} from 'js-deepresearch-engine';
import { createServices } from '../bootstrap.mjs';
import { registerWikiRoutes } from './wiki-routes.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(db) {
  const app = express();
  const {
    settingsStore,
    researchRepository,
    logRepository,
    sourceRepository,
    eventBus,
    jobRunner,
  } = createServices(db);

  app.locals.services = {
    settingsStore,
    researchRepository,
    logRepository,
    sourceRepository,
    eventBus,
    jobRunner,
  };

  app.use(express.json({ limit: '1mb' }));

  app.get('/api/settings', (_req, res) => {
    res.json(settingsStore.get());
  });

  app.put('/api/settings', (req, res) => {
    res.json(settingsStore.save(req.body || {}));
  });

  app.get('/api/providers', (_req, res) => {
    res.json(providerMetadata);
  });

  app.get('/api/search-engines', (_req, res) => {
    res.json(searchEngineMetadata);
  });

  app.get('/api/strategies', (_req, res) => {
    res.json(strategyMetadata);
  });

  app.post('/api/research', (req, res) => {
    const query = String(req.body?.query || '').trim();
    if (!query) {
      res.status(400).json({ error: 'Query is required.' });
      return;
    }

    try {
      const record = jobRunner.start({
        query,
        planningContext: req.body?.planningContext,
        overrides: req.body?.settings || {},
      });
      res.status(202).json(record);
    } catch (error) {
      res.status(error instanceof TypeError ? 400 : 500).json({ error: error.message });
    }
  });

  app.get('/api/research/:id', (req, res) => {
    const record = researchRepository.get(req.params.id);
    if (!record) {
      res.status(404).json({ error: 'Research not found.' });
      return;
    }
    let committed = {};
    if (record.resultManifestPath) {
      try {
        const artifacts = readArtifactManifest(record.sessionDir, record.resultManifestPath);
        if (artifacts.resultRevision !== record.resultRevision) throw new Error('Revision mismatch');
        committed = { citationRegistry: artifacts.citationsPath ? JSON.parse(fs.readFileSync(artifacts.citationsPath, 'utf8')) : null,
          evidenceUrl: artifacts.evidencePath ? `/api/research/${encodeURIComponent(record.id)}/evidence` : null, integrityStatus: 'verified' };
      } catch {
        res.status(503).json({ error: 'Committed result artifacts failed integrity verification.', code: 'RESULT_INTEGRITY' });
        return;
      }
    }
    res.json({
      ...record,
      ...committed,
      logs: logRepository.list(req.params.id),
      sources: sourceRepository.list(req.params.id),
    });
  });

  app.get('/api/research/:id/evidence', (req, res) => {
    const record = researchRepository.get(req.params.id);
    if (!record?.resultManifestPath) return res.status(404).json({ error: 'Evidence not found.' });
    try {
      const artifacts = readArtifactManifest(record.sessionDir, record.resultManifestPath);
      if (artifacts.resultRevision !== record.resultRevision) throw new Error('Revision mismatch');
      if (!artifacts.evidencePath) return res.status(404).json({ error: 'No separate evidence appendix for this legacy result.' });
      res.type('text/markdown').attachment('evidence.md').send(fs.readFileSync(artifacts.evidencePath, 'utf8'));
    } catch {
      res.status(503).json({ error: 'Committed evidence failed integrity verification.', code: 'RESULT_INTEGRITY' });
    }
  });

  app.get('/api/research/:id/events', (req, res) => {
    const record = researchRepository.get(req.params.id);
    if (!record) {
      res.status(404).end();
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    writeSse(res, 'status', record);
    for (const log of logRepository.list(req.params.id)) {
      writeSse(res, 'log', log);
    }

    const unsubscribe = eventBus.subscribe(req.params.id, (event) => {
      writeSse(res, event.type, event.data);
    });

    req.on('close', unsubscribe);
  });

  app.post('/api/research/:id/cancel', (req, res) => {
    const cancelled = jobRunner.cancel(req.params.id);
    res.json({ cancelled });
  });

  app.get('/api/history', (_req, res) => {
    res.json(researchRepository.list());
  });

  app.delete('/api/history/:id', (req, res) => {
    res.json({ deleted: researchRepository.delete(req.params.id) });
  });

  registerWikiRoutes(app, { settingsStore });

  const distPath = path.resolve(__dirname, '../../dist');
  app.use(express.static(distPath));
  app.use((req, res, next) => {
    if (req.path.startsWith('/api')) {
      next();
      return;
    }
    res.sendFile(path.join(distPath, 'index.html'));
  });

  return app;
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
