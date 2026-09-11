import path from 'node:path';
import { safeVerificationFailure } from './verification-failure.mjs';
import { VERIFICATION_SCENARIOS } from './verification-scenarios.mjs';

const recoveryCase = VERIFICATION_SCENARIOS.find(s => s.id === 'V12').tests[0];

// Node's event stream gives actual executed tests, including skips and failures.
export default async function* reporter(source) {
  let eventCount = 0, planCount = 0;
  for await (const event of source) {
    if (!['test:pass', 'test:fail', 'test:summary', 'test:plan'].includes(event.type)) continue;
    const { name, file, skip, todo, nesting, counts, success, count } = event.data;
    const relativeFile = file ? path.relative(process.env.JDR_VERIFY_ROOT || process.cwd(), file).split(path.sep).join('/') : undefined;
    const verificationFailure = event.type === 'test:fail' && relativeFile === recoveryCase.file && name === recoveryCase.name
      ? safeVerificationFailure(event.data.details?.error) : undefined;
    eventCount++; if (event.type === 'test:plan') planCount++;
    yield `JDR_VERIFY_EVENT ${JSON.stringify({ type: event.type, name, file: relativeFile, ...(verificationFailure ? { verificationFailure } : {}), skip: Boolean(skip), todo: Boolean(todo), nesting, counts, success, ...(event.type === 'test:plan' ? { count } : {}) })}\n`;
  }
  yield `JDR_VERIFY_EVENT ${JSON.stringify({ type: 'verification:stream_end', eventCount, planCount })}\n`;
}
