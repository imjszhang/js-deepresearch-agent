import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  ResearchRunner,
  createSearchEngine,
  emptyBulletLines,
  normalizeSourceUrl,
  resolveUrlContent,
  selectDiverseSources,
  stableSourceId,
} from 'js-deepresearch-engine';
import '../src/search-providers/register-local-search-engines.mjs';
import {
  LocalDirectorySearchEngine,
  createLocalFileContentFetchHandler,
  enumerateCorpusFiles,
  isPathInsideRoot,
  parseCorpusDirList,
  toFileUrl,
} from '../src/search-providers/local/public.mjs';

const tempDirs = [];

after(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = 'jdr-local-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(root, relative, content) {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function pdfBytesWithText(text) {
  return new TextEncoder().encode(`%PDF-1.5\n1 0 obj\n<</Type/Catalog>>\nendobj\n% ${text}\n`);
}

function buildMinimalTextPdf(text) {
  const safe = String(text).replace(/[()\\]/g, ' ');
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    null,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  const stream = `BT /F1 12 Tf 24 96 Td (${safe}) Tj ET`;
  objects[3] = `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`;
  let body = '';
  const starts = [];
  for (const object of objects) {
    starts.push(body.length);
    body += object;
  }
  const header = '%PDF-1.4\n';
  const xrefStart = header.length + body.length;
  const xref = [
    'xref',
    '0 6',
    '0000000000 65535 f ',
    ...starts.map((start) => `${String(header.length + start).padStart(10, '0')} 00000 n `),
    'trailer\n<< /Size 6 /Root 1 0 R >>\n',
    `startxref\n${xrefStart}\n%%EOF\n`,
  ].join('\n');
  return Buffer.from(header + body + xref);
}

function validReport(marker = 'local report') {
  return `# Research Report\n\n## Summary\n\nThis ${marker} summarizes the collected local evidence and clearly distinguishes verified observations from unresolved limitations. It provides enough structured prose to validate the report output contract.\n\n## Key Findings\n\n- Local files mention 监管处罚 with supporting detail. [1.1]\n\n## Caveats\n\nThe test evidence is intentionally limited.`;
}

function localContractProfile(question, extra = {}) {
  return JSON.stringify({
    requiredAnswerSlots: [{
      answerSlot: question,
      question,
      priority: 'normal',
    }],
    minIndependentSources: 1,
    ...extra,
  });
}

function localGapSupport(messages) {
  const text = (messages || []).map((item) => item.content).join('\n');
  const gapIds = [...new Set([...text.matchAll(/gapId:\s+(gap-\S+)/g)].map((match) => match[1]))];
  const quote = (text.match(/\] ([^\n]+)/) || [])[1] || '';
  return JSON.stringify({
    judgments: (gapIds.length ? gapIds : ['gap-2']).map((gapId) => ({
      gapId,
      verdict: quote.length >= 12 ? 'supported' : 'unverifiable',
      quote,
      reason: 'local body supports the slot',
    })),
  });
}

describe('local directory search engine', () => {
  it('enumerates files and ignores .git, node_modules, and .DS_Store', async () => {
    const root = makeTempDir();
    writeFile(root, 'keep.md', 'penalty notes');
    writeFile(root, '.git/config', 'git');
    writeFile(root, 'node_modules/pkg/index.md', 'should ignore');
    writeFile(root, '.DS_Store', 'mac');
    writeFile(root, 'skip.bin', 'binary');

    const files = await enumerateCorpusFiles({
      root,
      ignore: ['.git', 'node_modules', '.DS_Store'],
      extensions: ['md', 'txt', 'markdown', 'pdf', 'docx'],
    });

    assert.deepEqual(files.map((file) => file.relativePath).sort(), ['keep.md']);
  });

  it('round-robins multiple directories and deduplicates normalized paths', async () => {
    const dirA = makeTempDir('jdr-local-a-');
    const dirB = makeTempDir('jdr-local-b-');
    writeFile(dirA, 'a1.md', '监管处罚 case one');
    writeFile(dirA, 'a2.md', '监管处罚 case two');
    writeFile(dirB, 'b1.md', '监管处罚 case three');
    writeFile(dirB, 'shared.md', '监管处罚 shared');
    const sharedCopy = path.join(dirA, 'shared-link.md');
    fs.copyFileSync(path.join(dirB, 'shared.md'), sharedCopy);

    const engine = new LocalDirectorySearchEngine({
      maxResults: 3,
      local: { dirs: [dirA, dirB] },
    });
    const results = await engine.search('监管处罚');

    assert.equal(results.length, 3);
    assert.equal(results[0].engine.startsWith('local:'), true);
    assert.equal(results[1].engine.startsWith('local:'), true);
    assert.notEqual(results[0].engine, results[1].engine);
    const urls = results.map((item) => item.url);
    assert.equal(new Set(urls).size, urls.length);
    assert.ok(results.every((item) => item.url.startsWith('file://')));
    assert.ok(results.every((item) => !item.url.includes('..')));
  });

  it('returns surviving directory results when one channel fails', async () => {
    const okDir = makeTempDir();
    writeFile(okDir, 'hit.md', '监管处罚 surviving channel');
    const engine = new LocalDirectorySearchEngine({
      maxResults: 8,
      local: { dirs: [path.join(okDir, 'missing-channel'), okDir] },
    });

    const results = await engine.search('监管处罚');
    assert.equal(results.length, 1);
    assert.match(results[0].title, /hit\.md/);
    assert.equal(engine.lastChannelDiagnostics.some((item) => item.status === 'failed'), true);
    assert.equal(engine.lastChannelDiagnostics.some((item) => item.status === 'ok'), true);
  });

  it('throws an aggregate error when every directory fails', async () => {
    const engine = new LocalDirectorySearchEngine({
      local: { dirs: [path.join(os.tmpdir(), 'jdr-missing-a'), path.join(os.tmpdir(), 'jdr-missing-b')] },
    });

    await assert.rejects(
      engine.search('监管处罚'),
      /Local search failed for all directories/,
    );
  });

  it('throws immediately on AbortError instead of treating it as a partial failure', async () => {
    const dir = makeTempDir();
    writeFile(dir, 'hit.md', '监管处罚');
    const engine = new LocalDirectorySearchEngine({
      local: { dirs: [dir] },
    });
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(engine.search('监管处罚', { signal: controller.signal }), (error) => {
      assert.equal(error.name, 'AbortError');
      return true;
    });
  });

  it('does not return files outside the corpus root via symlink', async () => {
    const root = makeTempDir();
    const outside = makeTempDir('jdr-local-out-');
    const escaped = writeFile(outside, 'secret.md', '监管处罚 should not leak');
    writeFile(root, 'safe.md', '监管处罚 inside');
    fs.symlinkSync(escaped, path.join(root, 'escape.md'));

    const engine = new LocalDirectorySearchEngine({
      local: { dirs: [root] },
    });
    const results = await engine.search('监管处罚');
    assert.equal(results.some((item) => item.url.includes('secret.md')), false);
    assert.equal(results.some((item) => item.title === 'safe.md'), true);
  });

  it('reads matching markdown snippet text during search', async () => {
    const root = makeTempDir();
    writeFile(root, 'notes.md', 'Preface.\nThe company received 监管处罚 in 2024.\nEnd.');
    const engine = new LocalDirectorySearchEngine({
      local: { dirs: [root] },
    });
    const results = await engine.search('监管处罚');
    assert.equal(results.length, 1);
    assert.match(results[0].snippet, /监管处罚/);
    assert.equal(results[0].url, toFileUrl(fs.realpathSync(path.join(root, 'notes.md'))));
  });

  it('rejects an empty directory list instead of returning a silent empty success', async () => {
    const engine = new LocalDirectorySearchEngine({ local: { dirs: [] } });
    await assert.rejects(engine.search('anything'), /no corpus directories configured/);
  });

  it('can be instantiated by createSearchEngine({ search: { engine: "local" } })', async () => {
    const root = makeTempDir();
    writeFile(root, 'alpha.md', 'local corpus evidence');
    const engine = createSearchEngine({
      search: {
        engine: 'local',
        maxResults: 4,
        local: { dirs: [root] },
      },
    });
    const results = await engine.search('corpus evidence');
    assert.equal(results.length, 1);
    assert.equal(results[0].engine.startsWith('local:'), true);
  });
});

describe('local file content fetch handler', () => {
  it('reads markdown text from file:// inside a corpus root', async () => {
    const root = makeTempDir();
    const file = writeFile(root, 'body.md', '# Penalty\n\n监管处罚 details for the filing.');
    const handler = createLocalFileContentFetchHandler();
    const result = await handler(pathToFileURL(file).href, {
      settings: { search: { local: { dirs: [root] } } },
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.backend, 'local-file');
    assert.match(result.content, /监管处罚 details/);
  });

  it('converts a PDF fixture through document-converter', async () => {
    const root = makeTempDir();
    const file = path.join(root, 'filing.pdf');
    fs.writeFileSync(file, pdfBytesWithText('Zhipu revenue 7.24'));
    const handler = createLocalFileContentFetchHandler({
      convertDocument: async () => '# Annual results\n\nRevenue was 7.24 billion.',
    });
    const result = await handler(pathToFileURL(file).href, {
      settings: { search: { local: { dirs: [root] } } },
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.backend, 'local-file');
    assert.match(result.content, /7\.24 billion/);
    assert.doesNotMatch(result.content, /%PDF-/);
  });

  it('converts a real text PDF when @firecrawl/anydoc is installed', async (t) => {
    let anydoc;
    try {
      anydoc = await import('@firecrawl/anydoc');
    } catch {
      t.skip('optional @firecrawl/anydoc is not installed');
      return;
    }
    const root = makeTempDir();
    const file = path.join(root, 'real.pdf');
    fs.writeFileSync(file, buildMinimalTextPdf('Zhipu revenue 7.24'));
    const handler = createLocalFileContentFetchHandler({
      convertDocument: (bytes, format) => anydoc.toMarkdownBytes(bytes, format),
    });
    const result = await handler(pathToFileURL(file).href, {
      settings: { search: { local: { dirs: [root] } } },
    });
    assert.equal(result.status, 'ok');
    assert.match(String(result.content), /7\.24|Zhipu/i);
  });

  it('rejects file:// paths outside the corpus root, including ../ and outbound symlinks', async () => {
    const root = makeTempDir();
    const outside = makeTempDir('jdr-local-out-');
    const secret = writeFile(outside, 'secret.md', 'should not be read');
    writeFile(root, 'safe.md', 'inside');
    fs.symlinkSync(secret, path.join(root, 'link.md'));
    const handler = createLocalFileContentFetchHandler();
    const settings = { search: { local: { dirs: [root] } } };

    const escaped = await handler(pathToFileURL(path.resolve(root, '../secret-nope.md')).href, { settings });
    assert.equal(escaped.status, 'failed');

    const outsideUrl = await handler(pathToFileURL(secret).href, { settings });
    assert.equal(outsideUrl.status, 'failed');
    assert.equal(outsideUrl.content, undefined);

    const symlink = await handler(pathToFileURL(path.join(root, 'link.md')).href, { settings });
    assert.equal(symlink.status, 'failed');
    assert.equal(symlink.content, undefined);
  });

  it('returns failed when no corpus roots are configured and unsupported for non-file URLs', async () => {
    const handler = createLocalFileContentFetchHandler();
    const noRoots = await handler('file:///tmp/notes.md', { settings: { search: {} } });
    assert.equal(noRoots.status, 'failed');

    const web = await handler('https://example.com/a', { settings: { search: { local: { dirs: ['/tmp'] } } } });
    assert.equal(web.status, 'unsupported');
  });

  it('does not treat a directory as a readable file', async () => {
    const root = makeTempDir();
    const handler = createLocalFileContentFetchHandler();
    const result = await handler(pathToFileURL(root).href, {
      settings: { search: { local: { dirs: [root] } } },
    });
    assert.equal(result.status, 'failed');
  });
});

describe('local path helpers', () => {
  it('deduplicates and resolves corpus directory lists', () => {
    const dir = makeTempDir();
    const parsed = parseCorpusDirList(`${dir},${dir}, ${path.join(dir, '.')}`);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0], path.resolve(dir));
  });

  it('keeps descendant paths inside a corpus root and rejects parents', () => {
    const root = '/tmp/corpus-root';
    assert.equal(isPathInsideRoot('/tmp/corpus-root/a.md', root), true);
    assert.equal(isPathInsideRoot('/tmp/corpus-root', root), false);
    assert.equal(isPathInsideRoot('/tmp/other/a.md', root), false);
  });
});

describe('local focused integration', () => {
  it('runs focused search → enrich → findings with local file bodies', async () => {
    const root = makeTempDir();
    writeFile(root, 'penalty.md', 'The regulator issued 监管处罚 against the issuer in 2024 with a published decision.');
    writeFile(root, 'notes.md', 'Background notes about 监管处罚 and the related annual filing language.');

    const search = createSearchEngine({
      search: {
        engine: 'local',
        maxResults: 8,
        local: { dirs: [root] },
      },
    });

    const result = await new ResearchRunner().run({
      query: '监管处罚',
      settings: {
        llm: {},
        search: {
          engine: 'local',
          local: { dirs: [root] },
        },
        research: {
          strategy: 'focused',
          iterations: 1,
          questionsPerIteration: 0,
          concurrency: 1,
          focused: {
            fetchMode: 'full',
            iterationControl: { enabled: false },
            sourceSelection: { enabled: true, maxPerHostname: 2 },
          },
        },
      },
      search,
      llm: {
        async complete({ purpose, messages }) {
          if (purpose === 'research_profile') return localContractProfile('监管处罚');
          if (purpose === 'gap_support') return localGapSupport(messages);
          if (purpose === 'question_generation' || messages[0].content.includes('research planner')) {
            return '[]';
          }
          return validReport();
        },
      },
    });

    const sources = result.findings.flatMap((finding) => finding.sources || []);
    const localBodies = sources.filter((source) => source.fetchStatus === 'ok' && /监管处罚/.test(source.content || ''));
    assert.ok(localBodies.length >= 1);
    assert.ok(localBodies.every((source) => source.url.startsWith('file://')));
    assert.ok(result.quality.budget.usage.searchRequests >= 1);
    assert.ok(result.quality.budget.usage.sourceReads >= 1);
    assert.ok(!JSON.stringify(result.trace).includes('The regulator issued'));
  });
});

describe('resolveUrlContent local handler', () => {
  it('uses the registered local-file backend for file:// URLs', async () => {
    const root = makeTempDir();
    const file = writeFile(root, 'page.md', 'Enough local file text for the resolver to keep as fetched body content.');
    const fetched = await resolveUrlContent(pathToFileURL(file).href, {
      settings: { search: { local: { dirs: [root] } } },
    });
    assert.equal(fetched.status, 'ok');
    assert.equal(fetched.backend, 'local-file');
  });
});

describe('local exploratory integration', () => {
  it('sanitizes invented web hosts and can finish on local bodies', async () => {
    const dirA = makeTempDir('jdr-local-a-');
    const dirB = makeTempDir('jdr-local-b-');
    writeFile(dirA, 'guide.md', [
      '房产操作攻略：先核对税费和限购，再安排首付、贷款和持有周期。',
      '这份本地指南足够长，覆盖交易顺序、资金安排、过户材料与风险提示。',
      '作者强调先算清交易成本，再决定杠杆和持有时间，不要把二手传闻当成制度依据。',
    ].join(''));
    writeFile(dirB, 'notes.md', [
      '房产操作攻略补充材料：另一份本地材料说明过户流程、税费测算和持有成本。',
      '它作为第二个独立语料通道，补充了首付结构、贷款审批和退出条件的具体例子。',
      '这些内容足以构成可引用的正文证据，而不是搜索摘要。',
    ].join(''));

    const inner = createSearchEngine({
      search: { engine: 'local', maxResults: 8, local: { dirs: [dirA, dirB] } },
    });
    const queries = [];
    const search = {
      async search(query, options) {
        queries.push(query);
        return inner.search(query, options);
      },
    };

    const result = await new ResearchRunner().run({
      query: '房产操作攻略',
      settings: {
        llm: {},
        search: { engine: 'local', local: { dirs: [dirA, dirB] } },
        research: {
          strategy: 'exploratory',
          exploratory: {
            minLlmTokens: 0,
            maxLlmTokens: 0,
            maxSteps: 6,
            maxEvaluationRetries: 0,
            autoReadTopK: 2,
          },
          focused: { fetchMode: 'full' },
          budget: { maxSearchRequests: 3, maxSourceReads: 4, maxLlmTokens: 0 },
          quality: { entailment: 'rules' },
        },
      },
      search,
      llm: {
        async complete({ purpose, messages }) {
          if (purpose === 'research_profile') {
            return JSON.stringify({
              flags: { primary_source: true },
              requiredHosts: ['fang.com', 'sec.gov'],
              preferredHosts: ['ke.com'],
              requiredSourceTypes: ['primary_filing'],
              minIndependentSources: 2,
              gaps: [{ question: '哪个城市适合买', priority: 'normal', requiredHosts: ['fang.com'] }],
            });
          }
          if (purpose === 'gap_support') return localGapSupport(messages);
          if (purpose === 'agent_decision') {
            return JSON.stringify({ action: 'search', query: '房产操作攻略', gapId: 'gap-1' });
          }
          if (purpose === 'gap_decomposition') return '{"subQuestions":[]}';
          return `# Research Report

## Summary
本地语料给出了房产交易前应核对税费、限购和持有周期的操作要点，并区分了已核实观察与仍待核对的限制条件。这份材料足够长，可以形成结构化结论，也避免把未读网页域名当成必须满足的证据门槛。 [1.1]

## Key Findings
- 交易前应先核对税费与限购条件，再安排资金、贷款杠杆和持有周期，避免把未读网页来源当成一手证据。 [1.1]
`;
        },
      },
    });

    const rootGap = result.gaps.find((gap) => gap.id === 'gap-1') || result.gaps[0];
    assert.ok(rootGap);
    assert.ok(!(rootGap.requiredHosts || []).includes('fang.com'));
    assert.ok(!(rootGap.requiredHosts || []).includes('sec.gov'));
    assert.ok(!(rootGap.requiredSourceTypes || []).includes('primary_filing'));
    assert.equal(result.quality.stopReason, 'evidence_sufficient');
    assert.ok(result.trace.some((entry) => entry.profile?.evidenceScope === 'local' || entry.reasonCode === 'exploratory_loop'));
    assert.ok(queries.every((query) => !/\s+\d+(-\d+)?$/.test(query)));
    assert.ok(queries.every((query) => !/\bsite:/.test(query)));
    assert.equal(emptyBulletLines(result.report).length, 0);
    assert.match(result.report, /## Summary/);
    assert.match(result.report, /## Key Findings/);
    assert.equal([...result.report.matchAll(/Need \d+ independent domains/g)].length, 0);
    assert.ok(!result.quality.limitations.some((item) => /Need \d+ independent domains/.test(item)));
    const caveatBlock = result.report.split('## Caveats')[1] || '';
    const insufficient = [...caveatBlock.matchAll(/Insufficient direct evidence for:/g)];
    assert.ok(insufficient.length <= 1);
  });
});

describe('source identity for file URLs', () => {
  it('keeps normalizeSourceUrl and stableSourceId stable for file:// paths', () => {
    const filePath = '/tmp/notes/a.md';
    const left = normalizeSourceUrl(`${pathToFileURL(filePath).href}#section`);
    const right = normalizeSourceUrl(pathToFileURL(filePath).href);
    assert.equal(left, right);
    assert.equal(
      stableSourceId({ url: left }),
      stableSourceId({ url: right }),
    );
    assert.equal(
      normalizeSourceUrl(pathToFileURL('/tmp/notes/../notes/a.md').href),
      normalizeSourceUrl(pathToFileURL('/tmp/notes/a.md').href),
    );
  });

  it('does not drop file:// sources when mixed with web results', () => {
    const selected = selectDiverseSources([
      { title: 'Web1', url: 'https://example.com/1' },
      { title: 'Web2', url: 'https://example.com/2' },
      { title: 'Local1', url: 'file:///notes/a.md', corpusRoot: '/notes', engine: 'local:notes' },
      { title: 'Local2', url: 'file:///notes/b.md', corpusRoot: '/notes', engine: 'local:notes' },
      { title: 'Local3', url: 'file:///reports/c.md', corpusRoot: '/reports', engine: 'local:reports' },
    ], { enabled: true, maxPerHostname: 1 });

    assert.deepEqual(selected.map((item) => item.title), ['Web1', 'Local1', 'Local3']);
  });
});
