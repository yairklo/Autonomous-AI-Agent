/**
 * Classify Cursor Agent CLI / dispatch-task stdout lines into UI-friendly types.
 */

/**
 * @param {string} raw
 * @returns {{ type: string, text: string, meta: object }}
 */
export function classifyCursorLogLine(raw) {
  const line = String(raw || '').replace(/\r/g, '').trimEnd();
  const text = line.trim();
  if (!text) return { type: 'log', text: '', meta: {} };

  if (/^\[stderr\]/i.test(text) || /\berror\b|failed|✗/i.test(text)) {
    return { type: 'error', text, meta: {} };
  }
  if (/^\[run:|^\[dispatch\]|^\[mcp\]|^\[joinup-telegram\]|^\[quality-gates\]|^\[vercel\]/i.test(text)) {
    return { type: 'status', text, meta: {} };
  }
  if (/Written prompt|Written Cursor|Pre-agent git|Post-agent git|Quality gates|mergedInto|pinned/i.test(text)) {
    return { type: 'status', text, meta: {} };
  }
  if (/feature\/task-|git checkout|git commit|git push|git merge/i.test(text)) {
    return { type: 'git', text, meta: {} };
  }
  if (/\$\s*cursor|cursor-agent|Running headless Cursor|Cursor executor|spawn\]/i.test(text)) {
    return { type: 'tool', text, meta: { tool: 'cursor-agent' } };
  }
  if (/READY_TO_BUILD|Should I proceed|plan for joinUp|Quality Gate Loop/i.test(text)) {
    return { type: 'plan', text, meta: {} };
  }
  if (/thinking|considering|I'll |I will |Let me |Going to /i.test(text)) {
    return { type: 'thinking', text, meta: {} };
  }
  if (/^(✓|✔)/.test(text)) {
    return { type: 'status', text, meta: {} };
  }
  // Default: treat as assistant/agent narrative when it looks like prose
  if (text.length > 40 && /[.!?]$/.test(text)) {
    return { type: 'assistant', text, meta: {} };
  }
  return { type: 'log', text, meta: {} };
}
