export async function apiGet(path) {
  return parse(await fetch(path));
}

export async function apiSend(path, method, body) {
  return parse(await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

async function parse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
  return data;
}
