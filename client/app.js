const STORAGE_KEY = 'voice-agent-settings-v1';
const CLIENT_KEY = 'voice-agent-client-id';

const els = {
  status: document.getElementById('statusLine'),
  transcript: document.getElementById('transcript'),
  liveRun: document.getElementById('liveRun'),
  liveRunLog: document.getElementById('liveRunLog'),
  liveRunStatus: document.getElementById('liveRunStatus'),
  liveRunClear: document.getElementById('liveRunClear'),
  ptt: document.getElementById('ptt'),
  pttLabel: document.getElementById('pttLabel'),
  textForm: document.getElementById('textForm'),
  textInput: document.getElementById('textInput'),
  settingsBtn: document.getElementById('settingsBtn'),
  settingsDialog: document.getElementById('settingsDialog'),
  serverUrl: document.getElementById('serverUrl'),
  autoSpeak: document.getElementById('autoSpeak'),
  useServerTts: document.getElementById('useServerTts'),
  healthHint: document.getElementById('healthHint'),
  checkHealth: document.getElementById('checkHealth'),
  resetSession: document.getElementById('resetSession'),
};

const state = {
  busy: false,
  listening: false,
  recognition: null,
  mediaRecorder: null,
  chunks: [],
  partial: '',
  settings: loadSettings(),
  clientId: localStorage.getItem(CLIENT_KEY) || crypto.randomUUID(),
};

localStorage.setItem(CLIENT_KEY, state.clientId);
applySettingsToForm();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

els.settingsBtn.addEventListener('click', () => {
  applySettingsToForm();
  els.settingsDialog.showModal();
});

els.settingsDialog.addEventListener('close', () => {
  saveSettingsFromForm();
});

document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    if (state.busy) return;
    const text = btn.dataset.preset;
    els.textInput.value = '';
    await sendTurn(text);
  });
});

els.checkHealth.addEventListener('click', async () => {
  saveSettingsFromForm();
  try {
    const res = await fetch(api('/api/health'));
    const data = await res.json();
    const live = data.runEvents ? 'live-logs=on' : 'live-logs=OFF (restart npm start)';
    els.healthHint.textContent = `OK · ${data.hostname} · mock=${data.mock} · ${live} · lan=${(data.lanAddresses || []).join(', ') || 'n/a'}`;
  } catch (err) {
    els.healthHint.textContent = `Unreachable: ${err.message}`;
  }
});

els.resetSession.addEventListener('click', async () => {
  saveSettingsFromForm();
  try {
    await fetch(api('/api/session/reset'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: state.clientId }),
    });
    addBubble('system', 'Conversation session reset.');
  } catch (err) {
    addBubble('system', `Reset failed: ${err.message}`);
  }
});

els.textForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = els.textInput.value.trim();
  if (!text || state.busy) return;
  els.textInput.value = '';
  await sendTurn(text);
});

bindPtt(els.ptt);

function bindPtt(btn) {
  const start = (ev) => {
    ev.preventDefault();
    beginListen();
  };
  const end = (ev) => {
    ev.preventDefault();
    endListen();
  };
  btn.addEventListener('pointerdown', start);
  btn.addEventListener('pointerup', end);
  btn.addEventListener('pointercancel', end);
  btn.addEventListener('pointerleave', (ev) => {
    if (state.listening) end(ev);
  });
  // Keyboard accessibility
  btn.addEventListener('keydown', (ev) => {
    if (ev.code === 'Space' && !state.listening) {
      ev.preventDefault();
      beginListen();
    }
  });
  btn.addEventListener('keyup', (ev) => {
    if (ev.code === 'Space' && state.listening) {
      ev.preventDefault();
      endListen();
    }
  });
}

async function beginListen() {
  if (state.busy || state.listening) return;
  state.listening = true;
  state.partial = '';
  state.chunks = [];

  // Unlock iOS/Safari SpeechSynthesis during user interaction
  if (window.speechSynthesis) {
    try {
      const unlockUtter = new SpeechSynthesisUtterance('');
      window.speechSynthesis.speak(unlockUtter);
    } catch {
      /* ignore */
    }
  }

  els.ptt.setAttribute('aria-pressed', 'true');
  els.pttLabel.textContent = 'Listening…';
  setStatus('Listening… release to send.');

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognition) {
    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';
    rec.onresult = (event) => {
      let interim = '';
      let finalText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += t;
        else interim += t;
      }
      if (finalText) state.partial = `${state.partial} ${finalText}`.trim();
      setStatus((state.partial || interim || 'Listening…').trim());
    };
    rec.onerror = () => {
      // Fall through to MediaRecorder path on hard failures handled in endListen
    };
    try {
      rec.start();
      state.recognition = rec;
      return;
    } catch {
      state.recognition = null;
    }
  }

  // Fallback: record audio and upload (needs server Whisper)
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    state.chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size) state.chunks.push(e.data);
    };
    recorder.start();
    state.mediaRecorder = recorder;
    state._mediaStream = stream;
    setStatus('Recording audio… (server Whisper required if no speech API)');
  } catch (err) {
    state.listening = false;
    els.ptt.setAttribute('aria-pressed', 'false');
    els.pttLabel.textContent = 'Hold to talk';
    setStatus(`Mic error: ${err.message}`);
  }
}

async function endListen() {
  if (!state.listening) return;
  state.listening = false;
  els.ptt.setAttribute('aria-pressed', 'false');
  els.pttLabel.textContent = 'Hold to talk';

  let text = state.partial.trim();
  const rec = state.recognition;
  state.recognition = null;
  if (rec) {
    try {
      rec.stop();
    } catch {
      /* ignore */
    }
    // Give final results a beat
    await sleep(250);
    text = state.partial.trim() || text;
  }

  if (text) {
    await sendTurn(text);
    return;
  }

  const recorder = state.mediaRecorder;
  state.mediaRecorder = null;
  if (recorder && recorder.state !== 'inactive') {
    const blob = await stopRecorder(recorder);
    stopStream(state._mediaStream);
    state._mediaStream = null;
    if (blob && blob.size > 0) {
      await sendVoiceBlob(blob);
      return;
    }
  }

  setStatus('No speech captured. Try again or type a message.');
}

function stopRecorder(recorder) {
  return new Promise((resolve) => {
    recorder.onstop = () => {
      resolve(new Blob(state.chunks, { type: recorder.mimeType || 'audio/webm' }));
    };
    try {
      recorder.stop();
    } catch {
      resolve(null);
    }
  });
}

function stopStream(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
}

async function sendTurn(text) {
  if (state.busy) return;
  state.busy = true;
  addBubble('user', text);
  const assistantEl = addBubble('assistant', '');
  setStatus('Thinking…');
  window.speechSynthesis?.cancel();

  let full = '';
  try {
    const res = await fetch(api('/api/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: state.clientId, text, interactiveChat: true }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    await readSse(res, {
      onToken: (t) => {
        full += t;
        assistantEl.textContent = full;
        scrollTranscript();
      },
      onToolCall: (payload) => {
        addBubble('tool', `[Tool Call] ${payload.tool || 'dispatch_coding_task'}`);
      },
      onToolResult: (payload) => {
        addBubble('tool', `[Tool Result] ${payload.tool || ''} ok=${payload.ok}`);
      },
      onStatus: (payload) => {
        if (payload.stage !== 'stt' && payload.stage !== 'claude') {
          addBubble('status-update', `[Status] ${payload.stage} ${payload.tool ? `tool=${payload.tool}` : ''}`);
        }
      },
      onError: (msg) => {
        throw new Error(msg);
      },
      onDone: (payload) => {
        full = payload.result || full;
        assistantEl.textContent = full;
      },
    });
    setStatus('Hold the button and speak.');
    if (state.settings.autoSpeak && full) await speak(full);
  } catch (err) {
    assistantEl.textContent = `Error: ${err.message}`;
    setStatus('Something went wrong.');
  } finally {
    state.busy = false;
  }
}

async function sendVoiceBlob(blob) {
  if (state.busy) return;
  state.busy = true;
  const userEl = addBubble('user', '[audio]');
  const assistantEl = addBubble('assistant', '');
  setStatus('Uploading / transcribing…');

  let full = '';
  try {
    const form = new FormData();
    form.append('clientId', state.clientId);
    form.append('audio', blob, 'utterance.webm');
    const res = await fetch(api('/api/voice'), { method: 'POST', body: form });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    await readSse(res, {
      onTranscript: (t) => {
        userEl.textContent = t;
      },
      onToken: (t) => {
        full += t;
        assistantEl.textContent = full;
        scrollTranscript();
      },
      onToolCall: (payload) => {
        addBubble('tool', `[Tool Call] ${payload.tool || 'dispatch_coding_task'}`);
      },
      onToolResult: (payload) => {
        addBubble('tool', `[Tool Result] ${payload.tool || ''} ok=${payload.ok}`);
      },
      onStatus: (payload) => {
        if (payload.stage !== 'stt' && payload.stage !== 'claude') {
          addBubble('status-update', `[Status] ${payload.stage} ${payload.tool ? `tool=${payload.tool}` : ''}`);
        }
      },
      onError: (msg) => {
        throw new Error(msg);
      },
      onDone: (payload) => {
        full = payload.result || full;
        assistantEl.textContent = full;
        if (payload.transcript) userEl.textContent = payload.transcript;
      },
    });
    setStatus('Hold the button and speak.');
    if (state.settings.autoSpeak && full) await speak(full);
  } catch (err) {
    assistantEl.textContent = `Error: ${err.message}`;
    setStatus('Voice upload failed. Prefer Chrome STT or configure Whisper.');
  } finally {
    state.busy = false;
  }
}

async function readSse(res, handlers) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split;
    while ((split = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const lines = chunk.split('\n');
      let event = 'message';
      let data = '';
      for (const line of lines) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }
      if (event === 'token' && payload.text) handlers.onToken?.(payload.text);
      if (event === 'transcript' && payload.text) handlers.onTranscript?.(payload.text);
      if (event === 'tool_call') handlers.onToolCall?.(payload);
      if (event === 'tool_result') handlers.onToolResult?.(payload);
      if (event === 'done') handlers.onDone?.(payload);
      if (event === 'error') handlers.onError?.(payload.error || 'Unknown error');
      if (event === 'status') {
        handlers.onStatus?.(payload);
        if (payload.stage) {
          setStatus(payload.stage === 'stt' ? 'Transcribing…' : 'Thinking…');
        }
      }
    }
  }
}

async function speak(text) {
  if (state.settings.useServerTts) {
    try {
      const res = await fetch(api('/api/tts'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.onended = () => URL.revokeObjectURL(url);
        audio.onerror = () => URL.revokeObjectURL(url);
        await audio.play();
        return;
      }
    } catch {
      // fall through to browser TTS
    }
  }

  if (!window.speechSynthesis) return;
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 1.05;
  window.speechSynthesis.speak(utter);
}

function addBubble(role, text) {
  const el = document.createElement('div');
  el.className = `bubble ${role}`;
  el.textContent = text;
  els.transcript.appendChild(el);
  scrollTranscript();
  return el;
}

function scrollTranscript() {
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

function setStatus(msg) {
  els.status.textContent = msg;
}

function api(pathName) {
  const base = (state.settings.serverUrl || '').replace(/\/$/, '');
  if (!base) return pathName;
  return `${base}${pathName}`;
}

function loadSettings() {
  try {
    return {
      serverUrl: '',
      autoSpeak: true,
      useServerTts: false,
      ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'),
    };
  } catch {
    return { serverUrl: '', autoSpeak: true, useServerTts: false };
  }
}

function applySettingsToForm() {
  els.serverUrl.value = state.settings.serverUrl || '';
  els.autoSpeak.checked = Boolean(state.settings.autoSpeak);
  els.useServerTts.checked = Boolean(state.settings.useServerTts);
}

function saveSettingsFromForm() {
  state.settings = {
    serverUrl: els.serverUrl.value.trim(),
    autoSpeak: els.autoSpeak.checked,
    useServerTts: els.useServerTts.checked,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ---- Cursor Live Run console (SSE /api/runs/stream) ---- */
function appendLiveRunEvent(event) {
  if (!els.liveRunLog || !event) return;
  const line = document.createElement('div');
  line.className = 'live-run-line';
  line.dataset.type = event.type || 'log';
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = event.type || 'log';
  line.appendChild(tag);
  line.appendChild(document.createTextNode(' ' + (event.text || '')));
  els.liveRunLog.appendChild(line);
  while (els.liveRunLog.childElementCount > 300) {
    els.liveRunLog.removeChild(els.liveRunLog.firstChild);
  }
  els.liveRunLog.scrollTop = els.liveRunLog.scrollHeight;

  if (event.type === 'run_start') {
    els.liveRunStatus.textContent = 'running';
  } else if (event.type === 'run_end') {
    els.liveRunStatus.textContent = 'done';
  } else if (event.type === 'error') {
    els.liveRunStatus.textContent = 'error';
  } else if (els.liveRunStatus.textContent === 'idle') {
    els.liveRunStatus.textContent = 'live';
  }
}

async function ensureLiveRunBackend() {
  try {
    const res = await fetch(api('/api/health'));
    const data = await res.json();
    if (!data.runEvents) {
      els.liveRunStatus.textContent = 'server stale';
      if (!state._liveRunStaleWarned) {
        state._liveRunStaleWarned = true;
        appendLiveRunEvent({
          type: 'error',
          text: 'Voice-agent server is stale — /api/runs missing. Stop the old node process and run npm start again.',
        });
      }
      return false;
    }
    const probe = await fetch(api('/api/runs'));
    if (!probe.ok) {
      els.liveRunStatus.textContent = 'server stale';
      if (!state._liveRunStaleWarned) {
        state._liveRunStaleWarned = true;
        appendLiveRunEvent({
          type: 'error',
          text: `Cannot open Cursor Live (/api/runs → HTTP ${probe.status}). Restart npm start.`,
        });
      }
      return false;
    }
    state._liveRunStaleWarned = false;
    return true;
  } catch (err) {
    els.liveRunStatus.textContent = 'offline';
    return false;
  }
}

async function connectLiveRunStream() {
  if (!els.liveRunLog || typeof EventSource === 'undefined') return;
  if (state._liveRunEs) {
    try {
      state._liveRunEs.close();
    } catch {
      /* ignore */
    }
  }
  const ok = await ensureLiveRunBackend();
  if (!ok) {
    setTimeout(connectLiveRunStream, 4000);
    return;
  }
  const url = api('/api/runs/stream');
  const es = new EventSource(url);
  state._liveRunEs = es;
  els.liveRunStatus.textContent = 'connecting';

  es.addEventListener('hello', () => {
    els.liveRunStatus.textContent = 'idle';
  });
  es.addEventListener('run_event', (msg) => {
    try {
      appendLiveRunEvent(JSON.parse(msg.data));
    } catch {
      /* ignore */
    }
  });
  es.onerror = () => {
    els.liveRunStatus.textContent = 'reconnecting';
    es.close();
    setTimeout(connectLiveRunStream, 2500);
  };
}

if (els.liveRunClear) {
  els.liveRunClear.addEventListener('click', () => {
    if (els.liveRunLog) els.liveRunLog.innerHTML = '';
    els.liveRunStatus.textContent = 'idle';
  });
}

connectLiveRunStream();
