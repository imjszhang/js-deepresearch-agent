import fs from 'node:fs';
import path from 'node:path';
import {
  askWiki,
  compileWiki,
  initWiki,
  lintWiki,
  loadManifest,
  loadSourcesFromIntelStore,
} from 'js-wiki-engine';
import { getIntelStoreEngine } from '../storage/intel-store.mjs';
import { listArchivedRuns } from '../../scripts/intel/inspect-core.mjs';
import { listVaultPagesGrouped, readVaultPage } from './wiki-path.mjs';

export function resolveWikiVaultDir(settings) {
  const configured = settings?.research?.wikiVault || 'wiki';
  return path.isAbsolute(configured)
    ? path.resolve(configured)
    : path.resolve(process.cwd(), configured);
}

export function registerWikiRoutes(app, { settingsStore }) {
  app.get('/api/intel/runs', (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const engine = getIntelStoreEngine();
      const runs = listArchivedRuns(engine, { limit });
      res.json({ runs, vaultDir: resolveWikiVaultDir(settingsStore.get()) });
    } catch (error) {
      res.status(500).json({ error: error.message || String(error) });
    }
  });

  app.get('/api/wiki/status', (req, res) => {
    try {
      const settings = settingsStore.get();
      const vaultDir = resolveWikiVaultDir(settings);
      const manifest = loadManifest(vaultDir);
      let lint = null;
      const lintPath = path.join(vaultDir, 'Lint', 'latest.md');
      if (fs.existsSync(lintPath)) {
        lint = {
          reportPath: lintPath,
          ok: true,
          errorCount: 0,
          warnCount: 0,
        };
        const content = fs.readFileSync(lintPath, 'utf8');
        const issueLines = content.split('\n').filter((line) => line.startsWith('- **'));
        lint.issueCount = issueLines.length;
        lint.ok = !issueLines.some((line) => line.includes('**error**'));
        lint.errorCount = issueLines.filter((line) => line.includes('**error**')).length;
        lint.warnCount = issueLines.filter((line) => line.includes('**warn**')).length;
      }
      res.json({
        vaultDir,
        manifest: {
          schemaVersion: manifest.schemaVersion,
          vaultVersion: manifest.vaultVersion,
          compiledAt: manifest.compiledAt,
          sourceCount: Object.keys(manifest.sources || {}).length,
          topicCount: Object.keys(manifest.topics || {}).length,
        },
        lint,
        homeExists: fs.existsSync(path.join(vaultDir, 'Home.md')),
      });
    } catch (error) {
      res.status(500).json({ error: error.message || String(error) });
    }
  });

  app.post('/api/wiki/compile', async (req, res) => {
    try {
      const researchId = String(req.body?.researchId || '').trim();
      if (!researchId) {
        res.status(400).json({ error: 'researchId is required.' });
        return;
      }

      const settings = settingsStore.get();
      const vaultDir = resolveWikiVaultDir(settings);
      const engine = getIntelStoreEngine();
      const force = Boolean(req.body?.force);
      const runLint = req.body?.lint !== false;

      initWiki({ vaultDir });
      const loaded = loadSourcesFromIntelStore({ engine, researchId });
      const summary = compileWiki({
        vaultDir,
        sources: loaded.sources,
        report: loaded.report,
        meta: loaded.meta,
        force,
      });

      let lint = null;
      if (runLint) {
        lint = lintWiki({ vaultDir });
      }

      res.json({
        researchId,
        query: loaded.query,
        vaultDir,
        ...summary,
        lint,
      });
    } catch (error) {
      const status = /not found/i.test(error.message) ? 404 : 500;
      res.status(status).json({ error: error.message || String(error) });
    }
  });

  app.get('/api/wiki/pages', (req, res) => {
    try {
      const settings = settingsStore.get();
      const vaultDir = resolveWikiVaultDir(settings);
      if (!fs.existsSync(path.join(vaultDir, 'Home.md'))) {
        res.json({ vaultDir, pages: [], groups: {}, sortedGroups: [] });
        return;
      }
      const listing = listVaultPagesGrouped(vaultDir);
      res.json({ vaultDir, ...listing });
    } catch (error) {
      res.status(500).json({ error: error.message || String(error) });
    }
  });

  app.get('/api/wiki/page', (req, res) => {
    try {
      const settings = settingsStore.get();
      const vaultDir = resolveWikiVaultDir(settings);
      const pagePath = String(req.query.path || '').trim();
      if (!pagePath) {
        res.status(400).json({ error: 'path query parameter is required.' });
        return;
      }

      const page = readVaultPage(vaultDir, pagePath);
      if (!page) {
        res.status(404).json({ error: `Wiki page not found: ${pagePath}` });
        return;
      }
      res.json({ vaultDir, ...page });
    } catch (error) {
      const status = /invalid/i.test(error.message) ? 400 : 500;
      res.status(status).json({ error: error.message || String(error) });
    }
  });

  app.post('/api/wiki/ask', async (req, res) => {
    try {
      const question = String(req.body?.question || '').trim();
      if (!question) {
        res.status(400).json({ error: 'question is required.' });
        return;
      }

      const settings = settingsStore.get();
      const vaultDir = resolveWikiVaultDir(settings);
      if (!fs.existsSync(path.join(vaultDir, 'Home.md'))) {
        res.status(400).json({ error: 'Wiki vault is not initialized. Compile a research run first.' });
        return;
      }

      const limit = Math.min(Number(req.body?.limit) || 5, 20);
      const result = await askWiki({ vaultDir, question, limit });
      res.json({ vaultDir, ...result });
    } catch (error) {
      res.status(500).json({ error: error.message || String(error) });
    }
  });
}
