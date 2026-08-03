const { OAuth2Client } = require('google-auth-library');
const fs = require('fs');
async function run() {
  const creds = JSON.parse(fs.readFileSync('data/gdrive-credentials.json'));
  const tokens = JSON.parse(fs.readFileSync('data/gdrive-tokens.json'));
  const client = new OAuth2Client(creds.installed.client_id, creds.installed.client_secret);
  client.setCredentials(tokens);
  
  const metadata = { name: 'test_creation.txt' };
  const boundary = 'foo_bar_baz';
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: text/plain\r\n\r\nThis is a test file.\r\n--${boundary}--`;
  
  const res = await client.request({
    url: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    data: body
  });
  console.log(res.data);
}
run().catch(console.error);
