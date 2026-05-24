import '../styles.css';
import { apiGet, apiSend } from './api.mjs';
import { subscribeToResearch } from './events.mjs';
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
      <h1>Research Progress</h1>
      <section class="card">
        <p class="muted">${escapeHtml(record.query)}</p>
        <h2 id="status">${record.status}</h2>
        <div class="progress"><div id="bar"></div></div>
        <p><button id="cancel" class="secondary">Cancel</button> <a id="results" href="/results.html?id=${researchId}" hidden>View results</a></p>
      </section>
      <section class="card">
        <h2>Logs</h2>
        <div id="logs" class="log"></div>
      </section>
    </main>
  `;

  document.querySelector('#cancel').addEventListener('click', async () => {
    await apiSend(`/api/research/${researchId}/cancel`, 'POST', {});
  });

  subscribeToResearch(researchId, {
    status: updateStatus,
    log: appendLog,
  });
}

function updateStatus(record) {
  document.querySelector('#status').textContent = record.status;
  if (['completed', 'failed', 'cancelled'].includes(record.status)) {
    document.querySelector('#results').hidden = record.status !== 'completed';
  }
}

function appendLog(log) {
  const logs = document.querySelector('#logs');
  logs.textContent += `[${log.level}] ${log.message}\n`;
  logs.scrollTop = logs.scrollHeight;
  if (Number.isFinite(log.progress)) {
    document.querySelector('#bar').style.width = `${Math.max(0, Math.min(100, log.progress))}%`;
  }
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
