import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

function sourceFiles(target) {
  const absolute = path.resolve(repoRoot, target);
  if (!readdirSafe(absolute)) return [absolute];
  return readdirSync(absolute, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const child = path.join(absolute, entry.name);
      return entry.isDirectory() ? sourceFiles(child) : [child];
    });
}

function readdirSafe(target) {
  try {
    return readdirSync(target, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOTDIR') return null;
    throw error;
  }
}

function rg(args) {
  const [lineNumbers, pattern, ...targets] = args;
  assert.equal(lineNumbers, '-n');
  const matcher = new RegExp(pattern);
  const hits = targets.flatMap((target) => sourceFiles(target).flatMap((file) => (
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .flatMap((line, index) => (
        matcher.test(line)
          ? [`${path.relative(repoRoot, file)}:${index + 1}:${line}`]
          : []
      ))
  )));
  return hits.join('\n');
}

describe('query provenance static boundary', () => {
  it('does not keep rule query factories in production research code', () => {
    const hits = rg([
      '-n',
      'function (gapQuery|buildSlotRepairQueries|anchorSearchQuery|collectSearchAngleCandidates|nextUnusedSiteQueries|siteQueryTermVariants|shortSearchTerms|buildSiteHostQueries|hostSearchTerms)\\b',
      'packages/js-deepresearch-engine/src/research',
    ]);
    assert.equal(hits.trim(), '');
  });

  it('does not splice site: or leftover templates in strategy code', () => {
    const hits = rg([
      '-n',
      'primary source evidence|conflicting evidence correction|counterexample failure|`site:\\$\\{|site:\\$\\{',
      'packages/js-deepresearch-engine/src/research/strategies',
      'packages/js-deepresearch-engine/src/research/adaptive/agent-policy.mjs',
      'packages/js-deepresearch-engine/src/research/adaptive/slot-repair-scheduler.mjs',
      'packages/js-deepresearch-engine/src/research/quality-gates.mjs',
    ]);
    assert.equal(hits.trim(), '');
  });

  it('does not strip site: and rewrite the remainder as a new query', () => {
    const hits = rg([
      '-n',
      'replace\\(.*site:.*anchorSearchQuery|anchorSearchQuery\\([\\s\\S]{0,80}replace\\(.*site:',
      'packages/js-deepresearch-engine/src/research',
    ]);
    assert.equal(hits.trim(), '');
  });

  it('does not add language detection or static engine routing', () => {
    const hits = rg([
      '-n',
      'detectLanguage|isChineseQuery|STATIC_SEARCH_ENGINES|CHINESE_SEARCH_ENGINES|language === [\'"]zh[\'"].*engines|engines:.*bing.*google',
      'packages/js-deepresearch-engine/src',
    ]);
    assert.equal(hits.trim(), '');
  });

  it('does not add publisher classification host tables or expand WAF needles in place', () => {
    const hits = rg([
      '-n',
      'RESELLER_HOST_PATTERNS|MIRROR_HOST_PATTERNS|BRAND_IMPERSONATION|WAF_OR_ERROR_NEEDLES\\.push',
      'packages/js-deepresearch-engine/src',
    ]);
    assert.equal(hits.trim(), '');
  });
});
