/**
 * Visual BiDi helper for terminals that print left-to-right only.
 * Reorders Hebrew (and other RTL) runs so they appear correct in CLI stdout.
 * English and fenced code blocks are left unchanged.
 */
import bidiFactory from 'bidi-js';

const bidi = bidiFactory();
const HEBREW_RE = /[\u0590-\u05FF]/;
const FENCE_SPLIT_RE = /(```[\s\S]*?```)/g;

export function containsHebrew(text) {
  return HEBREW_RE.test(String(text ?? ''));
}

function reorderLine(line) {
  if (!line || !containsHebrew(line)) return line;
  const levels = bidi.getEmbeddingLevels(line);
  return bidi.getReorderedString(line, levels);
}

/**
 * Return a visually ordered string for dumb LTR terminals.
 * No-op when the text has no Hebrew / RTL letters.
 */
export function formatBidi(text) {
  const s = String(text ?? '');
  if (!s || !containsHebrew(s)) return s;

  // Keep fenced code blocks byte-for-byte; only reshape surrounding prose.
  return s
    .split(FENCE_SPLIT_RE)
    .map((part) => {
      if (part.startsWith('```')) return part;
      if (!containsHebrew(part)) return part;
      // Preserve newlines; reorder each visual line independently.
      return part
        .split(/(\r?\n)/)
        .map((chunk) => (chunk === '\n' || chunk === '\r\n' ? chunk : reorderLine(chunk)))
        .join('');
    })
    .join('');
}

export default formatBidi;
