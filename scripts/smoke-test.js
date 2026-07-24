/**
 * Smoke test against a running mock server (or starts nothing — expects server up).
 * Usage: node scripts/smoke-test.js [baseUrl]
 */
const base = (process.argv[2] || `http://127.0.0.1:${process.env.PORT || 8787}`).replace(
  /\/$/,
  ''
);

async function main() {
  const failures = [];

  const health = await fetchJson(`${base}/api/health`);
  assert(health.ok === true, 'health.ok', failures);
  console.log('✓ health', health.hostname, `mock=${health.mock}`);

  const index = await fetch(`${base}/`);
  assert(index.ok, 'GET /', failures);
  const html = await index.text();
  assert(html.includes('Push to talk') || html.includes('Hold to talk'), 'PWA markup', failures);
  console.log('✓ PWA index');

  for (const asset of ['/app.js', '/styles.css', '/manifest.json', '/sw.js', '/icon.svg']) {
    const r = await fetch(`${base}${asset}`);
    assert(r.ok, asset, failures);
  }
  console.log('✓ static assets');

  const clientId = `smoke-${Date.now()}`;
  const chatRes = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, text: 'Say hello in one short sentence.' }),
  });
  assert(chatRes.ok, 'POST /api/chat', failures);
  const body = await chatRes.text();
  assert(body.includes('event:'), 'SSE events present', failures);
  assert(body.includes('done') || body.includes('token'), 'SSE tokens/done', failures);
  console.log('✓ chat SSE stream');

  const sync = await fetchJson(`${base}/api/chat/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, text: 'Reply with the single word: pong' }),
  });
  assert(typeof sync.text === 'string' && sync.text.length > 0, 'sync text', failures);
  console.log('✓ chat sync:', sync.text.slice(0, 80));

  const reset = await fetchJson(`${base}/api/session/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId }),
  });
  assert(reset.ok === true, 'session reset', failures);
  console.log('✓ session reset');

  if (failures.length) {
    console.error('FAIL', failures);
    process.exit(1);
  }
  console.log('\nAll smoke checks passed.');
}

function assert(cond, label, failures) {
  if (!cond) failures.push(label);
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

main().catch((err) => {
  console.error('Smoke test crashed:', err.message);
  console.error('Is the server running? Try: npm run mock');
  process.exit(1);
});
