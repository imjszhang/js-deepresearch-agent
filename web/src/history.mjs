import '../styles.css';
import { apiGet, apiSend } from './api.mjs';
import { renderNav } from './nav.mjs';

const app = document.querySelector('#app');

main().catch((error) => {
  app.innerHTML = `<main class="shell"><p>${error.message}</p></main>`;
});

async function main() {
  const history = await apiGet('/api/history');
  app.innerHTML = `
    <main class="shell">
      ${renderNav('history')}
      <h1>Research History</h1>
      <section class="card">
        ${history.length === 0 ? '<p class="muted">No research yet.</p>' : renderHistory(history)}
      </section>
    </main>
  `;

  for (const button of document.querySelectorAll('[data-delete]')) {
    button.addEventListener('click', async () => {
      await apiSend(`/api/history/${button.dataset.delete}`, 'DELETE', {});
      await main();
    });
  }
}

function renderHistory(history) {
  return `
    <table width="100%" cellspacing="0" cellpadding="8">
      <thead>
        <tr><th align="left">Query</th><th>Status</th><th>Created</th><th>Actions</th></tr>
      </thead>
      <tbody>
        ${history.map((item) => `
          <tr>
            <td>${escapeHtml(item.query)}</td>
            <td>${escapeHtml(item.status)}</td>
            <td>${new Date(item.createdAt).toLocaleString()}</td>
            <td>
              <a href="/results.html?id=${item.id}">Open</a>
              ${item.status === 'completed' ? `<a href="/wiki.html?researchId=${encodeURIComponent(item.id)}">Wiki</a>` : ''}
              <button class="secondary" data-delete="${item.id}">Delete</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
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
