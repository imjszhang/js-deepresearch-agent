import { spawn } from 'node:child_process';
import {
  attachSearchMeta,
  collectRespondedEngines,
  filterSearchOptions,
  sanitizeSearchOptions,
  SearchProviderError,
  searchErrorFromProviderPayload,
} from 'js-deepresearch-engine';
import {
  formatPayloadError,
  isAbortError,
  parseJsonOutput,
  resolveCliCommand,
  resolveSpawnTarget,
  runCommand,
} from './cli-process.mjs';
import { enqueueJsEyesInvoke, jsEyesInvokeKey, waitRetryDelay } from './invoke-queue.mjs';
import { mergeSkillResults } from './merge-results.mjs';
import { resolveProviderConfig } from './provider-config.mjs';
import { resolveDriverMode, resolveJsEyesCapabilities } from './skill-registry.mjs';
import { normalizeUnifiedItems } from './source-normalizer.mjs';
import { buildSkillRunCommand, buildSkillRunPreCommand } from './skill-run-driver.mjs';
import { buildUnifiedCommand } from './unified-driver.mjs';
import { DEFAULT_TIMEOUT_MS } from './constants.mjs';

function wrapProviderError(error, fallbackMessage = 'JS Eyes search failed') {
  if (isAbortError(error)) return error;
  if (error instanceof SearchProviderError) return error;
  return new SearchProviderError(error?.message || fallbackMessage, {
    code: 'provider_error',
    retryable: false,
    provider: 'js-eyes',
  });
}

function retryLimit(provider, error) {
  if (provider.maxRetries != null) return Math.max(0, Number(provider.maxRetries) || 0);
  return error?.retryable ? 1 : 0;
}

export class JsEyesCliSearchEngine {
  constructor(config = {}, options = {}) {
    this.config = config;
    this.spawn = options.spawn || spawn;
    const provider = resolveProviderConfig(config);
    this.capabilities = resolveJsEyesCapabilities(provider, options.capabilities || {});
  }

  async search(query, { signal, searchOptions } = {}) {
    const trimmedQuery = String(query || '').trim();
    if (!trimmedQuery) return [];

    const provider = resolveProviderConfig(this.config);
    this.capabilities = resolveJsEyesCapabilities(provider, this.capabilities);
    const driver = resolveDriverMode(provider, provider.skills);
    const requested = sanitizeSearchOptions(searchOptions) || {};
    const filtered = filterSearchOptions(requested, this.capabilities);
    let providerRetries = 0;

    try {
      const sources = driver === 'skill-run'
        ? await this.searchViaSkillRun(trimmedQuery, provider, {
          signal,
          onRetry: () => { providerRetries += 1; },
        })
        : await this.searchViaUnified(trimmedQuery, provider, {
          signal,
          onRetry: () => { providerRetries += 1; },
        });

      return attachSearchMeta(sources, {
        requestedSearchOptions: requested,
        effectiveSearchOptions: filtered.effective,
        droppedSearchOptions: filtered.dropped,
        requestParams: filtered.effective,
        respondedEngines: collectRespondedEngines(sources),
        providerRetries,
        fixedEngine: this.capabilities.fixedEngine,
      });
    } catch (error) {
      throw wrapProviderError(error);
    }
  }

  buildCommand(query) {
    const provider = resolveProviderConfig(this.config);
    const driver = resolveDriverMode(provider, provider.skills);
    const command = resolveCliCommand(provider.cli);

    if (driver === 'skill-run' && provider.skills.length === 1) {
      return {
        command,
        args: buildSkillRunCommand(query, provider.skills[0], provider),
      };
    }

    return {
      command,
      args: buildUnifiedCommand(query, provider),
    };
  }

  async searchViaUnified(query, provider, { signal, onRetry } = {}) {
    const command = resolveCliCommand(provider.cli);
    const args = buildUnifiedCommand(query, provider);
    const payload = await this.runCliQueued(
      jsEyesInvokeKey(provider.serverUrl, 'unified'),
      command,
      args,
      provider,
      signal,
      onRetry,
    );

    if (!payload || payload.ok === false) {
      throw searchErrorFromProviderPayload(payload, {
        fallbackMessage: formatPayloadError(payload, { stderr: '' }),
        provider: 'js-eyes',
      });
    }

    return normalizeUnifiedItems(payload, this.config);
  }

  async searchViaSkillRun(query, provider, { signal, onRetry } = {}) {
    const command = resolveCliCommand(provider.cli);
    const batches = [];
    const failures = [];

    for (const skillId of provider.skills) {
      try {
        const preArgs = buildSkillRunPreCommand(query, skillId, provider);
        if (preArgs) {
          await this.runCliQueued(
            jsEyesInvokeKey(provider.serverUrl, skillId),
            command,
            preArgs,
            provider,
            signal,
            onRetry,
          );
        }

        const args = buildSkillRunCommand(query, skillId, provider);
        const payload = await this.runCliQueued(
          jsEyesInvokeKey(provider.serverUrl, skillId),
          command,
          args,
          provider,
          signal,
          onRetry,
        );

        if (!payload || payload.ok === false) {
          throw searchErrorFromProviderPayload(payload, {
            fallbackMessage: formatPayloadError(payload, { stderr: '' }),
            provider: 'js-eyes',
          });
        }

        batches.push(normalizeUnifiedItems(payload, this.config, skillId));
      } catch (error) {
        if (isAbortError(error)) throw error;
        failures.push({ skillId, error: error.message, raw: error });
      }
    }

    if (batches.length === 0) {
      if (failures.length === 1 && failures[0].raw) throw wrapProviderError(failures[0].raw);
      const allTypedTransient = failures.length > 0 && failures.every((item) => (
        item.raw?.code === 'rate_limited' || item.raw?.retryable === true
      ));
      if (allTypedTransient) throw wrapProviderError(failures[0].raw);
      const details = failures.map(({ skillId, error }) => `${skillId}: ${error}`).join('; ');
      throw new SearchProviderError(`JS Eyes search failed for all skills: ${details}`, {
        code: 'provider_error',
        retryable: false,
        provider: 'js-eyes',
      });
    }

    return mergeSkillResults(batches, provider.maxResults);
  }

  async runCliQueued(queueKey, command, args, provider, signal, onRetry) {
    return enqueueJsEyesInvoke(queueKey, async () => (
      this.runCliWithRetry(command, args, provider, signal, onRetry)
    ), {
      signal,
      minIntervalMs: provider.minIntervalMs || 0,
    });
  }

  async runCliWithRetry(command, args, provider, signal, onRetry) {
    let lastError;
    let attempt = 0;
    while (true) {
      try {
        const payload = await this.runCli(command, args, provider.timeoutMs, signal);
        if (!payload || payload.ok === false) {
          throw searchErrorFromProviderPayload(payload, {
            fallbackMessage: formatPayloadError(payload, { stderr: '' }),
            provider: 'js-eyes',
          });
        }
        return payload;
      } catch (error) {
        if (isAbortError(error)) throw error;
        lastError = wrapProviderError(error);
        const allowed = retryLimit(provider, lastError);
        if (!lastError.retryable || attempt >= allowed) throw lastError;
        attempt += 1;
        onRetry?.();
        await waitRetryDelay(lastError.retryAfterMs || provider.minIntervalMs || 0, signal);
      }
    }
  }

  async runCli(command, args, timeoutMs, signal) {
    const spawnTarget = resolveSpawnTarget(command, args);
    const result = await runCommand({
      command: spawnTarget.command,
      args: spawnTarget.args,
      signal,
      timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS,
      spawnImpl: this.spawn,
    });

    return parseJsonOutput(result.stdout, result.stderr);
  }
}
