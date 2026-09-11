// Compatibility entry points share the production quality CLI, including its
// argument validation, budgets, provenance and execution gates.
import { parseArgs } from '../../src/cli-utils.mjs';

export const QUALITY_COMMANDS = Object.freeze([
  'verify-program', 'verify-artifacts', 'validate', 'plan', 'run', 'score', 'summary', 'compare',
  'calibrate', 'calibration-validate', 'calibration-summary', 'calibration-budget',
  'rebuild', 'improvement-gate', 'program-execution-gate',
]);

export async function routeQualityCommand(argv) {
  if (!QUALITY_COMMANDS.includes(parseArgs(argv).args[0])) return false;
  const { main } = await import('../benchmark-quality.mjs');
  try { await main(argv); }
  catch {
    // Match the canonical CLI's safe boundary: a provider exception must not
    // acquire a raw-message output path through a compatibility entry point.
    throw new Error('Quality benchmark failed. Check arguments, frozen inputs, and local structured failure records.');
  }
  return true;
}

export function requireInspectionMode(flags) {
  if (['mode', 'calibration', 'gold-dir', 'evaluation-dir', 'diagnose'].some(key => flags[key] !== undefined)
    || flags.llm || flags['no-llm'] === false || flags['no-llm'] === 'false') {
    throw Object.assign(new Error('MODEL_OBSERVATION_REQUIRES_SCORE: use score --mode model-observation --program-verification <file> --campaign <file> --gold-dir <dir>.'),
      { code: 'MODEL_OBSERVATION_REQUIRES_SCORE' });
  }
}
