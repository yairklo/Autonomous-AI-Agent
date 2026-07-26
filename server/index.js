import cors from 'cors';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { ClaudeSessionManager } from './claude-session.js';
import { config } from './config.js';
import { guessExtension, transcribeAudio, whisperConfigured } from './stt.js';
import { executeMcpTool, listMcpTools } from './mcp-tools.js';
import { detectCodingDispatch, detectWhatsappJobScan } from './task-router.js';
import { synthesizeToFile, ttsAvailableHint } from './tts.js';

fs.mkdirSync(config.uploadsDir, { recursive: true });

const app = express();
const claude = new ClaudeSessionManager();

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

app.get('/api/health', (_req, res) => {
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
    whisper: whisperConfigured(),
    serverTts: ttsAvailableHint(),
    autoDispatchCoding: config.autoDispatchCoding,
    autoScanWhatsappJobs: config.autoScanWhatsappJobs,
    mcpTools: listMcpTools().map((t) => t.name),
    whatsappExportsDir: config.whatsappExportsDir,
    time: new Date().toISOString(),
  });
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
  console.log(`[API CHAT] received request. clientId=${clientId} text="${text}"`);
  if (!text) {
    return res.status(400).json({ error: 'text is required' });
  }

  initSse(res);
  sendSse(res, 'meta', { clientId });

  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) {
      console.log('[API CHAT] connection aborted by client');
      ac.abort();
    }
  });

  // Explicit skip-Grill-Me / dispatch confirm → dispatch_coding_task MCP tool.
  // Ordinary coding requests fall through to Claude (Grill-Me Mode).
  const dispatch = config.autoDispatchCoding ? detectCodingDispatch(text) : null;
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

  // WhatsApp group job scan → scan_whatsapp_jobs MCP tool.
  const waScan = config.autoScanWhatsappJobs ? detectWhatsappJobScan(text) : null;
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

  let full = '';
  try {
    for await (const event of claude.ask(clientId, text, { signal: ac.signal })) {
      console.log(`[API CHAT] yielded event type=${event.type}`, event);
      if (event.type === 'text') {
        full += event.text;
        sendSse(res, 'token', { text: event.text });
      } else if (event.type === 'session') {
        sendSse(res, 'session', { sessionId: event.sessionId });
      } else if (event.type === 'done') {
        sendSse(res, 'done', {
          result: event.result || full,
          clientId,
        });
      } else if (event.type === 'error') {
        sendSse(res, 'error', { error: event.error });
      }
    }
  } catch (err) {
    console.error('[API CHAT] error caught:', err);
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

  const dispatch = config.autoDispatchCoding ? detectCodingDispatch(text) : null;
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

  const waScan = config.autoScanWhatsappJobs ? detectWhatsappJobScan(text) : null;
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

  let full = '';
  let sessionId = null;
  try {
    for await (const event of claude.ask(clientId, text)) {
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

    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) ac.abort();
    });

    const dispatch = config.autoDispatchCoding ? detectCodingDispatch(text) : null;
    if (dispatch) {
      await prepareDispatchTask(clientId, dispatch, ac.signal);
      await streamDispatchViaMcp(res, clientId, dispatch, ac.signal);
      return res.end();
    }

    sendSse(res, 'status', { stage: 'claude' });

    let full = '';
    for await (const event of claude.ask(clientId, text, { signal: ac.signal })) {
      if (event.type === 'text') {
        full += event.text;
        sendSse(res, 'token', { text: event.text });
      } else if (event.type === 'session') {
        sendSse(res, 'session', { sessionId: event.sessionId });
      } else if (event.type === 'done') {
        sendSse(res, 'done', {
          result: event.result || full,
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
  for await (const event of claude.ask(clientId, refinePrompt, { signal })) {
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
      console.log(line);
      if (
        /^✓/.test(line) ||
        /\[mcp\]/i.test(line) ||
        /Headless agent|feature\/|commit|Written prompt|Written Cursor|cursor agent/i.test(line)
      ) {
        const chunk = `${line}\n`;
        full += chunk;
        sendSse(res, 'token', { text: chunk });
      }
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
    return `${i + 1}. [${j.groupName}] ${j.author}${when}: ${j.snippet}`;
  });
  return `${header}\n${lines.join('\n')}`;
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

const server = app.listen(config.port, config.host, () => {
  console.log(`[voice-agent] listening on http://${config.host}:${config.port}`);
  console.log(`[voice-agent] mock=${config.mock} claudeBin=${config.claudeBin}`);
  console.log(`[voice-agent] autoDispatchCoding=${config.autoDispatchCoding}`);
  console.log(`[voice-agent] autoScanWhatsappJobs=${config.autoScanWhatsappJobs}`);
  console.log(
    `[voice-agent] mcpTools=${listMcpTools()
      .map((t) => t.name)
      .join(',')}`
  );
  console.log(`[voice-agent] Grill-Me Mode is default for interactive chat`);
  console.log(`[voice-agent] Terminal chat: npm run chat`);
  console.log(`[voice-agent] open the PWA from a phone on LAN/Tailscale`);
});

server.on('error', (err) => {
  console.error('[voice-agent] failed to start:', err.message);
  process.exit(1);
});
