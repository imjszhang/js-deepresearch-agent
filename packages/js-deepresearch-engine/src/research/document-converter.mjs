const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // %PDF
const RTF_MAGIC = [0x7b, 0x5c, 0x72, 0x74, 0x66]; // {\rtf
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

const CONTENT_TYPE_FORMATS = [
  [/application\/pdf\b/i, 'pdf'],
  [/application\/rtf\b|text\/rtf\b/i, 'rtf'],
  [/application\/epub\+zip\b/i, 'epub'],
  [/officedocument\.wordprocessingml/i, 'docx'],
  [/msword\b/i, 'doc'],
  [/officedocument\.spreadsheetml/i, 'xlsx'],
  [/ms-excel\b/i, 'xls'],
  [/officedocument\.presentationml/i, 'pptx'],
  [/ms-powerpoint\b/i, 'ppt'],
  [/application\/vnd\.oasis\.opendocument\.text/i, 'odt'],
  [/application\/vnd\.oasis\.opendocument\.spreadsheet/i, 'ods'],
  [/application\/vnd\.oasis\.opendocument\.presentation/i, 'odp'],
];

const EXTENSION_FORMATS = {
  pdf: 'pdf',
  doc: 'doc',
  docx: 'docx',
  docm: 'docx',
  rtf: 'rtf',
  epub: 'epub',
  xls: 'xls',
  xlsx: 'xlsx',
  xlsm: 'xlsx',
  xlsb: 'xlsx',
  ppt: 'ppt',
  pptx: 'pptx',
  pptm: 'pptx',
  pps: 'ppt',
  ppsx: 'pptx',
  odt: 'odt',
  ods: 'ods',
  odp: 'odp',
};

function startsWithBytes(bytes, magic) {
  if (!bytes || bytes.length < magic.length) return false;
  return magic.every((value, index) => bytes[index] === value);
}

function latinHead(bytes, max = 4096) {
  const end = Math.min(bytes?.length || 0, max);
  let text = '';
  for (let index = 0; index < end; index += 1) text += String.fromCharCode(bytes[index]);
  return text;
}

export function looksLikeHtmlBytes(bytes) {
  const head = latinHead(bytes, 512).trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<head');
}

export function looksLikeOfficeZip(bytes) {
  if (!startsWithBytes(bytes, ZIP_MAGIC)) return false;
  return /\[Content_Types\]\.xml|word\/|ppt\/|xl\/|mimetype/.test(latinHead(bytes));
}

export function detectMagicFormat(bytes) {
  if (startsWithBytes(bytes, PDF_MAGIC)) return 'pdf';
  if (startsWithBytes(bytes, RTF_MAGIC)) return 'rtf';
  if (startsWithBytes(bytes, OLE_MAGIC)) return 'doc';
  if (looksLikeOfficeZip(bytes)) return 'docx';
  return null;
}

function extensionOf(url = '') {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const match = pathname.match(/\.([a-z0-9]+)(?:$|[?#])/);
    return match ? match[1] : '';
  } catch {
    const match = String(url || '').toLowerCase().match(/\.([a-z0-9]+)(?:$|[?#])/);
    return match ? match[1] : '';
  }
}

export function detectDocumentFormat({ bytes, contentType = '', url = '' } = {}) {
  const magic = detectMagicFormat(bytes);
  if (magic) return magic;

  const type = String(contentType || '');
  for (const [pattern, format] of CONTENT_TYPE_FORMATS) {
    if (pattern.test(type)) {
      if (looksLikeHtmlBytes(bytes)) return null;
      return format;
    }
  }

  const format = EXTENSION_FORMATS[extensionOf(url)];
  if (!format) return null;
  if (looksLikeHtmlBytes(bytes)) return null;
  return format;
}

export function extractMarkdownTitle(markdown = '') {
  const heading = String(markdown || '').match(/^\s{0,3}#{1,6}\s+(.+)$/m);
  return heading ? heading[1].trim() : '';
}

export function filenameFromUrl(url = '') {
  try {
    const pathname = new URL(url).pathname;
    const part = pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(part);
  } catch {
    return '';
  }
}

async function defaultConvertBytes(bytes, format) {
  const anydoc = await import('@firecrawl/anydoc');
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return format ? anydoc.toMarkdownBytes(input, format) : anydoc.toMarkdownBytes(input);
}

export async function convertDocumentToMarkdown(bytes, {
  format = null,
  convert = null,
} = {}) {
  const impl = convert || defaultConvertBytes;
  try {
    const markdown = String(await impl(bytes, format) || '').trim();
    if (!markdown) {
      return { ok: false, error: 'Document converter returned empty Markdown', code: 'malformed' };
    }
    return { ok: true, markdown, format };
  } catch (error) {
    const code = error?.code || error?.name || 'convert_failed';
    if (code === 'ERR_MODULE_NOT_FOUND' || /Cannot find package '@firecrawl\/anydoc'/.test(error?.message || '')) {
      return { ok: false, error: 'Document converter unavailable', code: 'unavailable' };
    }
    return {
      ok: false,
      error: error?.message || 'Document conversion failed',
      code: typeof code === 'string' ? code : 'convert_failed',
    };
  }
}
