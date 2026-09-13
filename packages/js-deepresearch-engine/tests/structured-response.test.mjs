import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  STRUCTURED_RESPONSE_VERSION,
  buildStructuredRetryMessages,
  extractJsonObject,
  parseStructuredResponse,
} from '../src/research/structured-response.mjs';

const judgments = { judgments: [{ claimId: 'claim-1', verdict: 'supported' }] };
const accept = (value) => value?.judgments?.length === 1
  && value.judgments[0].claimId === 'claim-1'
  && value.judgments[0].verdict === 'supported';
const parse = (text, options = {}) => parseStructuredResponse(text, { accept, ...options });
const fence = (value) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

describe('structured response boundary', () => {
  it('accepts a complete strict response without editing identifiers or strings', () => {
    const value = { ...judgments, literal: 'a  b [gap-1] <think>literal</think> { [ " \\ \n' };
    assert.deepEqual(parse(JSON.stringify(value)).parsed, value);
  });

  it('finds an explicit JSON fence after an unmatched prose brace', () => {
    const result = parse(`The object shape uses { for an opening delimiter.\n${fence(judgments)}`);
    assert.equal(result.ok, true);
    assert.deepEqual(result.parsed, judgments);
    assert.equal(result.diagnostics.candidateCount, 1);
  });

  it('accepts prose surrounding one standalone object', () => {
    assert.deepEqual(parse(`Answer follows.\n${JSON.stringify(judgments)}\nEnd.`).parsed, judgments);
  });

  it('accepts empty-language and tilde fences', () => {
    assert.equal(parse(`~~~\n${JSON.stringify(judgments)}\n~~~`).ok, true);
    assert.equal(parse(`\`\`\`\n${JSON.stringify(judgments)}\n\`\`\``).ok, true);
  });

  it('deduplicates repeated complete answers with different object key order', () => {
    const reversed = { judgments: [{ verdict: 'supported', claimId: 'claim-1' }] };
    const result = parse(`${fence(judgments)}\nRepeated answer:\n${fence(reversed)}`);
    assert.equal(result.ok, true);
    assert.equal(result.diagnostics.candidateCount, 2);
    assert.equal(result.diagnostics.distinctCandidateCount, 1);
  });

  it('rejects two different schema-valid answers', () => {
    const result = parse(`${fence({ ...judgments, note: 'first' })}\n${fence({ ...judgments, note: 'second' })}`);
    assert.equal(result.reason, 'ambiguous_result');
    assert.equal(result.parsed, null);
  });

  it('does not select a good answer over a conflicting schema-invalid answer', () => {
    const result = parse(`${fence(judgments)}\n${fence({ judgments: [{ claimId: 'wrong', verdict: 'supported' }] })}`);
    assert.equal(result.reason, 'ambiguous_result');
    assert.equal(result.parsed, null);
  });

  it('preserves array order and extra fields when detecting conflicts', () => {
    const a = { ...judgments, evidence: ['first', 'second'] };
    const b = { ...judgments, evidence: ['second', 'first'] };
    assert.equal(parse(`${fence(a)}\n${fence(b)}`).reason, 'ambiguous_result');
    assert.equal(parse(`${fence(judgments)}\n${fence({ ...judgments, extra: null })}`).reason, 'ambiguous_result');
  });

  it('does not collapse distinct numeric lexemes after native numeric rounding', () => {
    assert.equal(parseStructuredResponse('Answer: {"n":9007199254740992}\n{"n":9007199254740993}').reason, 'ambiguous_result');
    assert.equal(parseStructuredResponse('Answer: {"n":0}\n{"n":-0}').reason, 'ambiguous_result');
  });

  it('rejects duplicate keys at every nesting level, including escaped aliases', () => {
    for (const text of [
      '{"judgments":[],"judgments":[]}',
      '{"judgments":[{"claimId":"wrong","claimId":"claim-1","verdict":"supported"}]}',
      '{"judgments":[],"judg\\u006dents":[]}',
    ]) assert.equal(parse(text).reason, 'invalid_json');
  });

  it('retains duplicate array entries so business validation rejects duplicate IDs', () => {
    const value = { judgments: [judgments.judgments[0], judgments.judgments[0]] };
    const result = parse(JSON.stringify(value));
    assert.equal(result.reason, 'schema_invalid');
    assert.equal(result.parsed.judgments.length, 2);
  });

  it('does not promote a valid nested answer out of a schema-invalid root', () => {
    const result = parse(`Answer: ${JSON.stringify({ wrapper: judgments })}`);
    assert.equal(result.reason, 'schema_invalid');
    assert.deepEqual(result.parsed, { wrapper: judgments });
  });

  it('does not extract an object inside a JSON string', () => {
    assert.equal(parse(JSON.stringify(JSON.stringify(judgments))).reason, 'schema_invalid');
    assert.equal(parse(`The quoted example is ${JSON.stringify(JSON.stringify(judgments))}.`).reason, 'no_complete_json');
  });

  it('handles escaped quotes, braces, brackets and Unicode keys', () => {
    const value = { ...judgments, '嵌套': { text: '\\" } [ { \\ end', nested: [true, null, 1e-3] } };
    assert.deepEqual(parse(`Answer: ${JSON.stringify(value)}`).parsed, value);
  });

  it('supports array roots without promoting nested objects', () => {
    const result = parseStructuredResponse(`Answer: ${fence([judgments])}`, { rootType: 'array', accept: (value) => value.length === 1 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.parsed, [judgments]);
    assert.equal(parse(JSON.stringify([judgments])).reason, 'schema_invalid');
  });

  it('permits explicit narrative citation policy without changing JSON candidates', () => {
    const policy = { ignoreStandaloneCitationTokens: true };
    const result = parse(`Sources [1], [1.1], [1.1, 2.1], [1.1-1.2], [1.1，2.1].\n${fence(judgments)}`, policy);
    assert.equal(result.ok, true);
    assert.equal(result.diagnostics.excludedRegionCount, 5);
    assert.deepEqual(result.parsed, judgments);
    assert.equal(parse(`Sources [1.1].\n${fence(judgments)}`).reason, 'ambiguous_result');
    assert.equal(parse(`Sources [1.1].\n${fence(judgments)}\n${fence({ different: true })}`, policy).reason, 'ambiguous_result');
  });

  it('does not ignore whole or fenced arrays under the narrative citation policy', () => {
    const policy = { ignoreStandaloneCitationTokens: true };
    assert.equal(parseStructuredResponse('[1.1]', policy).reason, 'schema_invalid');
    assert.equal(parseStructuredResponse(fence([1.1]), policy).reason, 'schema_invalid');
    assert.equal(parse(`${fence([1.1])}\n${fence(judgments)}`, policy).reason, 'ambiguous_result');
    assert.equal(parseStructuredResponse('Answer: [1.1]', { ...policy, rootType: 'array' }).ok, true);
    assert.equal(parse(`Sources ["1.1"].\n${fence(judgments)}`, policy).reason, 'ambiguous_result');
    assert.equal(parse(`Sources [{"id":1}].\n${fence(judgments)}`, policy).reason, 'ambiguous_result');
    assert.equal(parse(`Sources [[1.1]].\n${fence(judgments)}`, policy).reason, 'ambiguous_result');
  });

  it('ignores complete explicitly marked reasoning regions', () => {
    const result = parse(`<think>${fence({ judgments: [] })}</think>\n<analysis>${JSON.stringify({ other: 1 })}</analysis>\n${fence(judgments)}`);
    assert.equal(result.ok, true);
    assert.equal(result.diagnostics.excludedRegionCount, 2);
  });

  it('does not treat literal reasoning tags inside JSON strings as markup', () => {
    const value = { ...judgments, text: '<analysis>{"judgments":[]}</analysis>' };
    assert.deepEqual(parse(`Answer: ${JSON.stringify(value)}`).parsed, value);
  });

  it('excludes an unclosed reasoning region and permits a leading orphan closing tag', () => {
    assert.equal(parse(`<think>internal\n${fence(judgments)}`).reason, 'no_complete_json');
    assert.equal(parse(`</think>\n${fence(judgments)}`).ok, true);
  });

  it('requires reasoning closing tags to match their openers', () => {
    assert.equal(parse(`<think>private</analysis>\n${fence(judgments)}`).reason, 'no_complete_json');
    assert.equal(parse(`<think><analysis>private</analysis></think>\n${fence(judgments)}`).ok, true);
  });

  it('does not mine answers from code fences with another language', () => {
    assert.equal(parse(`\`\`\`javascript\n${JSON.stringify(judgments)}\n\`\`\``).reason, 'no_complete_json');
  });

  it('rejects unclosed fences and truncated JSON without repairing them', () => {
    assert.equal(parse(`\`\`\`json\n${JSON.stringify(judgments)}`).reason, 'no_complete_json');
    assert.equal(parse('{"judgments":[{"claimId":"claim-1"').reason, 'no_complete_json');
  });

  it('refuses even complete JSON when provider metadata reports truncation', () => {
    for (const finishReason of ['length', 'max_tokens', 'max_output_tokens']) {
      const result = parse(JSON.stringify(judgments), { metadata: { finishReason } });
      assert.equal(result.reason, 'truncated');
      assert.equal(result.parsed, null);
    }
    assert.equal(parse(JSON.stringify(judgments), { metadata: { finishReason: 'stop' } }).ok, true);
  });

  it('does not accept one complete root beside an incomplete or malformed root', () => {
    assert.equal(parse(`${fence(judgments)}\n{"judgments":`).reason, 'ambiguous_result');
    assert.equal(parse(`${fence(judgments)}\n{"judgments":undefined}`).reason, 'ambiguous_result');
  });

  it('does not repair invalid JSON syntax or concatenate roots in one fence', () => {
    for (const text of ['{"judgments":[],}', "{'judgments':[]}", '{"judgments":NaN}', '{"judgments":/*comment*/[]}']) {
      assert.equal(parse(text).ok, false);
    }
    assert.equal(parse(`\`\`\`json\n${JSON.stringify(judgments)}\n${JSON.stringify(judgments)}\n\`\`\``).reason, 'invalid_json');
  });

  it('reports empty and absent JSON distinctly', () => {
    assert.equal(parse('  \n').reason, 'empty');
    assert.equal(parse('Only an explanation.').reason, 'no_complete_json');
  });

  it('enforces input, scan, nesting and candidate limits before accepting a prefix', () => {
    assert.equal(parse(JSON.stringify(judgments), { maxInputChars: 5 }).reason, 'resource_limit');
    assert.equal(parse(JSON.stringify(judgments), { maxScanChars: 5 }).reason, 'resource_limit');
    assert.equal(parse(JSON.stringify(judgments), { maxDepth: 1 }).reason, 'resource_limit');
    assert.equal(parse(`${fence(judgments)}\n${fence(judgments)}`, { maxCandidates: 1 }).reason, 'resource_limit');
    assert.equal(parse(JSON.stringify(judgments), { maxDepth: Infinity }).reason, 'resource_limit');
  });

  it('applies the same depth limit to whole, wrapped and fenced roots', () => {
    for (let depth = 1; depth <= 8; depth += 1) {
      const raw = '{"value":'.repeat(depth) + 'true' + '}'.repeat(depth);
      for (const maxDepth of [depth - 1, depth, depth + 1].filter((value) => value > 0)) {
        for (const input of [raw, `Answer: ${raw}`, `\`\`\`json\n${raw}\n\`\`\``]) {
          assert.equal(parseStructuredResponse(input, { maxDepth }).ok, depth <= maxDepth);
        }
      }
    }
  });

  it('bounds scans of unfinished fence runs and repeated malformed reasoning tags', () => {
    for (const text of ['`'.repeat(100_000), '~~~ '.repeat(25_000), '<think '.repeat(15_000)]) {
      const result = parseStructuredResponse(text, { maxScanChars: 200_000 });
      assert.equal(result.ok, false);
      assert.ok(result.diagnostics.scannedChars <= 200_001);
    }
    assert.equal(parseStructuredResponse('`'.repeat(100_000), { maxScanChars: 500 }).reason, 'resource_limit');
  });

  it('round-trips varied JSON values identically across supported response envelopes', () => {
    let seed = 79;
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const value = (depth = 0) => {
      const type = Math.floor(random() * (depth >= 4 ? 5 : 7));
      if (type === 0) return null;
      if (type === 1) return random() < 0.5;
      if (type === 2) return (random() - 0.5) * 1000000;
      if (type === 3) return ['plain', 'a\\"}{[', '\n`<think> [gap-1]', '', '中文', '__proto__'][Math.floor(random() * 6)];
      if (type === 4) return Math.floor(random() * 100);
      if (type === 5) return Array.from({ length: Math.floor(random() * 4) }, () => value(depth + 1));
      return Object.fromEntries(Array.from({ length: Math.floor(random() * 4) }, (_, index) => [`key-${index}`, value(depth + 1)]));
    };
    for (let index = 0; index < 250; index += 1) {
      const input = { value: value() };
      for (const text of [JSON.stringify(input), `Answer: ${JSON.stringify(input)}`, fence(input)]) {
        const result = parseStructuredResponse(text);
        assert.equal(result.ok, true);
        assert.deepEqual(result.parsed, input);
      }
    }
  });

  it('invokes the business validator only after structural uniqueness is established', () => {
    let calls = 0;
    const validate = () => { calls += 1; return true; };
    parse(`${fence(judgments)}\n${fence(judgments)}`, { accept: validate });
    assert.equal(calls, 1);
    parse(`${fence(judgments)}\n${fence({ extra: true })}`, { accept: validate });
    assert.equal(calls, 1);
    const result = parse(JSON.stringify(judgments), { accept: () => { throw new Error('private validator detail'); } });
    assert.equal(result.reason, 'schema_invalid');
  });

  it('returns only safe counts and protocol metadata in diagnostics', () => {
    const secret = 'private-model-response-marker';
    const result = parse(JSON.stringify({ note: secret }));
    assert.equal(result.diagnostics.protocolVersion, STRUCTURED_RESPONSE_VERSION);
    assert.equal(JSON.stringify(result.diagnostics).includes(secret), false);
    assert.equal(Object.values(result.diagnostics).every((value) => Number.isSafeInteger(value)), true);
  });

  it('provides a conservative compatibility wrapper', () => {
    assert.deepEqual(extractJsonObject(fence(judgments)), judgments);
    assert.equal(extractJsonObject('[]'), null);
    assert.equal(extractJsonObject(`${fence(judgments)}\n${fence({ different: true })}`), null);
  });

  it('adds finite safe retry feedback without copying invalid model output', () => {
    const messages = [{ role: 'user', content: 'original task' }];
    const retry = buildStructuredRetryMessages(messages, 'ambiguous_result');
    assert.equal(messages.length, 1);
    assert.equal(retry.length, 2);
    assert.deepEqual(retry[0], messages[0]);
    assert.match(retry[1].content, /ambiguous_result/);
    const safe = buildStructuredRetryMessages(messages, 'private invalid response');
    assert.doesNotMatch(safe[1].content, /private invalid response/);
  });
});
