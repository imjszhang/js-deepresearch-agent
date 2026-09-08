// Frozen v1 execution fixtures cover the compatibility algorithm, including retired
// decide/report-parse behavior. New runs and v2 tests use the public runner directly.
import { ResearchRunner as CurrentResearchRunner } from '../../src/index.mjs';
export class ResearchRunner extends CurrentResearchRunner {
  run(options) { return super.run({ ...options, executionVersion: 1 }); }
}
