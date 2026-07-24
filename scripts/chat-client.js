import http from 'node:http';

const prompt = process.argv[2] || 'Say hello in two short sentences.';
const payload = JSON.stringify({
  clientId: 'terminal-client',
  text: prompt
});

const req = http.request('http://127.0.0.1:8787/api/chat', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  }
}, (res) => {
  console.log(`[STATUS] ${res.statusCode}`);
  res.setEncoding('utf8');
  let buffer = '';
  
  res.on('data', (chunk) => {
    console.log(`[DATA CHUNK] length=${chunk.length}`);
    buffer += chunk;
    let split;
    while ((split = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, split);
      console.log(`[BLOCK] ${block.replace(/\n/g, '\\n')}`);
      buffer = buffer.slice(split + 2);
      
      const lines = block.split('\n');
      let event = '';
      let data = '';
      for (const line of lines) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      
      if (event === 'token' && data) {
        try {
          const parsed = JSON.parse(data);
          process.stdout.write(parsed.text || '');
        } catch {}
      }
      if (event === 'error' && data) {
        try {
          const parsed = JSON.parse(data);
          console.error('\n[SERVER ERROR]:', parsed.error);
        } catch {}
      }
    }
  });

  res.on('end', () => {
    console.log('\n\n--- [Stream Finished] ---');
  });
});

req.on('error', (err) => {
  console.error('Request failed:', err.message);
  console.error('Ensure the server is running on port 8787 first (npm start)');
});

req.write(payload);
req.end();
