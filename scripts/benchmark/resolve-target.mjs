export function resolveBenchmarkTarget({ args, flags }) {
  const workDir = args[0] || null;
  const researchId = flags['research-id'] || null;

  if (workDir && researchId) {
    throw new Error('Use either <work-dir> or --research-id, not both.');
  }
  if (!workDir && !researchId) {
    throw new Error('Provide <work-dir> or --research-id.');
  }

  return { workDir, researchId };
}
