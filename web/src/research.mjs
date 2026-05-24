import '../styles.css';
import { apiGet, apiSend } from './api.mjs';
import { renderNav } from './nav.mjs';

const app = document.querySelector('#app');

main().catch((error) => {
  app.innerHTML = `<main class="shell"><p>${error.message}</p></main>`;
});

async function main() {
  const [settings, providers, searchEngines, strategies] = await Promise.all([
    apiGet('/api/settings'),
    apiGet('/api/providers'),
    apiGet('/api/search-engines'),
    apiGet('/api/strategies'),
  ]);

  app.innerHTML = `
    <main class="shell">
      ${renderNav('research')}
      <h1>js-deepresearch-agent</h1>
      <p class="muted">Local single-user deep research agent.</p>
      <form id="research-form" class="card">
        <label for="query">Research query</label>
        <textarea id="query" required placeholder="What should be researched?"></textarea>

        <div class="grid">
          <div>
            <label for="provider">Provider</label>
            <select id="provider">${options(providers, settings.llm.provider)}</select>
          </div>
          <div>
            <label for="model">Model</label>
            <input id="model" value="${escapeAttr(settings.llm.model)}" />
          </div>
          <div>
            <label for="baseUrl">LLM base URL</label>
            <input id="baseUrl" value="${escapeAttr(settings.llm.baseUrl)}" />
          </div>
          <div>
            <label for="apiKey">API key</label>
            <input id="apiKey" type="password" value="${escapeAttr(settings.llm.apiKey)}" />
          </div>
        </div>

        <div class="grid">
          <div>
            <label for="searchEngine">Search engine</label>
            <select id="searchEngine">${options(searchEngines, settings.search.engine)}</select>
          </div>
          <div>
            <label for="searchBaseUrl">Search base URL</label>
            <input id="searchBaseUrl" value="${escapeAttr(settings.search.baseUrl)}" />
          </div>
          <div>
            <label for="strategy">Strategy</label>
            <select id="strategy">${options(strategies, settings.research.strategy)}</select>
          </div>
          <div>
            <label for="questions">Questions per iteration</label>
            <input id="questions" type="number" min="1" max="8" value="${settings.research.questionsPerIteration}" />
          </div>
          <div>
            <label for="iterations">Iterations</label>
            <input id="iterations" type="number" min="1" max="10" value="${settings.research.iterations}" />
          </div>
          <div>
            <label for="concurrency">Concurrency</label>
            <input id="concurrency" type="number" min="1" max="8" value="${settings.research.concurrency}" />
          </div>
        </div>

        <p><button type="submit">Start research</button></p>
        <p id="message" class="muted"></p>
      </form>
    </main>
  `;

  document.querySelector('#research-form').addEventListener('submit', submitResearch);
}

async function submitResearch(event) {
  event.preventDefault();
  const message = document.querySelector('#message');
  message.textContent = 'Saving settings and starting research...';

  const settings = collectSettings();
  await apiSend('/api/settings', 'PUT', settings);
  const research = await apiSend('/api/research', 'POST', {
    query: document.querySelector('#query').value,
    settings,
  });
  window.location.href = `/progress.html?id=${encodeURIComponent(research.id)}`;
}

function collectSettings() {
  return {
    llm: {
      provider: value('#provider'),
      model: value('#model'),
      baseUrl: value('#baseUrl'),
      apiKey: value('#apiKey'),
    },
    search: {
      engine: value('#searchEngine'),
      baseUrl: value('#searchBaseUrl'),
    },
    research: {
      strategy: value('#strategy'),
      questionsPerIteration: Number(value('#questions') || 3),
      iterations: Number(value('#iterations') || 2),
      concurrency: Number(value('#concurrency') || 2),
    },
  };
}

function value(selector) {
  return document.querySelector(selector).value.trim();
}

function options(items, selected) {
  return items.map((item) => `
    <option value="${escapeAttr(item.id)}" ${item.id === selected ? 'selected' : ''} ${item.disabledReason ? 'disabled' : ''}>
      ${escapeHtml(item.label)}${item.disabledReason ? ' (later)' : ''}
    </option>
  `).join('');
}

function escapeHtml(valueToEscape) {
  return String(valueToEscape).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function escapeAttr(valueToEscape) {
  return escapeHtml(valueToEscape);
}
