import DOMPurify from 'dompurify';
import { marked } from 'marked';

export function renderMarkdown(markdown) {
  return DOMPurify.sanitize(marked.parse(markdown || ''));
}
