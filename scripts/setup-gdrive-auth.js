import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { OAuth2Client } from 'google-auth-library';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const CREDENTIALS_PATH = path.join(root, 'data', 'gdrive-credentials.json');
const TOKEN_PATH = path.join(root, 'data', 'gdrive-tokens.json');

// Scopes required for Google Drive MCP Server
const SCOPES = [
  'https://www.googleapis.com/auth/drive',
];

async function authorize() {
  let credentials;

  if (process.env.GDRIVE_CREDENTIALS_JSON) {
    try {
      credentials = JSON.parse(process.env.GDRIVE_CREDENTIALS_JSON);
      console.log('[GDrive Setup] Loaded credentials from process.env.GDRIVE_CREDENTIALS_JSON');
    } catch (err) {
      console.error('[GDrive Setup] Error parsing process.env.GDRIVE_CREDENTIALS_JSON:', err.message);
      process.exit(1);
    }
  } else if (fs.existsSync(CREDENTIALS_PATH)) {
    const content = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
    credentials = JSON.parse(content);
    console.log(`[GDrive Setup] Loaded credentials from ${CREDENTIALS_PATH}`);
  } else {
    console.error(`[GDrive Setup] Credentials file not found at ${CREDENTIALS_PATH} and GDRIVE_CREDENTIALS_JSON is not set.`);
    console.error('Please download your OAuth 2.0 Client ID JSON file from the Google Cloud Console and save it there, or set the GDRIVE_CREDENTIALS_JSON environment variable.');
    process.exit(1);
  }

  const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
  
  // Use first redirect URI or standard OOB (out of band) for headless
  const redirectUri = redirect_uris ? redirect_uris[0] : 'urn:ietf:wg:oauth:2.0:oob';
  
  const oAuth2Client = new OAuth2Client(client_id, client_secret, redirectUri);

  // Check if we already have a token
  if (fs.existsSync(TOKEN_PATH)) {
    console.log(`[GDrive Setup] Existing tokens found at ${TOKEN_PATH}.`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('Do you want to re-authenticate? (y/N) ');
    if (answer.toLowerCase() !== 'y') {
      console.log('Skipping re-authentication.');
      rl.close();
      return;
    }
    rl.close();
  }

  return getNewToken(oAuth2Client);
}

async function getNewToken(oAuth2Client) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline', // Crucial for receiving a refresh token
    prompt: 'consent',      // Force consent to ensure refresh token is given
    scope: SCOPES,
  });

  console.log('\n=============================================');
  console.log('AUTHORIZE THIS APP BY VISITING THIS URL:');
  console.log(authUrl);
  console.log('=============================================\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const code = await rl.question('Enter the code from that page here: ');
  rl.close();

  try {
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    console.log(`\n[GDrive Setup] Success! Token stored to ${TOKEN_PATH}`);
    
    // Also instruct user on how to use it with the MCP server
    console.log('\nMake sure your environment variables in .env are set for the MCP server:');
    console.log(`GDRIVE_CLIENT_ID=${oAuth2Client._clientId}`);
    console.log(`GDRIVE_CLIENT_SECRET=${oAuth2Client._clientSecret}`);
    console.log(`GDRIVE_REFRESH_TOKEN=${tokens.refresh_token}`);
    
  } catch (err) {
    console.error('Error retrieving access token', err);
  }
}

authorize().catch(console.error);
