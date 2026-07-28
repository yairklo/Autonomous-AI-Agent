import { ClaudeSessionManager } from './claude-session.js';
import { GeminiSessionManager } from './gemini-session.js';
import { config } from './config.js';

/**
 * Normalize provider id from env / options.
 * @param {string} [raw]
 * @returns {'claude'|'gemini'}
 */
export function normalizeLlmProvider(raw) {
  const v = String(raw || '')
    .trim()
    .toLowerCase();
  if (v === 'gemini' || v === 'google' || v === 'google-gemini') return 'gemini';
  return 'claude';
}

/**
 * Factory for the orchestration / management chat backend.
 * MCP tools stay outside the LLM — same ask() event stream for both providers.
 *
 * @param {object} [options]
 * @param {string} [options.provider] claude | gemini (default: config.llmProvider)
 * @returns {ClaudeSessionManager|GeminiSessionManager}
 */
export function createLlmSessionManager(options = {}) {
  const provider = normalizeLlmProvider(
    options.provider ?? config.llmProvider ?? 'claude'
  );
  if (provider === 'gemini') {
    return new GeminiSessionManager(options);
  }
  return new ClaudeSessionManager(options);
}

export { ClaudeSessionManager, GeminiSessionManager };
