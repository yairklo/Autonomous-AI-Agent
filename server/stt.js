import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.js';

const execFileAsync = promisify(execFile);

/**
 * Server-side STT. Primary client path is Web Speech API;
 * this module is the optional Whisper.cpp bridge.
 */
export function whisperConfigured() {
  return Boolean(config.whisperBin);
}

export async function transcribeAudio(filePath, { language = 'he' } = {}) {
  if (config.mock) {
    return "זהו תמלול דמה של סוכן הקול במצב מוק.";
  }

  // Real mode: check if we need to convert to 16kHz WAV
  let whisperPath = filePath;
  let tempWavPath = null;

  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.wav') {
    tempWavPath = `${filePath}-16k.wav`;
    try {
      console.log(`[STT Log] Audio conversion via FFmpeg started at ${new Date().toISOString()}`);
      await execFileAsync('ffmpeg', [
        '-y',
        '-i', filePath,
        '-ar', '16000',
        '-ac', '1',
        '-c:a', 'pcm_s16le',
        tempWavPath
      ]);
      console.log(`[STT Log] Audio conversion via FFmpeg finished at ${new Date().toISOString()}`);
      whisperPath = tempWavPath;
    } catch (err) {
      throw new Error(`Failed to convert non-WAV audio (requires ffmpeg in PATH): ${err.message}`);
    }
  }

  try {
    if (!config.whisperBin) {
      const err = new Error(
        'Server STT unavailable: Whisper binary not configured. Set WHISPER_BIN in the environment to enable local STT.'
      );
      err.code = 'STT_NOT_CONFIGURED';
      throw err;
    }

    const binName = path.basename(config.whisperBin).toLowerCase();
    const isPythonWhisper = binName.startsWith('whisper') && !binName.includes('cpp') && !binName.includes('cli') && !binName.includes('main');

    const args = [];
    const outputDir = path.dirname(whisperPath);

    if (isPythonWhisper) {
      args.push(whisperPath);
      args.push('--language', 'he');
      if (config.whisperModel) {
        args.push('--model', config.whisperModel);
      } else {
        args.push('--model', 'base');
      }
      args.push('--threads', '4');
      args.push('--initial_prompt', 'שיחה בעברית, פקודות קוליות, טסט, קוד');
      args.push('--output_format', 'txt');
      args.push('--output_dir', outputDir);
    } else {
      if (config.whisperModel) {
        args.push('-m', config.whisperModel);
      }
      args.push('-f', whisperPath, '-l', 'he', '-nt', '-np', '-t', '4', '--prompt', 'שיחה בעברית, פקודות קוליות, טסט, קוד');
    }

    console.log(`[STT Log] Whisper execution started at ${new Date().toISOString()}`);
    const { stdout, stderr, code } = await run(config.whisperBin, args, {
      timeoutMs: 300_000,
    });
    console.log(`[STT Log] Whisper execution finished at ${new Date().toISOString()}`);

    if (code !== 0) {
      const errText = stderr || stdout || '';
      if (/getaddrinfo|urlopen|urllib|connection|dns/i.test(errText)) {
        throw new Error(
          'Whisper failed: No internet connection to download the model. Please check your network or pre-download the model.'
        );
      }
      throw new Error(
        `Whisper failed (code ${code}): ${errText.slice(-500)}`
      );
    }

    // Check both standard sidecar and python whisper output path
    const possibleTxtFiles = [
      `${whisperPath}.txt`,
      path.join(outputDir, path.basename(whisperPath, path.extname(whisperPath)) + '.txt')
    ];

    let sidecarText = '';
    for (const txtPath of possibleTxtFiles) {
      try {
        const content = await fs.readFile(txtPath, 'utf8');
        if (content.trim()) {
          sidecarText = content.trim();
          await fs.unlink(txtPath).catch(() => {});
          break;
        }
      } catch {
        /* ignore read errors */
      }
    }

    if (sidecarText) {
      return sidecarText;
    }

    const text = stdout.trim();
    if (!text) {
      throw new Error('Whisper produced empty transcription');
    }
    return text;
  } finally {
    if (tempWavPath) {
      await fs.unlink(tempWavPath).catch(() => {});
    }
  }
}

function run(bin, args, { timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
      },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    child.stdout.on('data', (c) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export function guessExtension(mime) {
  const map = {
    'audio/webm': '.webm',
    'audio/wav': '.wav',
    'audio/wave': '.wav',
    'audio/x-wav': '.wav',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'audio/ogg': '.ogg',
  };
  return map[mime] || path.extname(mime) || '.webm';
}
