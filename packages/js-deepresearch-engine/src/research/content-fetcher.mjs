function stripHtml(html = '') {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTitle(html = '') {
  const match = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripHtml(match[1]) : '';
}

function extractLinks(html = '', baseUrl = '') {
  const links = [];
  for (const match of String(html).matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)) {
    try {
      const url = new URL(match[1], baseUrl);
      if (/^https?:$/.test(url.protocol)) links.push(url.toString());
    } catch { /* ignore malformed links */ }
  }
  return [...new Set(links)];
}

export async function fetchUrlContent(url, { signal, maxChars = 8000, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  if (signal) {
    if (signal.aborted) {
      clearTimeout(timeout);
      const error = new Error('Research aborted');
      error.name = 'AbortError';
      throw error;
    }
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'js-deepresearch-agent/1.0 (+research)',
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      return {
        status: 'failed',
        error: `HTTP ${response.status}`,
      };
    }

    const contentType = response.headers.get('content-type') || '';
    const raw = await response.text();
    const title = extractTitle(raw) || url;
    const links = contentType.includes('html') ? extractLinks(raw, url) : [];
    let content = contentType.includes('html') ? stripHtml(raw) : raw.trim();

    if (content.length > maxChars) {
      content = `${content.slice(0, maxChars)}\n[...truncated]`;
    }

    if (!content) {
      return {
        status: 'failed',
        error: 'Empty page content',
      };
    }

    return {
      status: 'ok',
      title,
      content,
      links,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error?.name === 'AbortError') {
      return {
        status: 'failed',
        error: `Timed out after ${timeoutMs}ms`,
      };
    }
    return {
      status: 'failed',
      error: error?.message || 'Fetch failed',
    };
  } finally {
    clearTimeout(timeout);
  }
}
