// Offline diagnostic only: never mutates sessions, invokes a provider, settles
// budgets, or changes a historical run's status. Input paths stay local.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseStructuredResponse, STRUCTURED_RESPONSE_VERSION } from '../packages/js-deepresearch-engine/src/research/structured-response.mjs';
import { acceptsClaimValidation } from '../packages/js-deepresearch-engine/src/research/claim-validation.mjs';
import { programImplementationIdentity } from './benchmark/quality/program-verification.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export function verifySavedClaimResponse({ requestFile, responseFile, expected }) {
  const requestBytes = fs.readFileSync(requestFile), responseBytes = fs.readFileSync(responseFile);
  const request = JSON.parse(requestBytes), response = JSON.parse(responseBytes).response;
  if (request.kind !== 'llm' || request.purpose !== 'claim_validation') throw new Error('Expected a recorded claim validation call');
  const body = typeof request.request.body === 'string' ? JSON.parse(request.request.body) : request.request.body;
  const input = JSON.parse(body.messages.find(m => m.role === 'user').content);
  const parsed = parseStructuredResponse(response.text, { metadata: response, accept: value => acceptsClaimValidation(value, input.claims) });
  const actual = parsed.ok ? 'accepted' : parsed.reason;
  if (actual !== expected) throw new Error(`Unexpected structural outcome: ${actual}`);
  if (hash(fs.readFileSync(requestFile)) !== hash(requestBytes) || hash(fs.readFileSync(responseFile)) !== hash(responseBytes)) {
    throw new Error('Historical response changed during replay');
  }
  return { callId: request.callId, expected, actual, requestHash: hash(requestBytes), responseHash: hash(responseBytes),
    claimCount: input.claims.length, verdictCount: parsed.ok ? parsed.parsed.judgments.length : 0,
    diagnostics: parsed.diagnostics, ...(parsed.ok ? { parsedHash: hash(JSON.stringify(parsed.parsed)) } : {}) };
}

export function verifyStructuredResponseReplay({ baselineFile, outputDir }) {
  const baseline = JSON.parse(fs.readFileSync(baselineFile));
  if (fs.existsSync(outputDir)) throw new Error('Replay output directory must be new');
  const cases = [
    [1, 'llm-49', 'truncated'], [1, 'llm-50', 'truncated'],
    [0, 'llm-70', 'accepted'], [0, 'llm-71', 'accepted'],
  ];
  const results = cases.map(([runIndex, callId, expected]) => {
    const matches = baseline.preserved.filter(item => item.file.startsWith(baseline.roots[runIndex] + path.sep) && item.file.endsWith(`/calls/${callId}.response.json`));
    const suitable = matches.filter(item => {
      const request = JSON.parse(fs.readFileSync(item.file.replace('.response.json', '.request.json')));
      return request.purpose === 'claim_validation';
    });
    if (suitable.length !== 1) throw new Error('Recorded diagnostic call is missing or ambiguous');
    const responseFile = suitable[0].file;
    return verifySavedClaimResponse({ requestFile: responseFile.replace('.response.json', '.request.json'), responseFile, expected });
  });
  for (const item of baseline.preserved) {
    if (hash(fs.readFileSync(item.file)) !== item.sha256) throw new Error('Historical run preservation check failed');
  }
  const result = { schemaVersion: 1, structuredResponseVersion: STRUCTURED_RESPONSE_VERSION,
    implementationIdentity: programImplementationIdentity().hash, status: 'passed', scope: 'recorded_response_structure_only',
    cases: results, preservedFileCount: baseline.preserved.length };
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'replay-verification.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  return { status: result.status, cases: results.map(({ callId, actual }) => ({ callId, actual })), preservedFileCount: result.preservedFileCount };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , baselineFile, outputDir] = process.argv;
  if (!baselineFile || !outputDir) throw new Error('Usage: node scripts/verify-structured-response-replay.mjs <baseline-file> <new-output-directory>');
  console.log(JSON.stringify(verifyStructuredResponseReplay({ baselineFile, outputDir })));
}
