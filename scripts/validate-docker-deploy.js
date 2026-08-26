#!/usr/bin/env node
/**
 * Validate Coolify multi-app Docker layout without requiring a running daemon.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVoiceAgentBaseUrl } from '../server/joinup-telegram/voice-agent-url.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function mustExist(rel) {
  assert.ok(fs.existsSync(path.join(root, rel)), `missing ${rel}`);
}

mustExist('Dockerfile');
mustExist('Dockerfile.app');
mustExist('Dockerfile.joinup-telegram');
mustExist('docker-compose.yaml');
mustExist('DEPLOY.md');

const appDf = read('Dockerfile.app');
assert.match(appDf, /CMD\s*\[\s*"npm",\s*"start"\s*\]/);
assert.match(appDf, /JOINUP_TELEGRAM_AUTOSTART=0/);
assert.match(appDf, /EXPOSE 8787/);
assert.match(appDf, /PUPPETEER_EXECUTABLE_PATH=\/usr\/local\/bin\/wa-chrome/);
assert.match(appDf, /browsers install chrome/);
assert.match(appDf, /PUPPETEER_CACHE_DIR=\/opt\/puppeteer-cache/);
assert.match(appDf, /FROM mcr\.microsoft\.com\/playwright/);

const rootDf = read('Dockerfile');
assert.match(rootDf, /PUPPETEER_EXECUTABLE_PATH=\/usr\/local\/bin\/wa-chrome/);
assert.match(rootDf, /browsers install chrome/);
assert.match(rootDf, /PUPPETEER_CACHE_DIR=\/opt\/puppeteer-cache/);

const tgDf = read('Dockerfile.joinup-telegram');
assert.match(tgDf, /CMD\s*\[\s*"npm",\s*"run",\s*"start:joinup-telegram"\s*\]/);
assert.match(tgDf, /AGENT_ACTIVITY_PERSIST=0/);
assert.match(tgDf, /JOINUP_THIN_BOT=1/);
assert.doesNotMatch(tgDf, /claude-code/);
assert.doesNotMatch(tgDf, /cursor\.com\/install/);
assert.doesNotMatch(tgDf, /EXPOSE /);
assert.match(tgDf, /node:22-bookworm/);
assert.doesNotMatch(tgDf, /^RUN apt-get/m);

const compose = read('docker-compose.yaml');
assert.match(compose, /dockerfile:\s*Dockerfile\.app/);
assert.match(compose, /dockerfile:\s*Dockerfile\.joinup-telegram/);
assert.match(compose, /VOICE_AGENT_URL=http:\/\/app:8787/);
assert.match(compose, /JOINUP_TELEGRAM_AUTOSTART=0/);

const pkg = JSON.parse(read('package.json'));
assert.equal(pkg.scripts['start:joinup-telegram'], 'node scripts/start-joinup-telegram.js');

assert.equal(
  resolveVoiceAgentBaseUrl({ VOICE_AGENT_URL: 'https://x.example/' }),
  'https://x.example'
);

const deploy = read('DEPLOY.md');
assert.match(deploy, /HTTPS required for microphone/);
assert.match(deploy, /Let’s Encrypt|Let's Encrypt/);
assert.match(deploy, /window\.isSecureContext/);
assert.match(deploy, /Coolify/);

const clientApp = read('client/app.js');
assert.match(clientApp, /window\.isSecureContext/);
assert.match(clientApp, /isGuiSecureContext/);
assert.match(clientApp, /getUserMedia/);
assert.match(clientApp, /insecureMicMessage/);

console.log('docker deploy layout validation: ok');
