import { spawn } from 'node:child_process';
import {
  formatPayloadError,
  parseJsonOutput,
  resolveCliCommand,
  resolveSpawnTarget,
  runCommand,
} from './cli-process.mjs';
import { mergeSkillResults } from './merge-results.mjs';
import { resolveProviderConfig } from './provider-config.mjs';
import { resolveDriverMode } from './skill-registry.mjs';
import { normalizeUnifiedItems } from './source-normalizer.mjs';
import { buildSkillRunCommand } from './skill-run-driver.mjs';
import { buildUnifiedCommand } from './unified-driver.mjs';
import { DEFAULT_TIMEOUT_MS } from './constants.mjs';

export class JsEyesCliSearchEngine {
  constructor(config = {}, options = {}) {
    this.config = config;
    this.spawn = options.spawn || spawn;
    this.capabilities = {
      maxQuestionConcurrency: 1,
      ...(options.capabilities || {}),
    };
  }

  async search(query, { signal } = {}) {
    const trimmedQuery = String(query || '').trim();
    if (!trimmedQuery) return [];

    const provider = resolveProviderConfig(this.config);
    const driver = resolveDriverMode(provider, provider.skills);

    if (driver === 'skill-run') {
      return this.searchViaSkillRun(trimmedQuery, provider, { signal });
    }

    return this.searchViaUnified(trimmedQuery, provider, { signal });
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

  async searchViaUnified(query, provider, { signal } = {}) {
    const command = resolveCliCommand(provider.cli);
    const args = buildUnifiedCommand(query, provider);
    const payload = await this.runCli(command, args, provider.timeoutMs, signal);

    if (!payload || payload.ok === false) {
      throw new Error(formatPayloadError(payload, { stderr: '' }));
    }

    return normalizeUnifiedItems(payload, this.config);
  }

  async searchViaSkillRun(query, provider, { signal } = {}) {
    const command = resolveCliCommand(provider.cli);
    const batches = [];
    const failures = [];

    for (const skillId of provider.skills) {
      try {
        const args = buildSkillRunCommand(query, skillId, provider);
        const payload = await this.runCli(command, args, provider.timeoutMs, signal);

        if (!payload || payload.ok === false) {
          throw new Error(formatPayloadError(payload, { stderr: '' }));
        }

        batches.push(normalizeUnifiedItems(payload, this.config, skillId));
      } catch (error) {
        failures.push({ skillId, error: error.message });
      }
    }

    if (batches.length === 0) {
      const details = failures.map(({ skillId, error }) => `${skillId}: ${error}`).join('; ');
      throw new Error(`JS Eyes search failed for all skills: ${details}`);
    }

    return mergeSkillResults(batches, provider.maxResults);
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
