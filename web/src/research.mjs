import '../styles.css';
import { apiGet, apiSend } from './api.mjs';
import { renderNav } from './nav.mjs';

const app = document.querySelector('#app');
let loadedSettings = null;
let loadedStrategies = [];

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
  loadedSettings = settings;
  loadedStrategies = strategies;

  const focused = settings.research.focused || {};
  const exploratory = settings.research.exploratory || {};

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
        </div>
        <p id="strategyHelp" class="muted strategy-help"></p>

        <div id="searchFields" class="grid strategy-panel">
          <div>
            <label for="questions">Questions per iteration</label>
            <input id="questions" type="number" min="1" max="8" value="${settings.research.questionsPerIteration}" />
          </div>
          <div>
            <label for="concurrency">Concurrency</label>
            <input id="concurrency" type="number" min="1" max="8" value="${settings.research.concurrency}" />
          </div>
        </div>

        <div id="quickFields" class="grid strategy-panel">
          <div>
            <label for="iterations">Iterations</label>
            <input id="iterations" type="number" min="1" max="10" value="${settings.research.strategy === 'quick' ? settings.research.iterations : 1}" />
          </div>
        </div>

        <div id="focusedFields" class="grid strategy-panel">
          <div>
            <label for="focusedFetchMode">Source fetch mode</label>
            <select id="focusedFetchMode">
              <option value="summary" ${focused.fetchMode === 'summary' ? 'selected' : ''}>summary</option>
              <option value="disabled" ${focused.fetchMode === 'disabled' ? 'selected' : ''}>disabled</option>
              <option value="full" ${focused.fetchMode === 'full' ? 'selected' : ''}>full</option>
              <option value="extract" ${focused.fetchMode === 'extract' ? 'selected' : ''}>extract</option>
            </select>
          </div>
          <div>
            <label for="focusedMaxUrls">Max source URLs</label>
            <input id="focusedMaxUrls" type="number" min="1" max="48" value="${focused.maxUrlsTotal ?? 12}" />
          </div>
          <div>
            <label><input id="iterationControl" type="checkbox" ${focused.iterationControl?.enabled ? 'checked' : ''} /> Iteration / evidence early-stop</label>
          </div>
          <div>
            <label><input id="evidencePassages" type="checkbox" ${focused.evidencePassages?.enabled ? 'checked' : ''} /> Passage-level evidence</label>
          </div>
        </div>

        <div id="exploratoryFields" class="grid strategy-panel">
          <div>
            <label for="exploratoryMaxSteps">Max steps</label>
            <input id="exploratoryMaxSteps" type="number" min="2" max="32" value="${exploratory.maxSteps ?? 16}" />
          </div>
          <div>
            <label for="exploratoryMaxReads">Reads per step</label>
            <input id="exploratoryMaxReads" type="number" min="1" max="8" value="${exploratory.maxReadsPerStep ?? 4}" />
          </div>
          <div>
            <label><input id="answerGate" type="checkbox" ${exploratory.answerGate !== false ? 'checked' : ''} /> Answer gate</label>
          </div>
        </div>

        <div id="budgetFields" class="grid strategy-panel">
          <div>
            <label for="maxSearchRequests">Max search requests (0 = unlimited)</label>
            <input id="maxSearchRequests" type="number" min="0" value="${settings.research.budget?.maxSearchRequests ?? 0}" />
          </div>
          <div>
            <label for="maxSourceReads">Max source reads (0 = unlimited)</label>
            <input id="maxSourceReads" type="number" min="0" value="${settings.research.budget?.maxSourceReads ?? 0}" />
          </div>
        </div>

        <p><button type="submit">Start research</button></p>
        <p id="message" class="muted"></p>
      </form>
    </main>
  `;

  document.querySelector('#research-form').addEventListener('submit', submitResearch);
  document.querySelector('#strategy').addEventListener('change', syncStrategyPanels);
  syncStrategyPanels();
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
      ...(loadedSettings?.llm || {}),
      provider: value('#provider'),
      model: value('#model'),
      baseUrl: value('#baseUrl'),
      apiKey: value('#apiKey'),
    },
    search: {
      ...(loadedSettings?.search || {}),
      engine: value('#searchEngine'),
      baseUrl: value('#searchBaseUrl'),
    },
    research: {
      ...(loadedSettings?.research || {}),
      strategy: value('#strategy'),
      questionsPerIteration: Number(value('#questions') || 2),
      iterations: Number(value('#iterations') || 1),
      concurrency: Number(value('#concurrency') || 1),
      budget: {
        ...currentResearchBudget(),
        ...(loadedSettings?.research?.budget || {}),
        maxSearchRequests: Number(value('#maxSearchRequests') || 0),
        maxSourceReads: Number(value('#maxSourceReads') || 0),
      },
      focused: {
        ...(loadedSettings?.research?.focused || {}),
        fetchMode: value('#focusedFetchMode') || 'summary',
        maxUrlsTotal: Number(value('#focusedMaxUrls') || 12),
        iterationControl: {
          ...(loadedSettings?.research?.focused?.iterationControl || {}),
          enabled: checked('#iterationControl'),
        },
        evidencePassages: {
          ...(loadedSettings?.research?.focused?.evidencePassages || {}),
          enabled: checked('#evidencePassages'),
          claimAlignment: checked('#evidencePassages'),
        },
      },
      exploratory: {
        ...(loadedSettings?.research?.exploratory || {}),
        maxSteps: Number(value('#exploratoryMaxSteps') || 16),
        maxReadsPerStep: Number(value('#exploratoryMaxReads') || 4),
        answerGate: checked('#answerGate'),
      },
    },
  };
}

function syncStrategyPanels() {
  const strategy = value('#strategy');
  const selected = loadedStrategies.find((item) => item.id === strategy);
  const help = document.querySelector('#strategyHelp');
  if (help) {
    help.textContent = selected?.description || '';
  }
  togglePanel('#searchFields', strategy === 'quick' || strategy === 'focused');
  togglePanel('#quickFields', strategy === 'quick');
  togglePanel('#focusedFields', strategy === 'focused');
  togglePanel('#exploratoryFields', strategy === 'exploratory');
  togglePanel('#budgetFields', strategy === 'focused' || strategy === 'exploratory');
}

function togglePanel(selector, visible) {
  const node = document.querySelector(selector);
  if (node) node.hidden = !visible;
}

function currentResearchBudget() {
  return { maxLlmTokens: 0, maxEstimatedCost: 0, reserveReportTokens: 1200 };
}

function checked(selector) {
  return document.querySelector(selector).checked;
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
