import '../styles.css';
import { apiGet } from './api.mjs';
import { renderMarkdown } from './markdown.mjs';
import { renderNav } from './nav.mjs';

const app = document.querySelector('#app');
const researchId = new URLSearchParams(window.location.search).get('id');

if (!researchId) {
  app.innerHTML = '<main class="shell"><p>Missing research id.</p></main>';
} else {
  main().catch((error) => {
    app.innerHTML = `<main class="shell"><p>${error.message}</p></main>`;
  });
}

async function main() {
  const record = await apiGet(`/api/research/${researchId}`);
  app.innerHTML = `
    <main class="shell">
      ${renderNav('research')}
      <h1>Research Results</h1>
      <section class="card">
        <p class="muted">${escapeHtml(record.query)}</p>
        <p>Status: <strong>${record.status}</strong></p>
        <button id="download">Download Markdown</button>
      </section>
      <section class="card report">${renderMarkdown(record.report || record.error || 'No report yet.')}</section>
      <section class="card">
        <h2>Sources</h2>
        <ol>
          ${record.sources.map((source) => `
            <li>
              <a href="${escapeAttr(source.url)}" target="_blank" rel="noreferrer">${escapeHtml(source.title || source.url)}</a>
              <p class="muted">${escapeHtml(source.snippet || '')}</p>
            </li>
          `).join('')}
        </ol>
      </section>
    </main>
  `;

  document.querySelector('#download').addEventListener('click', () => downloadMarkdown(record));
}

function downloadMarkdown(record) {
  const blob = new Blob([record.report || ''], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${record.id}.md`;
  link.click();
  URL.revokeObjectURL(url);
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
