import '../styles.css';
import { apiGet, apiSend } from './api.mjs';
import { renderNav } from './nav.mjs';
import { renderWikiMarkdown } from './wiki-markdown.mjs';

const app = document.querySelector('#app');
const initialResearchId = new URLSearchParams(window.location.search).get('researchId') || '';

function getPageFromUrl() {
  return new URLSearchParams(window.location.search).get('page') || '';
}

function setPageInUrl(relativePath) {
  const url = new URL(window.location.href);
  if (relativePath) {
    url.searchParams.set('page', relativePath);
  } else {
    url.searchParams.delete('page');
  }
  window.history.pushState({}, '', url);
}

main().catch((error) => {
  app.innerHTML = `<main class="shell"><p>${escapeHtml(error.message)}</p></main>`;
});

window.addEventListener('popstate', () => {
  const viewer = document.querySelector('#wiki-viewer');
  if (viewer) {
    loadPage(getPageFromUrl() || 'Home.md', { pushUrl: false });
  }
});

async function main() {
  const [runsPayload, status] = await Promise.all([
    apiGet('/api/intel/runs?limit=50'),
    apiGet('/api/wiki/status').catch(() => null),
  ]);

  const runs = runsPayload.runs || [];
  const vaultDir = runsPayload.vaultDir || status?.vaultDir || 'wiki';
  const selectedId = initialResearchId && runs.some((r) => r.researchId === initialResearchId)
    ? initialResearchId
    : (runs[0]?.researchId || '');
  const canBrowse = Boolean(status?.homeExists);

  app.innerHTML = `
    <main class="shell wiki-shell">
      ${renderNav('wiki')}
      <h1>LLM Wiki</h1>
      <p class="muted">
        Compile archived research into an Obsidian-compatible vault.
        Browse pages here or open the vault folder in Obsidian for graph view.
      </p>

      <section class="card">
        <h2>Vault</h2>
        <p class="muted wiki-path"><code>${escapeHtml(vaultDir)}</code></p>
        ${renderStatus(status)}
      </section>

      <section class="card">
        <h2>Compile</h2>
        ${runs.length === 0 ? `
          <p class="muted">No archived runs in intel store. Run research or import work_dir via CLI:</p>
          <pre class="log">npm exec jdr -- intel import --strategy source-based</pre>
        ` : `
          <label for="research-id">Research run</label>
          <select id="research-id">${runs.map((run) => `
            <option value="${escapeAttr(run.researchId)}" ${run.researchId === selectedId ? 'selected' : ''}>
              ${escapeHtml(run.query || run.researchId)} (${run.sourcesCount} sources)
            </option>
          `).join('')}</select>
          <div class="wiki-actions">
            <button id="compile">Compile Wiki</button>
            <button class="secondary" id="compile-lint">Compile + Lint</button>
            <button class="secondary" id="compile-force">Force full recompile</button>
          </div>
          <p id="compile-status" class="muted"></p>
        `}
      </section>

      ${canBrowse ? `
        <section class="card wiki-browse-card">
          <h2>Browse</h2>
          <div class="wiki-layout">
            <aside class="wiki-sidebar">
              <input id="page-filter" type="search" placeholder="Filter pages…" />
              <nav id="wiki-sidebar" class="wiki-sidebar-nav muted">Loading pages…</nav>
            </aside>
            <div class="wiki-main">
              <p id="wiki-page-title" class="wiki-page-title"></p>
              <article id="wiki-viewer" class="report wiki-viewer">Select a page from the sidebar.</article>
              <p id="wiki-broken-links" class="muted"></p>
            </div>
          </div>
        </section>
      ` : `
        <section class="card">
          <p class="muted">Compile a research run to browse wiki pages here.</p>
        </section>
      `}

      <section class="card">
        <h2>Ask (retrieval)</h2>
        <label for="question">Question</label>
        <input id="question" type="text" placeholder="What is LLM Wiki?" />
        <button id="ask" class="secondary">Search vault pages</button>
        <div id="ask-results"></div>
      </section>
    </main>
  `;

  bindHandlers(vaultDir);

  if (canBrowse) {
    await initBrowse(getPageFromUrl() || 'Home.md');
  }
}

let browsePages = [];

async function initBrowse(initialPage) {
  const listing = await apiGet('/api/wiki/pages');
  browsePages = listing.pages || [];
  renderSidebar(browsePages, listing.sortedGroups || [], listing.groups || {});

  document.querySelector('#page-filter')?.addEventListener('input', (event) => {
    const query = event.target.value.trim().toLowerCase();
    const filtered = query
      ? browsePages.filter((page) =>
        page.relativePath.toLowerCase().includes(query)
        || page.title.toLowerCase().includes(query),
      )
      : browsePages;
    const groups = groupPages(filtered);
    renderSidebar(filtered, Object.keys(groups).sort(), groups);
  });

  const viewer = document.querySelector('#wiki-viewer');
  viewer?.addEventListener('click', (event) => {
    const link = event.target.closest('[data-wiki-target]');
    if (!link) return;
    event.preventDefault();
    const target = link.getAttribute('data-wiki-target');
    const resolved = link.getAttribute('data-wiki-resolved');
    if (resolved) {
      loadPage(resolved);
      return;
    }
    if (target) {
      loadPage(target);
    }
  });

  const startPage = browsePages.some((p) => p.relativePath === initialPage)
    ? initialPage
    : (browsePages.find((p) => p.relativePath === 'Home.md')?.relativePath || browsePages[0]?.relativePath);
  if (startPage) {
    await loadPage(startPage, { pushUrl: true });
  }
}

function groupPages(pages) {
  const groups = {};
  for (const page of pages) {
    groups[page.segment] = groups[page.segment] || [];
    groups[page.segment].push(page);
  }
  return groups;
}

function renderSidebar(pages, sortedGroups, groups) {
  const nav = document.querySelector('#wiki-sidebar');
  if (!nav) return;

  const order = ['(root)', 'Topics', 'Sources', 'Claims', 'Questions', 'Lint'];
  const keys = sortedGroups.length
    ? sortedGroups
    : Object.keys(groups).sort((a, b) => {
      const ai = order.indexOf(a);
      const bi = order.indexOf(b);
      if (ai === -1 && bi === -1) return a.localeCompare(b);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });

  if (!pages.length) {
    nav.innerHTML = '<p>No pages match filter.</p>';
    return;
  }

  nav.innerHTML = keys.map((segment) => {
    const items = (groups[segment] || []).slice().sort((a, b) => a.title.localeCompare(b.title));
    const label = segment === '(root)' ? 'Index' : segment;
    return `
      <div class="wiki-sidebar-group">
        <strong>${escapeHtml(label)}</strong>
        <ul>
          ${items.map((page) => `
            <li>
              <a href="#" class="wiki-sidebar-link" data-page="${escapeAttr(page.relativePath)}">
                ${escapeHtml(page.title)}
              </a>
            </li>
          `).join('')}
        </ul>
      </div>
    `;
  }).join('');

  for (const link of nav.querySelectorAll('.wiki-sidebar-link')) {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      loadPage(link.dataset.page);
    });
  }
}

async function loadPage(relativePath, { pushUrl = true } = {}) {
  const viewer = document.querySelector('#wiki-viewer');
  const titleEl = document.querySelector('#wiki-page-title');
  const brokenEl = document.querySelector('#wiki-broken-links');
  if (!viewer) return;

  viewer.innerHTML = '<p class="muted">Loading…</p>';
  if (pushUrl) setPageInUrl(relativePath);

  try {
    const page = await apiGet(`/api/wiki/page?path=${encodeURIComponent(relativePath)}`);
    titleEl.textContent = `${page.title} — ${page.relativePath}`;

    let html = renderWikiMarkdown(page.markdown);
    for (const link of page.links || []) {
      if (!link.exists) continue;
      const pattern = new RegExp(
        `data-wiki-target="${escapeRegExp(link.target)}"`,
        'g',
      );
      html = html.replace(
        pattern,
        `data-wiki-target="${escapeAttr(link.target)}" data-wiki-resolved="${escapeAttr(link.relativePath)}"`,
      );
    }
    viewer.innerHTML = html;

    const broken = (page.links || []).filter((link) => !link.exists);
    brokenEl.textContent = broken.length
      ? `Unresolved wikilinks: ${broken.map((l) => l.target).join(', ')}`
      : '';

    const sidebarNav = document.querySelector('#wiki-sidebar');
    for (const link of sidebarNav?.querySelectorAll('.wiki-sidebar-link') || []) {
      link.classList.toggle('active', link.dataset.page === relativePath);
    }
  } catch (error) {
    viewer.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
    titleEl.textContent = '';
    brokenEl.textContent = '';
  }
}

function renderStatus(status) {
  if (!status) return '<p class="muted">Status unavailable.</p>';
  const m = status.manifest || {};
  const lint = status.lint;
  const lintLine = lint
    ? `Lint: ${lint.errorCount} error(s), ${lint.warnCount} warn(s)`
    : 'Lint: not run yet';
  return `
    <ul class="wiki-meta">
      <li>Home.md: ${status.homeExists ? 'yes' : 'no'}</li>
      <li>Last compiled: ${m.compiledAt ? new Date(m.compiledAt).toLocaleString() : 'never'}</li>
      <li>Sources in manifest: ${m.sourceCount ?? 0}</li>
      <li>Topics: ${m.topicCount ?? 0}</li>
      <li>${escapeHtml(lintLine)}</li>
    </ul>
  `;
}

function bindHandlers(vaultDir) {
  const compileBtn = document.querySelector('#compile');
  const compileLintBtn = document.querySelector('#compile-lint');
  const compileForceBtn = document.querySelector('#compile-force');
  const askBtn = document.querySelector('#ask');
  const statusEl = document.querySelector('#compile-status');

  async function runCompile({ lint = true, force = false } = {}) {
    const researchId = document.querySelector('#research-id')?.value;
    if (!researchId) return;

    const buttons = [compileBtn, compileLintBtn, compileForceBtn].filter(Boolean);
    for (const btn of buttons) btn.disabled = true;
    statusEl.textContent = 'Compiling…';

    try {
      const result = await apiSend('/api/wiki/compile', 'POST', {
        researchId,
        lint,
        force,
      });
      const lintMsg = result.lint
        ? ` Lint: ${result.lint.errorCount} error(s), ${result.lint.warnCount} warn(s).`
        : '';
      statusEl.textContent = `Done. Written: ${result.compiled}, skipped: ${result.skipped}. Topics: ${(result.topics || []).join(', ') || '(none)'}.${lintMsg}`;
      await main();
    } catch (error) {
      statusEl.textContent = error.message;
    } finally {
      for (const btn of buttons) btn.disabled = false;
    }
  }

  compileBtn?.addEventListener('click', () => runCompile({ lint: false }));
  compileLintBtn?.addEventListener('click', () => runCompile({ lint: true }));
  compileForceBtn?.addEventListener('click', () => runCompile({ lint: true, force: true }));

  askBtn?.addEventListener('click', async () => {
    const question = document.querySelector('#question')?.value?.trim();
    const resultsEl = document.querySelector('#ask-results');
    if (!question) {
      resultsEl.innerHTML = '<p class="muted">Enter a question.</p>';
      return;
    }

    askBtn.disabled = true;
    resultsEl.innerHTML = '<p class="muted">Searching…</p>';
    try {
      const result = await apiSend('/api/wiki/ask', 'POST', { question, limit: 8 });
      if (!result.pages?.length) {
        resultsEl.innerHTML = `<p class="muted">${escapeHtml(result.answer || 'No pages found.')}</p>`;
        return;
      }
      resultsEl.innerHTML = `
        <p>${escapeHtml(result.answer)}</p>
        <ul>
          ${result.pages.map((page) => `
            <li>
              <a href="#" class="wiki-open-page" data-page="${escapeAttr(page.relativePath)}">
                ${escapeHtml(page.relativePath)}
              </a>
              <span class="muted">score=${page.score}</span>
              <p class="muted">${escapeHtml((page.excerpt || '').slice(0, 200))}</p>
            </li>
          `).join('')}
        </ul>
      `;
      for (const link of resultsEl.querySelectorAll('.wiki-open-page')) {
        link.addEventListener('click', (event) => {
          event.preventDefault();
          loadPage(link.dataset.page);
          document.querySelector('.wiki-browse-card')?.scrollIntoView({ behavior: 'smooth' });
        });
      }
    } catch (error) {
      resultsEl.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
    } finally {
      askBtn.disabled = false;
    }
  });

  document.querySelector('.wiki-path')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(vaultDir);
      statusEl.textContent = 'Vault path copied to clipboard.';
    } catch {
      statusEl.textContent = vaultDir;
    }
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value);
}
