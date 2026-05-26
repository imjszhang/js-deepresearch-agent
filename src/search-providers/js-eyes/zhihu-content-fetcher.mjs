import { spawn } from 'node:child_process';
import {
  appendFlag,
  isAbortError,
  parseJsonOutput,
  resolveCliCommand,
  resolveSpawnTarget,
  runCommand,
} from './cli-process.mjs';
import { normalizeJsEyesSearchConfig } from './normalize-js-eyes-search-config.mjs';
import { resolveProviderConfig } from './provider-config.mjs';

const ZHIHU_SKILL = 'js-zhihu-ops-skill';
const ARTICLE_PATTERN = /zhuanlan\.zhihu\.com\/p\//i;
const ANSWER_PATTERN = /(?:^|\.)zhihu\.com\/question\/\d+\/answer\/\d+/i;
const EMPTY_CONTENT_MARKERS = new Set(['未找到回答内容', '未找到文章内容']);

export function classifyZhihuUrl(url = '') {
  if (ARTICLE_PATTERN.test(url)) return 'article';
  if (ANSWER_PATTERN.test(url)) return 'answer';
  return null;
}

export function isZhihuSource(source = {}, url = '') {
  if (source.engine === 'js-eyes:zhihu') return true;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'zhihu.com' || host.endsWith('.zhihu.com');
  } catch {
    return false;
  }
}

export function buildZhihuReadCommand(url, subcommand, provider) {
  const args = ['skill', 'run', ZHIHU_SKILL, subcommand, url];
  appendFlag(args, '--ws-endpoint', provider.serverUrl);
  appendFlag(args, '--timeout-ms', Math.max(provider.timeoutMs || 0, 90000));
  args.push('--json', '--quiet');
  return args;
}

export function parseZhihuReadPayload(payload = {}) {
  if (!payload || payload.ok === false) {
    const error = payload?.error?.code
      || payload?.antiCrawlState?.reason
      || (typeof payload?.error === 'string' ? payload.error : null)
      || 'zhihu_read_failed';
    return {
      status: 'failed',
      error: String(error),
    };
  }

  const content = String(payload.result?.content || '').trim();
  if (!content || EMPTY_CONTENT_MARKERS.has(content)) {
    return {
      status: 'failed',
      error: 'Empty zhihu content',
    };
  }

  return {
    status: 'ok',
    title: payload.result?.title || payload.sourceUrl || '',
    content,
    backend: 'js-eyes:zhihu',
  };
}

export function createZhihuContentFetchHandler(options = {}) {
  const spawnImpl = options.spawn || spawn;

  return async function zhihuContentFetchHandler(url, context = {}) {
    const { source, settings, signal } = context;

    if (!isZhihuSource(source, url)) {
      return { status: 'unsupported' };
    }

    const subcommand = classifyZhihuUrl(url);
    if (!subcommand) {
      return { status: 'unsupported' };
    }

    const searchConfig = normalizeJsEyesSearchConfig(settings?.search || {});
    const provider = resolveProviderConfig(searchConfig);
    if (!provider.serverUrl) {
      return { status: 'unsupported' };
    }

    const command = resolveCliCommand(provider.cli);
    const args = buildZhihuReadCommand(url, subcommand, provider);
    const spawnTarget = resolveSpawnTarget(command, args);

    try {
      const result = await runCommand({
        command: spawnTarget.command,
        args: spawnTarget.args,
        signal,
        timeoutMs: Math.max(provider.timeoutMs || 0, 90000),
        spawnImpl,
      });
      const payload = parseJsonOutput(result.stdout, result.stderr);
      return parseZhihuReadPayload(payload);
    } catch (error) {
      if (isAbortError(error)) throw error;
      return {
        status: 'failed',
        error: error.message,
      };
    }
  };
}

export async function fetchZhihuContent(url, settings = {}, { signal, spawnImpl } = {}) {
  const handler = createZhihuContentFetchHandler({ spawn: spawnImpl });
  return handler(url, {
    source: { engine: 'js-eyes:zhihu' },
    settings,
    signal,
  });
}
