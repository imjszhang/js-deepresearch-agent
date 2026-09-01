import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateReadinessGate } from '../src/research/adaptive/readiness-gate.mjs';
import { inferResearchProfile } from '../src/research/adaptive/research-profile.mjs';
import { ResearchState } from '../src/research/adaptive/research-state.mjs';
import { evaluateAnswerReadiness } from '../src/research/adaptive/agent-policy.mjs';

describe('deterministic readiness gate', () => {
  it('keeps required or critical gaps from becoming evidence_sufficient', () => {
    const query = '智谱 港交所 招股书 营收 控股股东';
    const inferred = inferResearchProfile(query);
    assert.deepEqual(inferred.requiredHosts, []);
    const profile = {
      flags: { primary_source: true, numeric: true },
      requiredHosts: ['hkexnews.hk'],
      requiredSourceTypes: ['primary_filing'],
      minIndependentSources: 2,
    };
    const gate = evaluateReadinessGate({
      query,
      profile,
      gaps: [{
        id: 'gap-1',
        question: query,
        status: 'open',
        priority: 'critical',
        requiredHosts: profile.requiredHosts,
        minIndependentSources: 2,
      }],
      findings: [{
        gapId: 'gap-1',
        sources: [{
          title: 'Media reprint',
          url: 'https://finance.sina.com.cn/zhipu',
          content: 'Media reprint of revenue figures without the prospectus.',
          fetchStatus: 'ok',
        }],
      }],
    });
    assert.equal(gate.pass, false);
    assert.ok(gate.failures.some((failure) => failure.code === 'required_host_missing' || failure.code === 'critical_gap_open'));
  });

  it('fails when a committed primary_filing is required but only reprints were read', () => {
    const query = '某公司投资尽调 监管披露 年报';
    const inferred = inferResearchProfile(query);
    assert.equal((inferred.requiredHosts || []).length, 0);
    assert.ok(!inferred.preferredHosts.includes('hkexnews.hk'));
    assert.ok(!inferred.requiredSourceTypes.includes('primary_filing'));
    const profile = {
      flags: { primary_source: true },
      requiredHosts: [],
      requiredSourceTypes: ['primary_filing'],
      minIndependentSources: 1,
    };
    const gate = evaluateReadinessGate({
      query,
      profile,
      gaps: [{
        id: 'gap-1',
        question: query,
        status: 'body_read',
        priority: 'critical',
        requiredHosts: [],
        requiredSourceTypes: ['primary_filing'],
      }],
      findings: [{
        gapId: 'gap-1',
        sources: [{
          title: 'Media reprint',
          url: 'https://finance.sina.com.cn/company',
          content: 'A media reprint of filing rumors with enough body text.',
          fetchStatus: 'ok',
        }],
      }],
    });
    assert.equal(gate.pass, false);
    assert.ok(gate.failures.some((failure) => failure.code === 'required_host_missing'));
  });

  it('does not satisfy one slot required host from another gap body', () => {
    const gate = evaluateReadinessGate({
      profile: { flags: {}, minIndependentSources: 1 },
      gaps: [{
        id: 'gap-2',
        question: 'SubjectA official status',
        status: 'verified',
        priority: 'normal',
        requiredSlot: true,
        requiredHosts: ['docs.example.com'],
      }],
      findings: [
        {
          gapId: 'gap-2',
          sources: [{
            url: 'https://unavailable.example/subject-a',
            fetchStatus: 'failed',
          }],
        },
        {
          gapId: 'gap-3',
          sources: [{
            url: 'https://docs.example.com/subject-b',
            content: 'SubjectB documentation body is available, but it does not belong to the SubjectA required slot.',
            fetchStatus: 'ok',
          }],
        },
      ],
    });

    assert.equal(gate.pass, false);
    assert.ok(gate.failures.some((failure) => failure.code === 'required_host_missing'));
  });

  it('does not treat same-domain reprints as two independent sources', () => {
    const query = 'Compare two local LLM tools for deployment';
    const gate = evaluateReadinessGate({
      query,
      profile: { flags: {}, minIndependentSources: 2 },
      gaps: [{ id: 'gap-1', question: query, status: 'body_read', priority: 'critical', requiredHosts: [] }],
      findings: [{
        gapId: 'gap-1',
        sources: [
          { url: 'https://news.example.com/one', content: 'First reprint of the same story with enough body text.', fetchStatus: 'ok' },
          { url: 'https://news.example.com/two', content: 'Second reprint of the same story with enough body text.', fetchStatus: 'ok' },
        ],
      }],
    });
    assert.equal(gate.pass, false);
    assert.ok(gate.failures.some((failure) => failure.code === 'independent_sources_short'));
  });

  it('does not let an LLM evaluator flip a failed gate to pass', async () => {
    const state = new ResearchState({
      query: '智谱 港交所 招股书 营收',
      profile: {
        flags: { primary_source: true },
        requiredHosts: ['hkexnews.hk'],
        requiredSourceTypes: ['primary_filing'],
        minIndependentSources: 2,
      },
    });
    state.findings.push({
      gapId: 'gap-1',
      sources: [{
        url: 'https://www.reuters.com/zhipu',
        content: 'Secondary coverage of listing rumors with enough body text.',
        fetchStatus: 'ok',
      }],
    });
    state.refreshBudgetView();
    assert.equal(state.readiness.pass, false);
    const evaluation = await evaluateAnswerReadiness({
      state,
      llm: {
        async complete() {
          return JSON.stringify({ pass: true, missingAspect: '' });
        },
      },
    });
    assert.equal(evaluation.llmPass, true);
    assert.equal(evaluation.pass, false);
    assert.equal(state.readiness.pass, false);
  });

  it('treats one local corpus as enough independent evidence', () => {
    const query = '房产操作攻略';
    const body = '本地材料详细说明税费、限购和持有周期，足以作为正文证据。';
    const gate = evaluateReadinessGate({
      query,
      profile: { flags: {}, minIndependentSources: 1, evidenceScope: 'local', requiredHosts: [] },
      gaps: [{ id: 'gap-1', question: query, status: 'verified', priority: 'critical', requiredHosts: [] }],
      findings: [{
        gapId: 'gap-1',
        sources: [
          { url: 'file:///notes/a.md', corpusRoot: '/notes', content: body, fetchStatus: 'ok' },
          { url: 'file:///notes/b.md', corpusRoot: '/notes', content: `${body} more`, fetchStatus: 'ok' },
        ],
      }],
    });
    assert.equal(gate.pass, true);
    assert.ok(!gate.failures.some((failure) => failure.code === 'independent_sources_short'));
  });

  it('rejects required slots that are only body_read, limited, or conflicting', () => {
    for (const status of ['body_read', 'limited', 'conflicting']) {
      const gate = evaluateReadinessGate({
        query: 'SubjectA official status',
        profile: { flags: {}, minIndependentSources: 1, requiredHosts: [] },
        gaps: [{
          id: 'gap-2',
          question: 'SubjectA official status',
          answerSlot: 'SubjectA',
          kind: 'slot',
          requiredSlot: true,
          status,
          priority: 'normal',
          requiredHosts: [],
        }],
        findings: [{
          gapId: 'gap-2',
          sources: [{
            url: 'https://docs.example.com/a',
            content: 'SubjectA publishes a first-party guide at docs.example.com that states production support began in 2026.',
            fetchStatus: 'ok',
          }],
        }],
      });
      assert.equal(gate.pass, false, status);
      assert.ok(gate.failures.some((failure) => failure.code === 'required_slot_open'), status);
    }
  });

  it('passes only when every required slot is verified', () => {
    const gate = evaluateReadinessGate({
      query: 'SubjectA official status',
      profile: { flags: {}, minIndependentSources: 1, requiredHosts: [] },
      gaps: [
        { id: 'gap-1', kind: 'root', rollup: true, requiredSlot: false, status: 'verified', priority: 'critical' },
        {
          id: 'gap-2',
          question: 'SubjectA official status',
          answerSlot: 'SubjectA',
          kind: 'slot',
          requiredSlot: true,
          status: 'verified',
          priority: 'normal',
          requiredHosts: [],
        },
      ],
      findings: [{
        gapId: 'gap-2',
        sources: [{
          url: 'https://docs.example.com/a',
          content: 'SubjectA publishes a first-party guide at docs.example.com that states production support began in 2026.',
          fetchStatus: 'ok',
        }],
      }],
    });
    assert.equal(gate.pass, true);
  });

  it('counts two local corpora as two independent evidence keys', () => {
    const query = '房产操作攻略';
    const body = '本地材料详细说明税费、限购和持有周期，足以作为正文证据。';
    const short = evaluateReadinessGate({
      query,
      profile: { flags: {}, minIndependentSources: 2, evidenceScope: 'local' },
      gaps: [{ id: 'gap-1', question: query, status: 'verified', priority: 'critical', requiredHosts: [] }],
      findings: [{
        gapId: 'gap-1',
        sources: [
          { url: 'file:///notes/a.md', corpusRoot: '/notes', content: body, fetchStatus: 'ok' },
          { url: 'file:///notes/b.md', corpusRoot: '/notes', content: `${body} extra`, fetchStatus: 'ok' },
        ],
      }],
    });
    assert.equal(short.pass, false);
    assert.ok(short.failures.some((failure) => failure.code === 'independent_sources_short'));
    assert.match(short.failures.find((failure) => failure.code === 'independent_sources_short').message, /local corpora/);
    const ready = evaluateReadinessGate({
      query,
      profile: { flags: {}, minIndependentSources: 2, evidenceScope: 'local' },
      gaps: [{ id: 'gap-1', question: query, status: 'verified', priority: 'critical', requiredHosts: [] }],
      findings: [{
        gapId: 'gap-1',
        sources: [
          { url: 'file:///notes/a.md', corpusRoot: '/notes', content: body, fetchStatus: 'ok' },
          { url: 'file:///reports/c.md', corpusRoot: '/reports', content: `${body} second channel`, fetchStatus: 'ok' },
        ],
      }],
    });
    assert.equal(ready.pass, true);
  });

  it('marks a local body as covering the root gap', () => {
    const query = '房产操作攻略';
    const state = new ResearchState({
      query,
      evidenceScope: 'local',
      profile: {
        flags: {},
        requiredHosts: [],
        requiredSourceTypes: [],
        minIndependentSources: 1,
        evidenceScope: 'local',
      },
    });
    state.findings.push({
      gapId: 'gap-1',
      sources: [{
        url: 'file:///notes/a.md',
        corpusRoot: '/notes',
        engine: 'local:notes',
        content: '本地材料详细说明税费、限购和持有周期，足以作为正文证据。',
        fetchStatus: 'ok',
      }],
    });
    state.syncGapCoverage();
    assert.equal(state.gaps[0].status, 'body_read');
    state.refreshBudgetView();
    assert.equal(state.readiness.pass, false);
    assert.ok(state.readiness.failures.some((failure) => (
      failure.code === 'critical_gap_open' || failure.code === 'contract_unavailable'
    )));
  });
});
