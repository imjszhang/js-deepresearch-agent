function countBound(raw, fallback = 0) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const number = Number(raw);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function resolveReportSettings(settings = {}) {
  const report = settings?.research?.report || {};
  const validation = settings?.research?.reportValidation || {};
  return {
    maxOutputTokens: countBound(report.maxOutputTokens, 0),
    maxAttempts: Math.max(1, Number(report.maxAttempts ?? validation.maxAttempts) || 2),
    minChars: Math.max(1, Number(validation.minChars) || 200),
  };
}
