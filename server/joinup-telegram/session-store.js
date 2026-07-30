import fs from 'node:fs';
import path from 'node:path';

/** @typedef {'idle' | 'grilling' | 'awaiting_confirmation' | 'executing' | 'completed'} JoinUpPhase */

/**
 * Per-Telegram-user conversational state for grilling → confirm → execute.
 */
export class JoinUpSessionStore {
  /**
   * @param {{ stateFile?: string }} [options]
   */
  constructor(options = {}) {
    this.stateFile = options.stateFile || null;
    /** @type {Map<string, object>} */
    this.sessions = new Map();
    this._load();
  }

  _load() {
    if (!this.stateFile || !fs.existsSync(this.stateFile)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      for (const [k, v] of Object.entries(raw || {})) {
        this.sessions.set(k, v);
      }
    } catch {
      /* ignore corrupt store */
    }
  }

  _save() {
    if (!this.stateFile) return;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const obj = Object.fromEntries(this.sessions.entries());
      fs.writeFileSync(this.stateFile, JSON.stringify(obj, null, 2), 'utf8');
    } catch {
      /* ignore */
    }
  }

  /**
   * @param {string|number} userId
   */
  get(userId) {
    const key = String(userId);
    if (!this.sessions.has(key)) {
      const fresh = {
        userId: key,
        phase: /** @type {JoinUpPhase} */ ('idle'),
        history: [],
        pendingSpecSummary: '',
        pendingTechnicalPrompt: '',
        lastAgentReply: '',
        updatedAt: new Date().toISOString(),
      };
      this.sessions.set(key, fresh);
      return fresh;
    }
    return this.sessions.get(key);
  }

  /**
   * @param {string|number} userId
   * @param {Partial<object>} patch
   */
  update(userId, patch) {
    const cur = this.get(userId);
    const next = {
      ...cur,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(String(userId), next);
    this._save();
    return next;
  }

  /**
   * @param {string|number} userId
   * @param {'user'|'assistant'|'system'} role
   * @param {string} text
   */
  appendHistory(userId, role, text) {
    const cur = this.get(userId);
    const history = [...(cur.history || []), { role, text, at: new Date().toISOString() }];
    // Cap history to keep state file small
    const trimmed = history.slice(-40);
    return this.update(userId, { history: trimmed });
  }

  /**
   * @param {string|number} userId
   */
  reset(userId) {
    this.sessions.delete(String(userId));
    this._save();
  }
}

/**
 * Detect explicit product confirmation / "go build now" intent.
 * Non-technical collaborators often confirm in full sentences (HE/EN).
 * @param {string} text
 */
export function isExplicitConfirmation(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;

  // Short English confirmations
  if (
    /^(yes|y|ok|okay|sure|proceed|confirm|confirmed|go ahead|build it|do it|approve|approved)[.!]?$/i.test(
      t
    )
  ) {
    return true;
  }
  if (
    /\b(go ahead and build|yes,?\s*(please\s+)?build|please (build|proceed|execute)|run it|execute (it|now|the task)|start building)\b/i.test(
      t
    )
  ) {
    return true;
  }

  // Short Hebrew confirmations
  if (/^(כן|בטח|קדימה|אשר|מאשר|לבנות|תבנה|תתחיל|יאללה|בצע|תבצע)[.!]?$/i.test(t)) {
    return true;
  }

  // Hebrew / mixed full-sentence approvals (common Telegram phrasing)
  if (
    /(יש אישור|אפשר לבנות|תבנה את זה|כן,?\s*תבנה|שגר(\s*ל-?\s*cursor)?|תתחיל לבנות|תתחיל לעבוד|לבצע את המשימה|תבצע את המשימה|תנסה עכשיו|עכשיו לבצע|תריץ (את )?(זה|המשימה)|בצע (את )?המשימה|שלח (את זה )?לבנייה|תשלח לבנייה|תעביר (את זה )?(לתיקון|לקרסר|לבנייה)|תתקן( את זה)?|לתיקון בבקשה)/i.test(
      t
    )
  ) {
    return true;
  }

  return false;
}

/**
 * Detect when the product LLM claims it is already sending work to Cursor/build,
 * even if it forgot the READY_TO_BUILD marker (common Hebrew phrasing).
 * @param {string} text
 */
export function claimsSendingToBuild(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  return (
    /(שולח|מעביר|שולחת|מעבירה)\s+.{0,60}(לתיקון|לבני[יה]|לביצוע|לקרסר|ל-?\s*cursor|לסוכן)/i.test(
      t
    ) ||
    /(sending|handing off|dispatching)\s+.{0,60}(to\s+)?(build|fix|cursor|the agent)/i.test(
      t
    ) ||
    /(start(ing)?|began)\s+(the\s+)?(build|fix)/i.test(t) ||
    /שולח את זה לתיקון/i.test(t)
  );
}

/**
 * Detect explicit cancel / start over commands.
 * Used as a fast-path bypass for LLM intent classification.
 * @param {string} text
 */
export function isCancelOrReset(text) {
  const t = String(text || '').trim().toLowerCase();
  return t === '/stop' || t === '/cancel' || t === '/reset';
}


/**
 * Extract READY_TO_BUILD payload from agent reply, if present.
 * @param {string} reply
 * @returns {{ cleanReply: string, technicalPrompt: string|null }}
 */
export function extractReadyToBuild(reply) {
  const text = String(reply || '');
  const m = text.match(/^([\s\S]*?)(?:\r?\n)?READY_TO_BUILD:\s*(.+)\s*$/im);
  if (!m) return { cleanReply: text.trim(), technicalPrompt: null };
  const cleanReply = m[1].trim();
  const technicalPrompt = m[2].trim();
  return {
    cleanReply: cleanReply || text.replace(/READY_TO_BUILD:\s*.+$/im, '').trim(),
    technicalPrompt: technicalPrompt || null,
  };
}
