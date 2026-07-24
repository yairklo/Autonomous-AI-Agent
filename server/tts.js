import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const execFileAsync = promisify(execFile);

/**
 * Optional server-side TTS. Primary path is client SpeechSynthesis.
 * Tries Windows PowerShell SAPI, macOS `say`, or `espeak` when available.
 */
export async function synthesizeToFile(text, outPath) {
  const cleaned = String(text || '').trim();
  if (!cleaned) throw new Error('Empty TTS text');

  if (process.platform === 'win32') {
    return synthesizeWindows(cleaned, outPath);
  }
  if (process.platform === 'darwin') {
    await execFileAsync('say', ['-o', outPath, cleaned]);
    return { engine: 'say', path: outPath };
  }

  // Linux: espeak-ng / espeak
  try {
    await execFileAsync('espeak-ng', ['-w', outPath, cleaned]);
    return { engine: 'espeak-ng', path: outPath };
  } catch {
    await execFileAsync('espeak', ['-w', outPath, cleaned]);
    return { engine: 'espeak', path: outPath };
  }
}

async function synthesizeWindows(text, outPath) {
  // Generate WAV via System.Speech, then caller may stream it.
  const psPath = path.join(
    os.tmpdir(),
    `voice-agent-tts-${Date.now()}.ps1`
  );
  const escaped = text.replace(/'/g, "''");
  const wavPath = outPath.toLowerCase().endsWith('.wav')
    ? outPath
    : `${outPath}.wav`;

  const script = `
Add-Type -AssemblyName System.Speech
$speak = New-Object System.Speech.Synthesis.SpeechSynthesizer
$speak.SetOutputToWaveFile('${wavPath.replace(/'/g, "''")}')
$speak.Speak('${escaped}')
$speak.Dispose()
`;
  fs.writeFileSync(psPath, '\ufeff' + script, 'utf8');
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psPath],
        { windowsHide: true }
      );
      let err = '';
      child.stderr.on('data', (c) => {
        err += c.toString();
      });
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(err || `PowerShell TTS exit ${code}`));
      });
      child.on('error', reject);
    });
    return { engine: 'System.Speech', path: wavPath };
  } finally {
    try {
      fs.unlinkSync(psPath);
    } catch {
      /* ignore */
    }
  }
}

export function ttsAvailableHint() {
  if (process.platform === 'win32') return 'System.Speech (PowerShell)';
  if (process.platform === 'darwin') return 'say';
  return 'espeak / espeak-ng (if installed)';
}
