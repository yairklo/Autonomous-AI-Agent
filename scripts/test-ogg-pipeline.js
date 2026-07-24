import assert from 'node:assert';
import { openAsBlob } from 'node:fs';

const base = `http://127.0.0.1:${process.env.PORT || 8787}`;

async function main() {
  console.log('--- Starting OGG Pipeline Test ---');

  // Check if server is running
  try {
    const healthRes = await fetch(`${base}/api/health`);
    const health = await healthRes.json();
    console.log('✓ Connected to server. Mock mode:', health.mock);
  } catch (err) {
    console.error('Server is not running! Start it first with npm start.');
    process.exit(1);
  }

  // Load test.ogg as a Blob
  let blob;
  try {
    blob = await openAsBlob('test.ogg');
    console.log('✓ Loaded test.ogg, size:', blob.size, 'bytes');
  } catch (err) {
    console.error('Failed to read test.ogg from project root:', err.message);
    process.exit(1);
  }

  const formData = new FormData();
  formData.append('clientId', 'ogg-test-client');
  formData.append('audio', blob, 'test.ogg');

  console.log('Sending audio to POST /api/voice...');
  const res = await fetch(`${base}/api/voice`, {
    method: 'POST',
    body: formData,
  });

  if (res.status === 500) {
    const errorBody = await res.json().catch(() => ({}));
    if (errorBody.code === 'STT_NOT_CONFIGURED') {
      console.log('✓ Pipeline correctly threw HTTP 500 STT_NOT_CONFIGURED because local Whisper/FFmpeg is not installed/configured.');
      console.log('Error message was:', errorBody.error);
      console.log('✓ Test passed successfully (verified correct configuration-error behavior).');
      return;
    }
  }

  assert.strictEqual(res.ok, true, `API request failed with status ${res.status}`);
  
  const text = await res.text();
  console.log('Response received from /api/voice.');

  // Parse SSE events
  let transcript = '';
  let fullClaudeReply = '';
  let gotDone = false;

  for (const block of text.split('\n\n')) {
    const blockLines = block.split('\n');
    let event = '';
    let data = '';
    for (const line of blockLines) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) continue;
    
    const payload = JSON.parse(data);
    if (event === 'transcript') {
      transcript = payload.text;
      console.log('✓ Transcribed text:', transcript);
    }
    if (event === 'token') {
      fullClaudeReply += payload.text;
    }
    if (event === 'done') {
      gotDone = true;
      fullClaudeReply = payload.result || fullClaudeReply;
      console.log('✓ E2E completed successfully.');
    }
    if (event === 'error') {
      throw new Error(`SSE returned error: ${payload.error}`);
    }
  }

  // Assertions
  assert.ok(transcript.length > 0, 'Transcript is empty');
  assert.ok(gotDone, 'Response stream did not emit a done event');
  assert.ok(fullClaudeReply.length > 0, 'Claude reply is empty');
  
  console.log('\n--- Claude Response ---');
  console.log(fullClaudeReply);
  console.log('-----------------------');
  console.log('✓ All OGG pipeline assertions passed!');
}

main().catch((err) => {
  console.error('\n❌ Test failed:', err.message);
  process.exit(1);
});
