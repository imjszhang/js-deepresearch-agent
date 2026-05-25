import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  providerMetadata,
  searchEngineMetadata,
  strategyMetadata,
} from 'js-deepresearch-engine';
import { createServices } from '../bootstrap.mjs';

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

    const record = jobRunner.start({
      query,
      overrides: req.body?.settings || {},
    });
    res.status(202).json(record);
  });

  app.get('/api/research/:id', (req, res) => {
    const record = researchRepository.get(req.params.id);
    if (!record) {
      res.status(404).json({ error: 'Research not found.' });
      return;
    }
    res.json({
      ...record,
      logs: logRepository.list(req.params.id),
      sources: sourceRepository.list(req.params.id),
    });
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
