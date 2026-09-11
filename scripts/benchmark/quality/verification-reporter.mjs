import path from 'node:path';
import { safeVerificationFailure } from './verification-failure.mjs';
import { VERIFICATION_SCENARIOS } from './verification-scenarios.mjs';

const recoveryCase = VERIFICATION_SCENARIOS.find(s => s.id === 'V12').tests[0];

// Node's event stream gives actual executed tests, including skips and failures.
export default async function* reporter(source) {
  let eventCount = 0, planCount = 0;
  for await (const event of source) {
    if (!['test:pass', 'test:fail', 'test:plan'].includes(event.type)) continue;
    const { name, file, skip, todo, nesting, count } = event.data;
    const relativeFile = file ? path.relative(process.env.JDR_VERIFY_ROOT || process.cwd(), file).split(path.sep).join('/') : undefined;
    const verificationFailure = event.type === 'test:fail' && relativeFile === recoveryCase.file && name === recoveryCase.name
      ? safeVerificationFailure(event.data.details?.error) : undefined;
    eventCount++; if (event.type === 'test:plan') planCount++;
    let output = `JDR_VERIFY_EVENT ${JSON.stringify({ type: event.type, name, file: relativeFile, ...(verificationFailure ? { verificationFailure } : {}), skip: Boolean(skip), todo: Boolean(todo), nesting, ...(event.type === 'test:plan' ? { count } : {}) })}\n`;
    // Node 20's --test-force-exit can terminate before this iterator reaches EOF.
    // The root plan closes the executed tests; keep it and its marker in one
    // output chunk. Optional summary events are unnecessary on every version.
    if (event.type === 'test:plan' && nesting === 0 && !file) {
      output += `JDR_VERIFY_EVENT ${JSON.stringify({ type: 'verification:stream_end', eventCount, planCount })}\n`;
    }
    yield output;
  }
}
