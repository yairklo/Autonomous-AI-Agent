import cors from 'cors';
import express from 'express';
import mongoose from 'mongoose';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { config } from './config.js';
import { createLlmSessionManager, normalizeLlmProvider } from './llm-session.js';
import { guessExtension, transcribeAudio, whisperConfigured } from './stt.js';
import { executeMcpTool, listMcpTools } from './mcp-tools.js';
import { initGdriveMcp } from './gdrive-mcp-client.js';

// Pre-warm the Google Drive MCP Client connection in the background so tools are ready.
initGdriveMcp(console.log).catch((err) => {
  console.error('[mcp-gdrive] Failed to initialize on startup:', err);
});
import {
  buildSpecMarkdown,
  detectGrillMePack,
  formatGrillMeReply,
  getGrillMePack,
  listGrillMePacks,
  PACK_WHATSAPP_JOBS_CV,
} from './grill-me-packs.js';
import {
  detectCodingDispatch,
  detectWhatsappCvSubmit,
  detectWhatsappJobScan,
  detectManualJobLink,
  isInteractiveConversationRequest,
  wantsExplicitDispatch,
} from './task-router.js';
import { synthesizeToFile, ttsAvailableHint } from './tts.js';
import { mountRunEventsRoutes } from './run-events-http.js';
import { mountActivityRoutes } from './activity-http.js';
import { mountJoinUpRoutes } from './joinup-http.js';
import { mountCliAuthRoutes } from './cli-auth/cli-auth-http.js';
import { mountTokenMetricsRoutes } from './metrics/token-http.js';
import { mountWhatsappRoutes, maybeAutostartWhatsapp } from './whatsapp/http.js';
import { getSharedWhatsappSession } from './whatsapp/session.js';
import { mountJobsEngineRoutes } from './jobs-engine/http.js';
import { startIngestWhenReady } from './jobs-engine/ingest.js';
import { recordActivity } from './activity-store.js';
import { logMessage, getMessages } from './message-store.js';
import {
  loadJobsConfig,
  saveWhatsappGroups,
  WHATSAPP_GROUPS_OVERRIDE_PATH,
} from './jobs/jobs-config.js';

fs.mkdirSync(config.uploadsDir, { recursive: true });
fs.mkdirSync(config.cvApplicationsDir, { recursive: true });

const app = express();
const llmProvider = normalizeLlmProvider(config.llmProvider);
const claude = createLlmSessionManager({ provider: llmProvider });
const llmActorLabel =
  llmProvider === 'gemini' ? 'Gemini (voice)' : 'Claude (voice)';
const llmModel =
  typeof claude.getProviderInfo === 'function'
    ? claude.getProviderInfo().model
    : llmProvider === 'gemini'
      ? config.geminiModel
      : 'claude-cli';

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, config.uploadsDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || guessExtension(file.mimetype);
      cb(null, `${Date.now()}-${uuidv4()}${ext}`);
    },
  }),
  limits: { fileSize: config.maxUploadBytes },
});

app.use(cors());
app.use(express.json({ limit: '2mb' }));
mountRunEventsRoutes(app);
mountActivityRoutes(app);
mountJoinUpRoutes(app);
mountCliAuthRoutes(app);
mountTokenMetricsRoutes(app);
mountWhatsappRoutes(app);
mountJobsEngineRoutes(app);

app.get('/api/health', async (_req, res) => {
  const nets = os.networkInterfaces();
  const addresses = [];
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) addresses.push(n.address);
    }
  }
  res.json({
    ok: true,
    service: 'voice-agent',
    mock: config.mock,
    port: config.port,
    host: config.host,
    hostname: os.hostname(),
    lanAddresses: addresses,
    // Client/GUI: if missing, the process is stale (restart npm start for Cursor Live).
    runEvents: true,
    whisper: whisperConfigured(),
    serverTts: ttsAvailableHint(),
    autoDispatchCoding: config.autoDispatchCoding,
    autoScanWhatsappJobs: config.autoScanWhatsappJobs,
    autoSubmitWhatsappCv: config.autoSubmitWhatsappCv,
    // Chat clients require this. Missing ⇒ stale server that still auto-dispatches "Grill-Me Pack".
    grillMeConversation: true,
    // Interactive CLI sends interactiveChat:true — auto dispatch off unless explicit trigger.
    interactiveChatSafe: true,
    llmProvider,
    geminiModel: llmProvider === 'gemini' ? config.geminiModel : undefined,
    llmModel,
    grillMePacks: listGrillMePacks().map((p) => p.id),
    mcpTools: (await listMcpTools()).map((t) => t.name),
    whatsappExportsDir: config.whatsappExportsDir,
    cvApplicationsDir: config.cvApplicationsDir,
    time: new Date().toISOString(),
    whatsapp: (() => {
      const wa = getSharedWhatsappSession().snapshot();
      return {
        state: wa.state,
        ready: Boolean(wa.ready || wa.state === 'authenticated'),
        lastEventAt: wa.lastEventAt || null,
        error: wa.error || '',
        reconnectAttempt: wa.reconnectAttempt || 0,
      };
    })(),
  });
});

/**
 * Grill-Me domain packs (question banks for perfect specs before tools / dispatch).
 * GET /api/grill-me/packs
 * GET /api/grill-me/packs/:packId?locale=he|en&format=reply|spec|json
 */
/**
 * WhatsApp groups allow-list (config.json + optional data/whatsapp-groups.json).
 * GET  /api/jobs/whatsapp-groups
 * PUT  /api/jobs/whatsapp-groups  { groups: string[] }
 * POST /api/jobs/whatsapp-groups  { group: string }  — add one
 * DELETE /api/jobs/whatsapp-groups { group: string } — remove one
 */


app.get('/api/jobs/whatsapp-groups', (_req, res) => {
  try {
    const jobs = loadJobsConfig();
    res.json({
      ok: true,
      groups: jobs.whatsapp.groups,
      source: jobs.groupsSource,
      overridePath: WHATSAPP_GROUPS_OVERRIDE_PATH,
      connectHint:
        'On the VPS run: npm run whatsapp:connect (or docker exec … npm run whatsapp:connect) and scan the QR.',
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.put('/api/jobs/whatsapp-groups', (req, res) => {
  try {
    const groups = Array.isArray(req.body?.groups) ? req.body.groups : null;
    if (!groups) {
      res.status(400).json({ ok: false, error: 'Body must include groups: string[]' });
      return;
    }
    const saved = saveWhatsappGroups(groups);
    res.json({
      ok: true,
      groups: saved.groups,
      source: 'override',
      path: saved.path,
    });
  } catch (err) {
    const status = err.code === 'JOBS_GROUPS_EMPTY' ? 400 : 500;
    res.status(status).json({ ok: false, error: err.message });
  }
});

app.post('/api/jobs/whatsapp-groups', (req, res) => {
  try {
    const name = String(req.body?.group || req.body?.name || '').trim();
    if (!name) {
      res.status(400).json({ ok: false, error: 'Body must include group: string' });
      return;
    }
    const jobs = loadJobsConfig();
    const saved = saveWhatsappGroups([...jobs.whatsapp.groups, name]);
    res.json({ ok: true, groups: saved.groups, source: 'override', path: saved.path });
  } catch (err) {
    const status = err.code === 'JOBS_GROUPS_EMPTY' ? 400 : 500;
    res.status(status).json({ ok: false, error: err.message });
  }
});

app.delete('/api/jobs/whatsapp-groups', (req, res) => {
  try {
    const name = String(
      req.body?.group || req.body?.name || req.query?.group || ''
    ).trim();
    if (!name) {
      res.status(400).json({ ok: false, error: 'Provide group name to remove' });
      return;
    }
    const jobs = loadJobsConfig();
    const next = jobs.whatsapp.groups.filter(
      (g) => g.toLowerCase() !== name.toLowerCase()
    );
    if (next.length === jobs.whatsapp.groups.length) {
      res.status(404).json({ ok: false, error: `Group not found: ${name}` });
      return;
    }
    const saved = saveWhatsappGroups(next);
    res.json({ ok: true, groups: saved.groups, source: 'override', path: saved.path });
  } catch (err) {
    const status = err.code === 'JOBS_GROUPS_EMPTY' ? 400 : 500;
    res.status(status).json({ ok: false, error: err.message });
  }
});

app.get('/api/grill-me/packs', (_req, res) => {
  res.json({ ok: true, packs: listGrillMePacks() });
});

app.get('/api/grill-me/packs/:packId', (req, res) => {
  const packId = String(req.params.packId || '').trim() || PACK_WHATSAPP_JOBS_CV;
  const pack = getGrillMePack(packId);
  if (!pack) {
    return res.status(404).json({
      error: `Unknown Grill-Me pack: ${packId}`,
      known: listGrillMePacks().map((p) => p.id),
    });
  }
  const locale = String(req.query.locale || 'he').toLowerCase() === 'en' ? 'en' : 'he';
  const format = String(req.query.format || 'json').toLowerCase();
  if (format === 'reply') {
    res.type('text/plain; charset=utf-8').send(formatGrillMeReply(packId, { locale }));
    return;
  }
  if (format === 'spec') {
    res.type('text/markdown; charset=utf-8').send(buildSpecMarkdown(packId, { locale }));
    return;
  }
  res.json({ ok: true, locale, pack });
});

app.get('/api/session/:clientId', (req, res) => {
  const session = claude.getSession(req.params.clientId);
  res.json({ clientId: req.params.clientId, session });
});

app.post('/api/session/reset', (req, res) => {
  const clientId = req.body?.clientId || req.query.clientId;
  if (!clientId) {
    return res.status(400).json({ error: 'clientId required' });
  }
  claude.reset(clientId);
  res.json({ ok: true, clientId });
});

/**
 * Streaming chat. Body: { clientId, text, speak? }
 * Response: text/event-stream
 */
app.post('/api/chat', async (req, res) => {
  const clientId = String(req.body?.clientId || '').trim() || uuidv4();
  const text = String(req.body?.text || '').trim();
  // npm run chat always sets this — disables auto MCP except explicit dispatch triggers.
  const interactiveChat =
    req.body?.interactiveChat === true ||
    req.body?.interactiveChat === '1' ||
    String(clientId).startsWith('terminal-');
  console.log(
    `[API CHAT] received request. clientId=${clientId} llm=${llmProvider}/${llmModel} interactiveChat=${interactiveChat} text="${text}"`
  );
  if (!text) {
    return res.status(400).json({ error: 'text is required' });
  }

  initSse(res);
  sendSse(res, 'meta', { clientId, interactiveChat, llmProvider, llmModel });

  const voiceActivityId = `voice:${clientId}:${new Date().toISOString().slice(0, 10)}`;
  recordActivity({
    activityId: voiceActivityId,
    kind: 'chat_user',
    source: 'voice',
    platform: 'voice',
    actorId: clientId,
    actorLabel: 'Voice GUI',
    title: 'Voice / chat turn',
    text,
  });
  
  logMessage({
    sessionId: clientId,
    userId: clientId,
    channel: 'web-ui',
    role: 'user',
    content: text
  });

  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) {
      console.log('[API CHAT] connection aborted by client');
      ac.abort();
    }
  });

  // "שאל אותי" / Grill-Me Pack → conversation here; no Cursor / MCP auto-fire.
  const conversational = isInteractiveConversationRequest(text);
  const explicitDispatch = wantsExplicitDispatch(text);
  if (conversational || (interactiveChat && !explicitDispatch)) {
    console.log(
      '[API CHAT] Grill-Me / interactive chat — conversation only (no auto MCP)'
    );
  }

  // dispatch_coding_task ONLY on explicit trigger phrases (never for plain conversation).
  const dispatch =
    config.autoDispatchCoding && explicitDispatch && !conversational
      ? detectCodingDispatch(text, { interactiveChat })
      : null;
  if (dispatch) {
    try {
      await prepareDispatchTask(clientId, dispatch, ac.signal);
      await streamDispatchViaMcp(res, clientId, dispatch, ac.signal);
    } catch (err) {
      console.error('[API CHAT] MCP dispatch_coding_task error:', err);
      sendSse(res, 'error', { error: err.message || String(err) });
    }
    res.end();
    console.log('[API CHAT] MCP dispatch_coding_task request finished');
    return;
  }

  const waScan =
    !conversational &&
    config.autoScanWhatsappJobs
      ? detectWhatsappJobScan(text)
      : null;
  if (waScan) {
    try {
      await streamWhatsappJobScanViaMcp(res, clientId, waScan, ac.signal);
    } catch (err) {
      console.error('[API CHAT] MCP scan_whatsapp_jobs error:', err);
      sendSse(res, 'error', { error: err.message || String(err) });
    }
    res.end();
    console.log('[API CHAT] MCP scan_whatsapp_jobs request finished');
    return;
  }

  const waCv =
    !conversational &&
    config.autoSubmitWhatsappCv
      ? detectWhatsappCvSubmit(text)
      : null;

  const manualLink =
    !conversational
      ? detectManualJobLink(text)
      : null;

  if (manualLink) {
    try {
      sendSse(res, 'mcp_call', { tool: manualLink.mcpTool, args: manualLink.mcpArgs });
      const result = await executeMcpTool(manualLink.mcpTool, manualLink.mcpArgs, {
        onLog: (line) => sendSse(res, 'mcp_log', { line }),
      });
      sendSse(res, 'mcp_result', { result });
    } catch (err) {
      console.error('[API CHAT] MCP submit_manual_job_link error:', err);
      sendSse(res, 'error', { error: err.message || String(err) });
    }
    res.end();
    console.log('[API CHAT] MCP submit_manual_job_link request finished');
    return;
  }

  if (waCv) {
    try {
      await streamWhatsappCvSubmitViaMcp(res, clientId, waCv, ac.signal);
    } catch (err) {
      console.error('[API CHAT] MCP submit_whatsapp_job_cv error:', err);
      sendSse(res, 'error', { error: err.message || String(err) });
    }
    res.end();
    console.log('[API CHAT] MCP submit_whatsapp_job_cv request finished');
    return;
  }

  // Grill-Me Pack request → serve the domain questionnaire here (not Cursor).
  const packId = detectGrillMePack(text);
  if (packId && (conversational || interactiveChat)) {
    try {
      await streamGrillMePack(res, clientId, text, packId);
    } catch (err) {
      console.error('[API CHAT] Grill-Me pack error:', err);
      sendSse(res, 'error', { error: err.message || String(err) });
    }
    res.end();
    console.log(`[API CHAT] Grill-Me pack ${packId} served`);
    return;
  }

  let full = '';
  try {
    for await (const event of claude.ask(clientId, text, {
      signal: ac.signal,
      source: 'web_chat',
    })) {
      console.log(`[API CHAT] yielded event type=${event.type}`, event);
      if (event.type === 'text') {
        full += event.text;
        sendSse(res, 'token', { text: event.text });
      } else if (event.type === 'session') {
        sendSse(res, 'session', { sessionId: event.sessionId });
      } else if (event.type === 'done') {
        const result = event.result || full;
        recordActivity({
          activityId: voiceActivityId,
          kind: 'chat_assistant',
          source: 'voice',
          platform: 'voice',
          actorId: clientId,
          actorLabel: llmActorLabel,
          title: 'Voice / chat turn',
          text: result,
        });
        
        logMessage({
          sessionId: clientId,
          userId: clientId,
          channel: 'web-ui',
          role: 'assistant',
          content: result
        });
        sendSse(res, 'done', {
          result,
          clientId,
          llmProvider,
        });
      } else if (event.type === 'error') {
        recordActivity({
          activityId: voiceActivityId,
          kind: 'error',
          source: 'voice',
          platform: 'voice',
          actorId: clientId,
          actorLabel: llmActorLabel,
          text: event.error || 'chat error',
        });
        sendSse(res, 'error', {
          error: event.error,
          code: event.code,
          authUrl: event.authUrl,
          tool: event.tool,
        });
      }
    }
  } catch (err) {
    console.error('[API CHAT] error caught:', err);
    recordActivity({
      activityId: voiceActivityId,
      kind: 'error',
      source: 'voice',
      platform: 'voice',
      actorId: clientId,
      actorLabel: 'Voice GUI',
      text: err.message || String(err),
    });
    sendSse(res, 'error', { error: err.message || String(err) });
  }
  res.end();
  console.log('[API CHAT] request finished');
});

/**
 * Non-streaming convenience endpoint for Shortcuts / Tasker.
 */
app.post('/api/chat/sync', async (req, res) => {
  const clientId = String(req.body?.clientId || '').trim() || uuidv4();
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });

  const interactiveChat =
    req.body?.interactiveChat === true ||
    req.body?.interactiveChat === '1' ||
    String(clientId).startsWith('terminal-');
  const conversational = isInteractiveConversationRequest(text);
  const explicitDispatch = wantsExplicitDispatch(text);

  const dispatch =
    config.autoDispatchCoding && explicitDispatch && !conversational
      ? detectCodingDispatch(text, { interactiveChat })
      : null;
  if (dispatch) {
    try {
      await prepareDispatchTask(clientId, dispatch);
      const logs = [];
      await executeMcpTool('dispatch_coding_task', dispatch.mcpArgs, {
        onLog: (line) => {
          console.log(line);
          logs.push(line);
        },
      });
      return res.json({
        clientId,
        sessionId: null,
        text: `Dispatched coding task via MCP tool dispatch_coding_task for ${dispatch.project}.`,
        dispatched: true,
        mcpTool: 'dispatch_coding_task',
        logs: logs.slice(-20),
      });
    } catch (err) {
      return res.status(500).json({ error: err.message || String(err), clientId });
    }
  }

  const waScan =
    !conversational && config.autoScanWhatsappJobs
      ? detectWhatsappJobScan(text)
      : null;
  if (waScan) {
    try {
      const logs = [];
      const mcpResult = await executeMcpTool('scan_whatsapp_jobs', waScan.mcpArgs, {
        onLog: (line) => {
          console.log(line);
          logs.push(line);
        },
      });
      const summary = formatWhatsappJobScanSummary(mcpResult);
      return res.json({
        clientId,
        sessionId: null,
        text: summary,
        mcpTool: 'scan_whatsapp_jobs',
        jobCount: mcpResult.jobCount,
        jobs: mcpResult.jobs,
        logs: logs.slice(-20),
      });
    } catch (err) {
      return res.status(500).json({ error: err.message || String(err), clientId });
    }
  }

  const waCv =
    !conversational && config.autoSubmitWhatsappCv
      ? detectWhatsappCvSubmit(text)
      : null;
  if (waCv) {
    try {
      const logs = [];
      const mcpArgs = await resolveCvSubmitArgs(waCv, {
        onLog: (line) => {
          console.log(line);
          logs.push(line);
        },
      });
      const mcpResult = await executeMcpTool('submit_whatsapp_job_cv', mcpArgs, {
        onLog: (line) => {
          console.log(line);
          logs.push(line);
        },
      });
      const summary = formatWhatsappCvSubmitSummary(mcpResult);
      return res.json({
        clientId,
        sessionId: null,
        text: summary,
        mcpTool: 'submit_whatsapp_job_cv',
        application: mcpResult.application,
        logs: logs.slice(-20),
      });
    } catch (err) {
      return res.status(500).json({ error: err.message || String(err), clientId });
    }
  }

  const packId = conversational ? detectGrillMePack(text) : null;
  if (packId) {
    const locale = /[א-ת]/.test(text) ? 'he' : 'en';
    const reply = formatGrillMeReply(packId, { locale, openingLimit: 5 });
    return res.json({
      clientId,
      sessionId: null,
      text: reply,
      grillMePack: packId,
    });
  }

  let full = '';
  let sessionId = null;
  try {
    for await (const event of claude.ask(clientId, text, { source: 'web_chat' })) {
      if (event.type === 'text') full += event.text;
      if (event.type === 'session') sessionId = event.sessionId;
      if (event.type === 'done') full = event.result || full;
      if (event.type === 'error') {
        return res.status(500).json({ error: event.error, clientId });
      }
    }
    res.json({ clientId, sessionId, text: full });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err), clientId });
  }
});

/**
 * Voice turn: multipart audio and/or text. Streams like /api/chat.
 * fields: clientId, text (optional), audio (file, optional)
 */
app.post('/api/voice', upload.single('audio'), async (req, res) => {
  const clientId = String(req.body?.clientId || '').trim() || uuidv4();
  let text = String(req.body?.text || '').trim();
  const audioPath = req.file?.path;

  if (!text && audioPath && !config.mock) {
    if (!whisperConfigured()) {
      if (req.file?.path) {
        fs.unlink(req.file.path, () => {});
      }
      return res.status(500).json({
        code: 'STT_NOT_CONFIGURED',
        error:
          'Server STT unavailable: Whisper binary not configured. Set WHISPER_BIN in the environment to enable local STT, or use client-side Web Speech API.',
      });
    }
  }

  initSse(res);
  sendSse(res, 'meta', { clientId });

  try {
    if (!text && audioPath) {
      sendSse(res, 'status', { stage: 'stt' });
      text = await transcribeAudio(audioPath);
      sendSse(res, 'transcript', { text });
    }

    if (!text) {
      sendSse(res, 'error', {
        error:
          'Provide text (client STT) or audio with WHISPER_BIN configured on the server.',
      });
      return res.end();
    }
    
    logMessage({
      sessionId: clientId,
      userId: clientId,
      channel: 'voice',
      role: 'user',
      content: text
    });

    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) ac.abort();
    });

    const conversational = isInteractiveConversationRequest(text);
    const dispatch =
      !conversational && config.autoDispatchCoding
        ? detectCodingDispatch(text)
        : null;
    if (dispatch) {
      await prepareDispatchTask(clientId, dispatch, ac.signal);
      await streamDispatchViaMcp(res, clientId, dispatch, ac.signal);
      return res.end();
    }

    const packId = conversational ? detectGrillMePack(text) : null;
    if (packId) {
      await streamGrillMePack(res, clientId, text, packId);
      return res.end();
    }

    sendSse(res, 'status', { stage: 'claude' });

    let full = '';
    for await (const event of claude.ask(clientId, text, {
      signal: ac.signal,
      source: 'voice',
    })) {
      if (event.type === 'text') {
        full += event.text;
        sendSse(res, 'token', { text: event.text });
      } else if (event.type === 'session') {
        sendSse(res, 'session', { sessionId: event.sessionId });
      } else if (event.type === 'done') {
        const result = event.result || full;
        logMessage({
          sessionId: clientId,
          userId: clientId,
          channel: 'voice',
          role: 'assistant',
          content: result
        });
        sendSse(res, 'done', {
          result: result,
          clientId,
          transcript: text,
        });
      } else if (event.type === 'error') {
        sendSse(res, 'error', { error: event.error });
      }
    }
  } catch (err) {
    sendSse(res, 'error', {
      error: err.message || String(err),
      code: err.code,
    });
  } finally {
    if (audioPath) {
      fs.promises.unlink(audioPath).catch(() => {});
    }
  }
  res.end();
});

/**
 * Optional server TTS — returns audio/wav when local engine works.
 */
app.post('/api/tts', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });

  const out = path.join(config.uploadsDir, `tts-${uuidv4()}.wav`);
  try {
    const result = await synthesizeToFile(text, out);
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('X-TTS-Engine', result.engine);
    const stream = fs.createReadStream(result.path);
    stream.pipe(res);
    let unlinked = false;
    const cleanup = () => {
      if (unlinked) return;
      unlinked = true;
      fs.promises.unlink(result.path).catch(() => {});
    };
    stream.on('close', cleanup);
    stream.on('error', cleanup);
    res.on('close', cleanup);
    res.on('finish', cleanup);
  } catch (err) {
    res.status(501).json({
      error: err.message || String(err),
      hint: 'Use client SpeechSynthesis, or install a local TTS engine.',
      available: ttsAvailableHint(),
    });
  }
});

app.use(express.static(config.clientDir, { extensions: ['html'] }));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal error' });
});

function initSse(res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * After Grill-Me confirmation, ask Claude for the refined final task prompt
 * when the user's message is only a short "dispatch / skip Grill-Me" confirm.
 */
async function prepareDispatchTask(clientId, dispatch, signal) {
  if (!dispatch?.shortConfirmation) return dispatch;
  const session = claude.getSession(clientId);
  if (!session?.sessionId) return dispatch;

  const refinePrompt =
    'The user confirmed dispatch after Grill-Me Mode. ' +
    'Based on our refined requirements, output ONLY the final taskDescription ' +
    'string to pass to dispatch_coding_task (complete, self-contained, ready for ' +
    'Cursor Agent CLI). No preamble, no markdown fences, no questions.';

  let refined = '';
  for await (const event of claude.ask(clientId, refinePrompt, {
    signal,
    source: 'web_chat',
  })) {
    if (event.type === 'text') refined += event.text;
    if (event.type === 'done') refined = event.result || refined;
    if (event.type === 'error') {
      throw new Error(event.error || 'Failed to refine Grill-Me task for dispatch');
    }
  }

  refined = String(refined || '').trim();
  if (refined) {
    dispatch.task = refined;
    dispatch.mcpArgs = {
      ...dispatch.mcpArgs,
      taskDescription: refined,
    };
  }
  return dispatch;
}

/**
 * Serve a domain Grill-Me Pack questionnaire in-chat (never dispatch to Cursor).
 */
async function streamGrillMePack(res, clientId, text, packId) {
  const locale = /[א-ת]/.test(text) ? 'he' : 'en';
  const reply = formatGrillMeReply(packId, { locale, openingLimit: 5 });
  sendSse(res, 'status', { stage: 'grill_me_pack', packId });
  sendSse(res, 'token', { text: reply });
  sendSse(res, 'done', {
    result: reply,
    clientId,
    grillMePack: packId,
  });
}

/**
 * Orchestration path: Claude has no file/shell tools for coding — coding work
 * goes solely through the dispatch_coding_task MCP tool → dispatch-task.js → Cursor CLI.
 * Triggered only after skip-Grill-Me / explicit dispatch confirmation.
 */
async function streamDispatchViaMcp(res, clientId, dispatch, signal) {
  const toolName = dispatch.mcpTool || 'dispatch_coding_task';
  const intro =
    `Got it — Grill-Me complete (or skipped). Calling MCP tool ${toolName} ` +
    `to dispatch this coding task to Cursor Agent CLI for ${dispatch.project}. `;
  sendSse(res, 'status', { stage: 'mcp_tool', tool: toolName });
  sendSse(res, 'tool_call', {
    tool: toolName,
    arguments: dispatch.mcpArgs,
  });
  sendSse(res, 'token', { text: intro });

  let full = intro;
  const mcpResult = await executeMcpTool(toolName, dispatch.mcpArgs, {
    signal,
    onLog: (line) => {
      // Structured live events go to /api/runs/stream + terminal via run-events.
      // Also keep chat transcript updated with every Cursor/dispatch line.
      const chunk = `${line}\n`;
      full += chunk;
      sendSse(res, 'token', { text: chunk });
      sendSse(res, 'run_event', {
        type: 'log',
        text: line,
        source: 'dispatch',
      });
    },
  });

  sendSse(res, 'tool_result', {
    tool: toolName,
    ok: true,
    projectPath: mcpResult.projectPath,
  });

  const outro =
    '\nDone. MCP tool dispatch_coding_task ran dispatch-task.js and the headless Cursor agent created a feature branch and commit.';
  full += outro;
  sendSse(res, 'token', { text: outro });
  sendSse(res, 'done', {
    result: full,
    clientId,
    dispatched: true,
    mcpTool: toolName,
  });
}

function formatWhatsappJobScanSummary(mcpResult) {
  const jobs = mcpResult.jobs || [];
  const header =
    `Scanned WhatsApp exports (${mcpResult.scannedFiles || 0} file(s), ` +
    `${mcpResult.messagesScanned || 0} messages) via scan_whatsapp_jobs. ` +
    `Found ${mcpResult.jobCount ?? jobs.length} job post(s)` +
    (mcpResult.usedFixture ? ' (demo fixture).' : '.');

  if (!jobs.length) {
    return (
      `${header} Drop WhatsApp "Export chat" .txt files into ` +
      `${config.whatsappExportsDir} and ask again.`
    );
  }

  const lines = jobs.slice(0, 8).map((j, i) => {
    const when = j.timestamp ? ` @ ${j.timestamp}` : '';
    const contact =
      j.contacts?.emails?.[0] || j.contacts?.phones?.[0] || j.contacts?.urls?.[0];
    const contactBit = contact ? ` → ${contact}` : '';
    return `${i + 1}. [${j.groupName}] ${j.author}${when}${contactBit}: ${j.snippet}`;
  });
  return `${header}\n${lines.join('\n')}\nSay "הגש קו״ח" / "submit CV" to draft an application for a match.`;
}

async function resolveCvSubmitArgs(waCv, { onLog } = {}) {
  const args = { ...(waCv.mcpArgs || {}) };
  if (!waCv.resolveFromScan || args.jobText || args.recipientEmail) {
    return args;
  }

  onLog?.('[mcp] submit_whatsapp_job_cv resolving job via scan_whatsapp_jobs…');
  const scan = await executeMcpTool(
    'scan_whatsapp_jobs',
    { exportPath: config.whatsappExportsDir, limit: 20 },
    { onLog }
  );
  const withEmail = (scan.jobs || []).find((j) => j.contacts?.emails?.length);
  const pick = withEmail || (scan.jobs || [])[0];
  if (!pick) {
    const err = new Error(
      'No WhatsApp jobs found to apply to. Scan exports first or pass jobText/recipientEmail.'
    );
    err.code = 'CV_NO_JOB';
    throw err;
  }
  return {
    ...args,
    jobId: pick.id,
    jobText: pick.text,
    groupName: pick.groupName,
    author: pick.author,
    recipientEmail: args.recipientEmail || pick.contacts?.emails?.[0],
  };
}

function formatWhatsappCvSubmitSummary(mcpResult) {
  const app = mcpResult.application || {};
  const lines = [
    `Drafted CV application via submit_whatsapp_job_cv (${app.status || 'unknown'}).`,
    app.job?.groupName ? `Group: ${app.job.groupName}` : null,
    app.contacts?.emails?.[0]
      ? `To: ${app.contacts.emails[0]}`
      : 'To: (no email — needs contact)',
    app.mailto ? 'mailto: ready' : null,
    app.note || null,
    mcpResult.files?.json ? `Saved: ${mcpResult.files.json}` : null,
  ].filter(Boolean);
  return lines.join(' ');
}

/**
 * Orchestration path for CV drafts via submit_whatsapp_job_cv.
 */
async function streamWhatsappCvSubmitViaMcp(res, clientId, waCv, signal) {
  const toolName = waCv.mcpTool || 'submit_whatsapp_job_cv';
  const intro = `Preparing CV application draft via MCP tool ${toolName}… `;
  sendSse(res, 'status', { stage: 'mcp_tool', tool: toolName });
  sendSse(res, 'token', { text: intro });

  let full = intro;
  const mcpArgs = await resolveCvSubmitArgs(waCv, {
    onLog: (line) => {
      console.log(line);
      if (/\[mcp\]/i.test(line)) {
        const chunk = `${line}\n`;
        full += chunk;
        sendSse(res, 'token', { text: chunk });
      }
    },
  });

  sendSse(res, 'tool_call', {
    tool: toolName,
    arguments: {
      ...mcpArgs,
      jobText: mcpArgs.jobText
        ? `${String(mcpArgs.jobText).slice(0, 120)}…`
        : undefined,
    },
  });

  const mcpResult = await executeMcpTool(toolName, mcpArgs, {
    signal,
    onLog: (line) => {
      console.log(line);
      if (/\[mcp\]/i.test(line)) {
        const chunk = `${line}\n`;
        full += chunk;
        sendSse(res, 'token', { text: chunk });
      }
    },
  });

  sendSse(res, 'tool_result', {
    tool: toolName,
    ok: true,
    status: mcpResult.application?.status,
    applicationId: mcpResult.application?.id,
  });

  const summary = `\n${formatWhatsappCvSubmitSummary(mcpResult)}`;
  full += summary;
  sendSse(res, 'token', { text: summary });
  sendSse(res, 'done', {
    result: full,
    clientId,
    mcpTool: toolName,
    application: mcpResult.application,
  });
}

/**
 * Orchestration path for WhatsApp job scanning via scan_whatsapp_jobs.
 */
async function streamWhatsappJobScanViaMcp(res, clientId, waScan, signal) {
  const toolName = waScan.mcpTool || 'scan_whatsapp_jobs';
  const intro = `Scanning WhatsApp group exports via MCP tool ${toolName}… `;
  sendSse(res, 'status', { stage: 'mcp_tool', tool: toolName });
  sendSse(res, 'tool_call', {
    tool: toolName,
    arguments: waScan.mcpArgs,
  });
  sendSse(res, 'token', { text: intro });

  let full = intro;
  const mcpResult = await executeMcpTool(toolName, waScan.mcpArgs, {
    signal,
    onLog: (line) => {
      console.log(line);
      if (/\[mcp\]/i.test(line)) {
        const chunk = `${line}\n`;
        full += chunk;
        sendSse(res, 'token', { text: chunk });
      }
    },
  });

  sendSse(res, 'tool_result', {
    tool: toolName,
    ok: true,
    jobCount: mcpResult.jobCount,
    exportPath: mcpResult.exportPath,
  });

  const summary = `\n${formatWhatsappJobScanSummary(mcpResult)}`;
  full += summary;
  sendSse(res, 'token', { text: summary });
  sendSse(res, 'done', {
    result: full,
    clientId,
    mcpTool: toolName,
    jobCount: mcpResult.jobCount,
    jobs: mcpResult.jobs,
  });
}

async function boot() {
  if (config.mongoUri) {
    try {
      await mongoose.connect(config.mongoUri);
      console.log('[voice-agent] Connected to MongoDB');
    } catch (err) {
      console.error('[voice-agent] MongoDB connection error:', err.message);
    }
  }

  const server = app.listen(config.port, config.host, async () => {
    console.log(`[voice-agent] listening on http://${config.host}:${config.port}`);
    console.log(
      `[voice-agent] llmProvider=${llmProvider} llmModel=${llmModel} mock=${config.mock}`
    );
    console.log(`[voice-agent] claudeBin=${config.claudeBin}`);
    console.log(`[voice-agent] autoDispatchCoding=${config.autoDispatchCoding}`);
    console.log(`[voice-agent] autoScanWhatsappJobs=${config.autoScanWhatsappJobs}`);
    console.log(`[voice-agent] autoSubmitWhatsappCv=${config.autoSubmitWhatsappCv}`);
    const mcpToolsList = await listMcpTools();
    console.log(
      `[voice-agent] mcpTools=${mcpToolsList
        .map((t) => t.name)
        .join(',')}`
    );
    console.log(`[voice-agent] Grill-Me Mode is default for interactive chat`);
    console.log(`[voice-agent] Terminal chat: npm run chat`);
    console.log(`[voice-agent] open the PWA from a phone on LAN/Tailscale`);
    console.log(
      `[voice-agent] WhatsApp: GET /api/whatsapp/status | GET /api/whatsapp/groups | POST /api/whatsapp/start`
    );
    console.log(
      `[voice-agent] Jobs engine: GET /api/jobs/tracked-groups | GET /api/jobs/recent`
    );
    startIngestWhenReady(getSharedWhatsappSession(), {
      onLog: (line) => console.log(line),
    });
    maybeAutostartWhatsapp();

    const tgAutostart = process.env.JOINUP_TELEGRAM_AUTOSTART === '1';
    const tgAllowEmbedded = process.env.JOINUP_TELEGRAM_ALLOW_EMBEDDED === '1';
    if (tgAutostart && tgAllowEmbedded) {
      console.log(
        '[voice-agent] starting embedded joinUp Telegram (JOINUP_TELEGRAM_ALLOW_EMBEDDED=1)'
      );
      import('./joinup-telegram/index.js')
        .then(({ startJoinUpTelegramService }) =>
          startJoinUpTelegramService({
            onLog: (line) => console.log(line),
          })
        )
        .catch((err) => {
          console.error('[joinup-telegram] autostart failed:', err.message);
        });
    } else {
      console.log(
        '[voice-agent] joinUp Telegram NOT started in this process ' +
          `(autostart=${tgAutostart ? '1' : '0'} allowEmbedded=${tgAllowEmbedded ? '1' : '0'}). ` +
          'Use Coolify app Dockerfile.joinup-telegram, or npm run joinup:telegram.'
      );
      if (tgAutostart && !tgAllowEmbedded) {
        console.warn(
          '[voice-agent] JOINUP_TELEGRAM_AUTOSTART=1 ignored without JOINUP_TELEGRAM_ALLOW_EMBEDDED=1. ' +
            'Remove AUTOSTART from Coolify env on the voice-agent app.'
        );
      }
    }
  });

  server.on('error', (err) => {
    console.error('[voice-agent] failed to start:', err.message);
    process.exit(1);
  });

  let shuttingDown = false;
  const gracefulShutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[voice-agent] ${signal} — shutting down`);
    try {
      await getSharedWhatsappSession().stop();
    } catch (err) {
      console.warn(`[voice-agent] whatsapp stop: ${err.message}`);
    }
    try {
      if (mongoose.connection.readyState) {
        await mongoose.connection.close();
      }
    } catch (err) {
      console.warn(`[voice-agent] mongo close: ${err.message}`);
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
}

boot().catch((err) => {
  console.error('[voice-agent] boot failed:', err.message || err);
  process.exit(1);
});

