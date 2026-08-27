import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { fetchUrlContent } from '../src/research/content-fetcher.mjs';
import {
  convertDocumentToMarkdown,
  detectDocumentFormat,
  extractMarkdownTitle,
} from '../src/research/document-converter.mjs';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function pdfBytesWithText(text) {
  const encoder = new TextEncoder();
  return encoder.encode(`%PDF-1.5\n1 0 obj\n<</Type/Catalog>>\nendobj\n% ${text}\n`);
}

describe('document converter', () => {
  it('detects PDFs from magic bytes, content-type, and URL', () => {
    const bytes = pdfBytesWithText('Zhipu revenue 7.24');
    assert.equal(detectDocumentFormat({ bytes }), 'pdf');
    assert.equal(detectDocumentFormat({
      bytes: encoderBytes('not a document'),
      contentType: 'application/pdf',
    }), 'pdf');
    assert.equal(detectDocumentFormat({
      bytes: encoderBytes('not a document'),
      url: 'https://www.hkexnews.hk/listedco/listconews/sehk/2026/0331/2026033101549.pdf',
    }), 'pdf');
  });

  it('does not treat an HTML interstitial at a .pdf URL as a document', () => {
    const html = encoderBytes('<!DOCTYPE html><html><title>Just a moment</title></html>');
    assert.equal(detectDocumentFormat({
      bytes: html,
      url: 'https://example.com/filing.pdf',
    }), null);
  });

  it('converts document bytes through the injected converter', async () => {
    const result = await convertDocumentToMarkdown(pdfBytesWithText('ignored'), {
      format: 'pdf',
      convert: async () => '# Annual results\n\nRevenue was 7.24 billion.',
    });
    assert.equal(result.ok, true);
    assert.match(result.markdown, /7\.24 billion/);
    assert.equal(extractMarkdownTitle(result.markdown), 'Annual results');
  });

  it('converts fetched PDFs to Markdown instead of raw objects', async () => {
    const bytes = pdfBytesWithText('Zhipu revenue 7.24');
    globalThis.fetch = async () => ({
      ok: true,
      headers: { get: () => 'application/pdf' },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });

    const result = await fetchUrlContent('https://www.hkexnews.hk/listedco/a.pdf', {
      convertDocument: async () => '# Knowledge Atlas Technology\n\n2025 revenue 7.24.',
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.documentFormat, 'pdf');
    assert.equal(result.converter, 'anydoc');
    assert.match(result.content, /2025 revenue 7\.24/);
    assert.doesNotMatch(result.content, /%PDF-/);
  });

  it('keeps more than the HTML 8000-char cap for converted documents', async () => {
    const bytes = pdfBytesWithText('long filing');
    globalThis.fetch = async () => ({
      ok: true,
      headers: { get: () => 'application/pdf' },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
    const markdown = `# Filing\n\n${'Revenue 7.24. '.repeat(900)}`;
    const result = await fetchUrlContent('https://www.hkexnews.hk/listedco/a.pdf', {
      maxChars: 8000,
      convertDocument: async () => markdown,
    });
    assert.equal(result.status, 'ok');
    assert.ok(result.content.length > 8000);
    assert.match(result.content, /Revenue 7\.24/);
  });

  it('converts a real text PDF when @firecrawl/anydoc is installed', async (t) => {
    let anydoc;
    try {
      anydoc = await import('@firecrawl/anydoc');
    } catch {
      t.skip('optional @firecrawl/anydoc is not installed');
      return;
    }
    const markdown = await anydoc.toMarkdownBytes(buildMinimalTextPdf('Zhipu revenue 7.24'));
    assert.match(String(markdown), /7\.24|Zhipu/i);
  });

  it('fails closed when a PDF cannot be converted', async () => {
    const bytes = pdfBytesWithText('broken');
    globalThis.fetch = async () => ({
      ok: true,
      headers: { get: () => 'application/pdf' },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });

    const result = await fetchUrlContent('https://www.hkexnews.hk/listedco/a.pdf', {
      convertDocument: async () => {
        const error = new Error('image-only PDF');
        error.code = 'unsupported';
        throw error;
      },
    });
    assert.equal(result.status, 'failed');
    assert.match(result.error, /image-only PDF/);
  });
});

function encoderBytes(text) {
  return new TextEncoder().encode(text);
}

function pdfOffset(value) {
  return String(value).padStart(10, '0');
}

function buildMinimalTextPdf(text) {
  const safe = String(text).replace(/[()\\]/g, ' ');
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    null,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  const stream = `BT /F1 12 Tf 24 96 Td (${safe}) Tj ET`;
  objects[3] = `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`;
  let body = '';
  const starts = [];
  for (const object of objects) {
    starts.push(body.length);
    body += object;
  }
  const header = '%PDF-1.4\n';
  const xrefStart = header.length + body.length;
  const xref = [
    'xref',
    '0 6',
    '0000000000 65535 f ',
    ...starts.map((start) => `${pdfOffset(header.length + start)} 00000 n `),
    'trailer\n<< /Size 6 /Root 1 0 R >>\n',
    `startxref\n${xrefStart}\n%%EOF\n`,
  ].join('\n');
  return new TextEncoder().encode(header + body + xref);
}
