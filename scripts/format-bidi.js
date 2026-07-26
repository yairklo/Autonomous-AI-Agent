/**
 * Visual BiDi helper for CLI terminals.
 *
 * Modern Windows Terminal already applies Unicode BiDi. Character-level
 * reordering (bidi-js getReorderedString) then DOUBLE-FLIPS Hebrew.
 *
 * Default: keep logical order (Hebrew reads correctly on WT / most consoles).
 * Opt-in legacy reorder: CHAT_BIDI_REORDER=1 for dumb LTR-only consoles.
 */
import bidiFactory from 'bidi-js';

const bidi = bidiFactory();
const HEBREW_RE = /[\u0590-\u05FF]/;
const FENCE_SPLIT_RE = /(```[\s\S]*?```)/g;
const REORDER =
  process.env.CHAT_BIDI_REORDER === '1' || process.env.CHAT_BIDI_REORDER === 'true';

export function containsHebrew(text) {
  return HEBREW_RE.test(String(text ?? ''));
}

function reorderLine(line) {
  if (!line || !containsHebrew(line)) return line;
  const levels = bidi.getEmbeddingLevels(line);
  return bidi.getReorderedString(line, levels);
}

/**
 * Format text for CLI stdout. Hebrew stays in logical order by default
 * so it is not flipped on terminals that already handle RTL.
 */
export function formatBidi(text) {
  const s = String(text ?? '');
  if (!s || !containsHebrew(s)) return s;
  if (!REORDER) return s;

  return s
    .split(FENCE_SPLIT_RE)
    .map((part) => {
      if (part.startsWith('```')) return part;
      if (!containsHebrew(part)) return part;
      return part
        .split(/(\r?\n)/)
        .map((chunk) => (chunk === '\n' || chunk === '\r\n' ? chunk : reorderLine(chunk)))
        .join('');
    })
    .join('');
}

export default formatBidi;
