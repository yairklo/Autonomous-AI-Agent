#!/usr/bin/env node
/**
 * Print joined WhatsApp groups from the running voice-agent session.
 *
 * Usage:
 *   npm run whatsapp:inspect
 *   VOICE_AGENT_URL=http://127.0.0.1:8787 npm run whatsapp:inspect
 */

const base = (
  process.env.VOICE_AGENT_URL ||
  `http://127.0.0.1:${process.env.PORT || 8787}`
).replace(/\/$/, '');

const res = await fetch(`${base}/api/whatsapp/groups`);
const body = await res.json().catch(() => ({}));
if (!res.ok || body.ok === false) {
  console.error(
    `[whatsapp:inspect] ${res.status} ${body.error || body.code || 'failed'}`
  );
  if (body.state) console.error(`[whatsapp:inspect] state=${body.state}`);
  process.exit(1);
}

console.log(
  `[whatsapp:inspect] ${body.count} group(s) | tracked/allow-listed=${body.trackedCount} | readOnly=${body.readOnlyCount} | newsletter=${body.newsletterCount}`
);
if (body.note) console.log(`[whatsapp:inspect] ${body.note}`);
for (const g of body.groups || []) {
  const flags = [
    g.tracked ? 'tracked' : 'untracked',
    g.isReadOnly ? 'readOnly' : '',
    g.isNewsletter ? 'newsletter' : '',
  ]
    .filter(Boolean)
    .join(',');
  console.log(`  - ${g.name || '(unnamed)'}  ${g.id}  [${flags}]`);
}
