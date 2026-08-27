import '../styles.css';
import { apiGet, apiSend } from './api.mjs';
import { renderNav } from './nav.mjs';
import {
  availableSearchEngines,
  backendSettingsFor,
  buildSearchSettings,
  selectedBackendIds,
} from './search-settings-form.mjs';

const app = document.querySelector('#app');
let loadedSettings = null;
let loadedStrategies = [];
let loadedSearchEngines = [];

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
  loadedSearchEngines = availableSearchEngines(searchEngines);

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
            <label for="searchMode">Search mode</label>
            <select id="searchMode">
              <option value="single" ${settings.search.mode === 'fanout' ? '' : 'selected'}>Single source</option>
              <option value="fanout" ${settings.search.mode === 'fanout' ? 'selected' : ''}>Multiple sources (fan-out)</option>
            </select>
          </div>
          <div>
            <label for="searchMaxResults">Max merged results</label>
            <input id="searchMaxResults" type="number" min="1" max="40" value="${settings.search.maxResults ?? 8}" />
          </div>
          <div>
            <label for="strategy">Strategy</label>
            <select id="strategy">${options(strategies, settings.research.strategy)}</select>
          </div>
        </div>

        <div id="singleSearchFields" class="grid strategy-panel">
          <div>
            <label for="searchEngine">Search engine</label>
            <select id="searchEngine">${options(searchEngines, settings.search.engine)}</select>
          </div>
          <div>
            <label for="searchBaseUrl">Search base URL</label>
            <input id="searchBaseUrl" value="${escapeAttr(settings.search.baseUrl)}" />
          </div>
        </div>

        <div id="fanoutSearchFields" class="strategy-panel">
          <div class="grid">
            <div>
              <label for="maxParallelBackends">Max parallel backends (0 = all)</label>
              <input id="maxParallelBackends" type="number" min="0" max="8" value="${settings.search.fanout?.maxParallelBackends ?? 0}" />
            </div>
            <div>
              <label for="maxSearchBackendRequests">Max backend requests (0 = unlimited)</label>
              <input id="maxSearchBackendRequests" type="number" min="0" value="${settings.research.budget?.maxSearchBackendRequests ?? 0}" />
            </div>
          </div>
          <p class="muted">Select two or more registered engines. Each backend keeps its own timeout; results merge by round-robin and normalized URL.</p>
          <div id="fanoutBackends" class="backend-list">
            ${renderFanoutBackends(searchEngines, settings.search)}
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
            <label for="exploratoryMaxSteps">Max steps (0 = unlimited)</label>
            <input id="exploratoryMaxSteps" type="number" min="0" value="${exploratory.maxSteps ?? 0}" />
          </div>
          <div>
            <label for="exploratoryMaxReads">Reads per step</label>
            <input id="exploratoryMaxReads" type="number" min="1" max="8" value="${exploratory.maxReadsPerStep ?? 4}" />
          </div>
          <div>
            <label for="exploratoryMinTokens">Min LLM tokens (keep exploring until this)</label>
            <input id="exploratoryMinTokens" type="number" min="0" value="${exploratory.minLlmTokens ?? exploratory.targetLlmTokens ?? 20000}" />
          </div>
          <div>
            <label for="exploratoryMaxTokens">Max LLM tokens (0 = unlimited)</label>
            <input id="exploratoryMaxTokens" type="number" min="0" value="${exploratory.maxLlmTokens ?? 80000}" />
          </div>
          <div>
            <label><input id="answerGate" type="checkbox" ${exploratory.answerGate !== false ? 'checked' : ''} /> Answer gate</label>
          </div>
          <div>
            <label for="exploratoryMaxSearchRequests">Max search requests (0 = unlimited)</label>
            <input id="exploratoryMaxSearchRequests" type="number" min="0" value="${exploratory.maxSearchRequests ?? 0}" />
          </div>
          <div>
            <label for="exploratoryMaxSourceReads">Max source reads (0 = unlimited)</label>
            <input id="exploratoryMaxSourceReads" type="number" min="0" value="${exploratory.maxSourceReads ?? 0}" />
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
  document.querySelector('#searchMode').addEventListener('change', syncSearchMode);
  document.querySelector('#fanoutBackends')?.addEventListener('change', syncFanoutBackendFields);
  syncStrategyPanels();
  syncSearchMode();
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
  const strategy = value('#strategy');
  return {
    llm: {
      ...(loadedSettings?.llm || {}),
      provider: value('#provider'),
      model: value('#model'),
      baseUrl: value('#baseUrl'),
      apiKey: value('#apiKey'),
    },
    search: collectSearchSettings(),
    research: {
      ...(loadedSettings?.research || {}),
      strategy,
      questionsPerIteration: Number(value('#questions') || 2),
      iterations: Number(value('#iterations') || 1),
      concurrency: Number(value('#concurrency') || 1),
      budget: {
        ...currentResearchBudget(),
        ...(loadedSettings?.research?.budget || {}),
        maxSearchBackendRequests: Number(value('#maxSearchBackendRequests') || loadedSettings?.research?.budget?.maxSearchBackendRequests || 0),
        ...(strategy === 'focused' ? {
          maxSearchRequests: Number(value('#maxSearchRequests') || 0),
          maxSourceReads: Number(value('#maxSourceReads') || 0),
        } : {}),
      },
      focused: {
        ...(loadedSettings?.research?.focused || {}),
        ...(strategy === 'focused' ? {
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
        } : {}),
      },
      exploratory: {
        ...(loadedSettings?.research?.exploratory || {}),
        ...(strategy === 'exploratory' ? {
          maxSteps: Number(value('#exploratoryMaxSteps') || 0),
          maxReadsPerStep: Number(value('#exploratoryMaxReads') || 4),
          minLlmTokens: Number(value('#exploratoryMinTokens') || 0),
          maxLlmTokens: Number(value('#exploratoryMaxTokens') || 0),
          targetLlmTokens: Number(value('#exploratoryMinTokens') || 0),
          maxSearchRequests: Number(value('#exploratoryMaxSearchRequests') || 0),
          maxSourceReads: Number(value('#exploratoryMaxSourceReads') || 0),
          answerGate: checked('#answerGate'),
        } : {}),
      },
    },
  };
}

function collectSearchSettings() {
  const mode = value('#searchMode') || 'single';
  const selected = mode === 'fanout'
    ? loadedSearchEngines
      .map((engine) => engine.id)
      .filter((engineId) => document.querySelector(`#backend-${engineId}`)?.checked)
    : [value('#searchEngine')].filter(Boolean);
  const backendConfigs = {};
  for (const engineId of selected) {
    backendConfigs[engineId] = {
      baseUrl: optionalValue(`#backend-${engineId}-baseUrl`),
      maxResults: optionalNumber(`#backend-${engineId}-maxResults`),
      provider: {
        ...(engineId === 'js-eyes' ? {
          skills: optionalValue(`#backend-${engineId}-skills`)
            ? optionalValue(`#backend-${engineId}-skills`).split(/[,;]/).map((item) => item.trim()).filter(Boolean)
            : undefined,
          serverUrl: optionalValue(`#backend-${engineId}-serverUrl`),
        } : {}),
      },
    };
  }
  return buildSearchSettings({
    mode,
    engine: value('#searchEngine') || selected[0],
    baseUrl: value('#searchBaseUrl'),
    maxResults: Number(value('#searchMaxResults') || 8),
    maxParallelBackends: Number(value('#maxParallelBackends') || 0),
    selectedEngines: selected,
    backendConfigs,
    previous: loadedSettings?.search || {},
  });
}

function renderFanoutBackends(searchEngines, search) {
  const selected = new Set(selectedBackendIds(search, availableSearchEngines(searchEngines)));
  return availableSearchEngines(searchEngines).map((engine) => {
    const settings = backendSettingsFor(search, engine.id);
    const checked = selected.has(engine.id);
    return `
      <fieldset class="backend-card" data-engine="${escapeAttr(engine.id)}">
        <label class="backend-toggle">
          <input id="backend-${escapeAttr(engine.id)}" type="checkbox" value="${escapeAttr(engine.id)}" ${checked ? 'checked' : ''} />
          ${escapeHtml(engine.label || engine.id)}
        </label>
        <div class="grid backend-fields" ${checked ? '' : 'hidden'}>
          <div>
            <label for="backend-${escapeAttr(engine.id)}-maxResults">Backend max results</label>
            <input id="backend-${escapeAttr(engine.id)}-maxResults" type="number" min="1" max="40" value="${settings.maxResults ?? search.maxResults ?? 8}" />
          </div>
          ${engine.supportsBaseUrl || engine.id === 'searxng' ? `
          <div>
            <label for="backend-${escapeAttr(engine.id)}-baseUrl">Base URL</label>
            <input id="backend-${escapeAttr(engine.id)}-baseUrl" value="${escapeAttr(settings.baseUrl || search.baseUrl || '')}" />
          </div>` : ''}
          ${engine.supportsServerUrl || engine.id === 'js-eyes' ? `
          <div>
            <label for="backend-${escapeAttr(engine.id)}-serverUrl">JS Eyes server URL</label>
            <input id="backend-${escapeAttr(engine.id)}-serverUrl" value="${escapeAttr(settings.provider?.serverUrl || search.provider?.serverUrl || search.jsEyesServerUrl || '')}" />
          </div>
          <div>
            <label for="backend-${escapeAttr(engine.id)}-skills">JS Eyes skills</label>
            <input id="backend-${escapeAttr(engine.id)}-skills" value="${escapeAttr((settings.provider?.skills || search.provider?.skills || search.jsEyesSkills || []).join(','))}" placeholder="js-zhihu-ops-skill,js-reddit-ops-skill" />
          </div>` : ''}
        </div>
      </fieldset>
    `;
  }).join('');
}

function syncSearchMode() {
  const mode = value('#searchMode') || 'single';
  togglePanel('#singleSearchFields', mode !== 'fanout');
  togglePanel('#fanoutSearchFields', mode === 'fanout');
  syncFanoutBackendFields();
}

function syncFanoutBackendFields() {
  for (const card of document.querySelectorAll('.backend-card')) {
    const engineId = card.getAttribute('data-engine');
    const checked = document.querySelector(`#backend-${engineId}`)?.checked;
    const fields = card.querySelector('.backend-fields');
    if (fields) fields.hidden = !checked;
  }
}

function optionalValue(selector) {
  const node = document.querySelector(selector);
  return node ? node.value.trim() : undefined;
}

function optionalNumber(selector) {
  const raw = optionalValue(selector);
  if (raw === undefined || raw === '') return undefined;
  const number = Number(raw);
  return Number.isFinite(number) ? number : undefined;
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
  togglePanel('#budgetFields', strategy === 'focused');
}

function togglePanel(selector, visible) {
  const node = document.querySelector(selector);
  if (node) node.hidden = !visible;
}

function currentResearchBudget() {
  return { maxLlmTokens: 0, maxEstimatedCost: 0, maxTotalLlmTokens: 0 };
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
