/**
 * One-shot LLM text generation for cover letters (Gemini API, direct call —
 * not the full ClaudeSessionManager/GeminiSessionManager chat sessions, which
 * are built for interactive tool-using conversations, not a single prompt).
 * Returns null when no Gemini API key is configured so callers fall back to
 * the static profile template instead of silently doing nothing.
 */

import { config } from '../config.js';
import { getSharedGeminiRateLimiter } from '../gemini-rate-limit.js';

let cachedClient = null;

async function getClient(apiKey) {
  if (cachedClient) return cachedClient;
  const { GoogleGenAI } = await import('@google/genai');
  cachedClient = new GoogleGenAI({ apiKey });
  return cachedClient;
}

function extractText(response) {
  if (!response) return '';
  if (typeof response.text === 'string' && response.text) return response.text;
  const parts = response?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) return parts.map((p) => p?.text || '').join('');
  return '';
}

/**
 * @param {object} [opts]
 * @param {(line: string) => void} [opts.onLog]
 * @returns {((prompt: string) => Promise<string>) | null}
 */
export function buildCoverLetterLlmGenerate({ onLog } = {}) {
  const apiKey = config.geminiApiKey;
  if (!apiKey) {
    onLog?.(
      '[cover-letter] GEMINI_API_KEY not set — using template cover letters (set GEMINI_API_KEY to enable LLM-adapted notes)'
    );
    return null;
  }
  const model = config.geminiModel || 'gemini-3.6-flash';
  const limiter = getSharedGeminiRateLimiter({
    rpm: config.geminiRpm,
    rpd: config.geminiRpd,
    onLog: (line) => onLog?.(line),
  });

  return async function llmGenerate(prompt) {
    const ai = await getClient(apiKey);
    // A short, dedicated timeout — not config.geminiTimeoutMs (5min default
    // for the interactive chat orchestration session). A cover letter is one
    // small prompt; buildCoverLetter falls back to the template on any
    // error, so this should fail fast rather than stall a real submission.
    const timeoutMs = 20000;
    const abortSignal = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
    const response = await limiter.schedule(() =>
      ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: { abortSignal },
      })
    );
    const text = extractText(response).trim();
    if (!text) throw new Error('Empty Gemini response for cover letter');
    return text;
  };
}
