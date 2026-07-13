#!/usr/bin/env node
import '../src/config/bootstrap-env.mjs';

const baseUrl = String(process.env.JDR_EMBEDDING_BASE_URL || 'http://127.0.0.1:18789').replace(/\/$/, '');
const model = process.env.JDR_EMBEDDING_MODEL || 'openclaw/default';
const apiKey = process.env.JDR_EMBEDDING_API_KEY || process.env.OPENCLAW_GATEWAY_TOKEN || '';

async function main() {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetch(`${baseUrl}/v1/embeddings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, input: ['hello'] }),
  });

  const body = await response.text();
  if (!response.ok) {
    console.error(`OpenClaw embedding check failed: HTTP ${response.status}`);
    console.error(body.slice(0, 500));
    process.exitCode = 1;
    return;
  }

  const payload = JSON.parse(body);
  const vector = payload?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length === 0) {
    console.error('OpenClaw embedding check failed: empty embedding vector');
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify({
    ok: true,
    baseUrl,
    model,
    dimensions: vector.length,
    sample: vector.slice(0, 3),
  }, null, 2));
}

main().catch((error) => {
  console.error(`OpenClaw embedding check failed: ${error.message}`);
  process.exitCode = 1;
});
