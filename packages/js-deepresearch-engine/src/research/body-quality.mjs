import { assessmentBlocksSuccessfulBody } from './source-assessment.mjs';

const WAF_OR_ERROR_NEEDLES = [
  /just a moment/i,
  /attention required/i,
  /access denied/i,
  /cloudflare/i,
  /enable javascript/i,
  /checking your browser/i,
  /please wait while we verify/i,
  /captcha/i,
  /forbidden/i,
];

export const MIN_FETCHED_BODY_CHARS = 80;
export const MIN_PROVIDED_BODY_CHARS = 12;
export const MAX_RETRYABLE_READ_ATTEMPTS = 3;

export function isRetryableReadFailure(quality = {}) {
  if (quality?.successful) return false;
  return quality?.status === 'failed' || quality?.status === 'waf';
}

const TRANSPORT_ERROR_TYPES = new Set([
  'http_4xx',
  'http_429',
  'http_5xx',
  'timeout',
  'network',
]);

/**
 * True when a read failed because the target refused or never delivered the
 * bytes, as opposed to the planner picking a source that turned out to be
 * irrelevant or unreadable. Transport failures say nothing about whether the
 * research loop is making progress, so they are accounted for separately.
 */
export function isTransportReadFailure(source = {}, quality = {}) {
  if (quality?.successful) return false;
  if (quality?.status === 'irrelevant') return false;
  if (quality?.status === 'waf') return quality.reason !== 'assessment_unreadable';
  if (quality?.status !== 'failed') return false;
  if (source?.fetchStatus !== 'failed') return false;
  if (Number(source?.httpStatus) > 0) return true;
  return TRANSPORT_ERROR_TYPES.has(String(source?.fetchErrorType || ''));
}

/** Coarse reason label for a blocked host, used for diagnostics only. */
export function transportFailureReason(source = {}, quality = {}) {
  if (quality?.status === 'waf') return 'challenge';
  const httpStatus = Number(source?.httpStatus) || 0;
  if (httpStatus > 0) return `http_${httpStatus}`;
  return String(source?.fetchErrorType || 'transport_failed');
}

export function isWafShellText(text = '') {
  return WAF_OR_ERROR_NEEDLES.some((pattern) => pattern.test(String(text || '')));
}

export function isRawBinaryDocumentText(text = '') {
  const content = String(text || '');
  if (/^\s*%PDF-/i.test(content)) return true;
  if (/\/Type\s*\/Catalog/i.test(content) && /endobj/i.test(content)) return true;
  if (/^\s*\{\\rtf/i.test(content)) return true;
  return false;
}

export function isWafOrErrorBody(text = '', { fetchClaimedOk = false, minChars = MIN_FETCHED_BODY_CHARS } = {}) {
  const content = String(text || '');
  if (isWafShellText(content)) return true;
  if (!fetchClaimedOk) return false;
  const trimmed = content.trim();
  return trimmed.length > 0 && trimmed.length < minChars;
}

export function sourceBodyText(source = {}) {
  return String(source?.content || source?.summary || '').trim();
}

export function isSuccessfulBody(source = {}) {
  if (!source) return false;
  if (assessmentBlocksSuccessfulBody(source.assessment)) return false;
  if (source.fetchStatus === 'failed' || source.fetchStatus === 'waf' || source.fetchStatus === 'irrelevant'
    || source.bodyQuality === 'waf' || source.bodyQuality === 'irrelevant') {
    return false;
  }
  const text = sourceBodyText(source);
  if (!text) return false;
  if (isWafShellText(text) || isRawBinaryDocumentText(text)) return false;
  if (source.contentOrigin === 'fetched' && text.length < MIN_FETCHED_BODY_CHARS) return false;
  if (text.length < MIN_PROVIDED_BODY_CHARS) return false;
  return source.fetchStatus !== 'failed';
}

const DATE_PATTERNS = [
  /\b(20\d{2}|19\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/,
  /(20\d{2}|19\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/,
];

const MONTH_NAME_DATE = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),?\s+(20\d{2}|19\d{2})\b/i;
const MONTH_INDEX = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12',
};

function padDatePart(value) {
  return String(value || '').padStart(2, '0');
}

export function extractPublishedDate(...parts) {
  const text = parts.filter((part) => part != null && String(part).trim()).join(' ');
  if (!text) return null;
  for (const pattern of DATE_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;
    return `${match[1]}-${padDatePart(match[2])}-${padDatePart(match[3])}`;
  }
  const named = text.match(MONTH_NAME_DATE);
  if (named) {
    const month = MONTH_INDEX[named[1].slice(0, 4).toLowerCase()] || MONTH_INDEX[named[1].slice(0, 3).toLowerCase()];
    if (month) return `${named[3]}-${month}-${padDatePart(named[2])}`;
  }
  return null;
}

export function sourceHasObservableDate(source = {}) {
  if (source?.publishedAt || source?.date || source?.updatedAt || source?.published) return true;
  return Boolean(extractPublishedDate(source?.title, source?.summary, source?.content, source?.snippet));
}

export function classifyFetchedBody(source = {}) {
  if (assessmentBlocksSuccessfulBody(source.assessment)) {
    return { status: 'waf', successful: false, reason: 'assessment_unreadable' };
  }
  const text = sourceBodyText(source);
  if (source.fetchStatus === 'irrelevant' || source.bodyQuality === 'irrelevant') {
    return {
      status: 'irrelevant',
      successful: false,
      reason: source.relevanceDecision?.reasonCode || source.skipReason || 'body_irrelevant',
    };
  }
  if (source.fetchStatus === 'failed') {
    return { status: 'failed', successful: false, reason: source.fetchError || 'fetch_failed' };
  }
  if (!text) {
    return { status: 'failed', successful: false, reason: 'empty_body' };
  }
  if (isRawBinaryDocumentText(text)) {
    return { status: 'failed', successful: false, reason: 'raw_document_bytes' };
  }
  if (isWafShellText(text) || isWafOrErrorBody(text, { fetchClaimedOk: source.contentOrigin === 'fetched' })) {
    return { status: 'waf', successful: false, reason: 'waf_or_shell' };
  }
  if (source.contentOrigin === 'fetched' && text.length < MIN_FETCHED_BODY_CHARS) {
    return { status: 'waf', successful: false, reason: 'too_short_shell' };
  }
  if (!isSuccessfulBody({ ...source, content: text })) {
    return { status: 'failed', successful: false, reason: 'unusable_body' };
  }
  return { status: 'read', successful: true, reason: 'body_ok' };
}

export function sanitizeUnusableSourceBody(source = {}, quality = {}) {
  const failed = quality.successful === false
    || ['waf', 'failed', 'irrelevant'].includes(quality.status || source.bodyQuality || source.fetchStatus);
  if (!failed) return source;
  return {
    ...source,
    content: '',
    summary: '',
    snippet: source.snippet || '',
    bodyQuality: quality.status || source.bodyQuality,
    bodyQualityReason: quality.reason || source.bodyQualityReason || null,
  };
}
