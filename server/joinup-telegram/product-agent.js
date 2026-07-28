import { createLlmSessionManager } from '../llm-session.js';
import { JOINUP_PRODUCT_AGENT_SYSTEM_PROMPT } from './prompt.js';
import {
  claimsSendingToBuild,
  extractReadyToBuild,
  isCancelOrReset,
  isExplicitConfirmation,
} from './session-store.js';
import { formatCompletionMessage } from './executor.js';
import { logMessage } from '../message-store.js';

/**
 * Conversational product agent: grill → summarize → confirm → hand off to Cursor.
 * Uses Claude CLI or Gemini (AGENT_LLM_PROVIDER) with the joinUp-specific system prompt.
 */
export class JoinUpProductAgent {
  /**
   * @param {object} options
   * @param {import('./session-store.js').JoinUpSessionStore} options.store
   * @param {import('./executor.js').JoinUpCursorExecutor} options.executor
   * @param {boolean} [options.mock]
   * @param {string} [options.sessionsFile]
   * @param {string} [options.claudeBin]
   * @param {string} [options.systemPrompt]
   * @param {string} [options.provider]
   * @param {(line: string) => void} [options.onLog]
   */
  constructor(options) {
    this.store = options.store;
    this.executor = options.executor;
    this.onLog = options.onLog || (() => {});
    this.mock = Boolean(options.mock);
    this.claude = createLlmSessionManager({
      mock: this.mock,
      sessionsFile: options.sessionsFile,
      claudeBin: options.claudeBin,
      systemPrompt: options.systemPrompt || JOINUP_PRODUCT_AGENT_SYSTEM_PROMPT,
      provider: options.provider,
    });
    const info =
      typeof this.claude.getProviderInfo === 'function'
        ? this.claude.getProviderInfo()
        : { provider: 'unknown', model: 'unknown' };
    this.llmProvider = info.provider;
    this.llmModel = info.model;
    this.onLog(
      `[joinup-telegram] product agent llm=${this.llmProvider}/${this.llmModel} mock=${this.mock}`
    );
  }

  clientIdFor(userId) {
    return `joinup-tg:${userId}`;
  }

  /**
   * Handle one inbound Telegram text message for an authorized user.
   * @param {{ userId: string|number, text: string, signal?: AbortSignal, deferDispatch?: boolean }} input
   * @returns {Promise<{ reply: string, phase: string, dispatched?: boolean, needsDispatch?: boolean, pendingBuild?: boolean }>}
   */
  async handleMessage({ userId, text, signal, deferDispatch = false }) {
    const cleaned = String(text || '').trim();
    if (!cleaned) {
      return {
        reply: 'Please send a short description of what you would like in joinUp.',
        phase: this.store.get(userId).phase,
        pendingBuild: Boolean(this.store.get(userId).pendingTechnicalPrompt),
      };
    }

    if (isCancelOrReset(cleaned)) {
      this.claude.reset(this.clientIdFor(userId));
      this.store.reset(userId);
      this.store.update(userId, {
        phase: 'idle',
        pendingTechnicalPrompt: '',
        pendingSpecSummary: '',
      });
      return {
        reply:
          'Okay — I cleared our conversation. Tell me a new joinUp idea whenever you are ready.',
        phase: 'idle',
        pendingBuild: false,
      };
    }

    const session = this.store.get(userId);
    const hasPendingBuild = Boolean(session.pendingTechnicalPrompt);

    // If we already have a technical prompt and the user confirms / asks to run it, execute.
    if (hasPendingBuild && isExplicitConfirmation(cleaned)) {
      this.store.appendHistory(userId, 'user', cleaned);
      if (deferDispatch) {
        return {
          reply: '',
          phase: 'awaiting_confirmation',
          needsDispatch: true,
          pendingBuild: true,
        };
      }
      return this._executeConfirmed(userId, signal);
    }

    this.store.appendHistory(userId, 'user', cleaned);
    logMessage({
      sessionId: this.clientIdFor(userId),
      userId: String(userId),
      channel: 'telegram',
      role: 'user',
      content: cleaned
    });

    if (!hasPendingBuild) {
      this.store.update(userId, { phase: 'grilling' });
    }

    const agentReply = await this._askAgent(userId, cleaned, signal);
    const { cleanReply, technicalPrompt } = extractReadyToBuild(agentReply);

    this.store.appendHistory(userId, 'assistant', cleanReply);
    logMessage({
      sessionId: this.clientIdFor(userId),
      userId: String(userId),
      channel: 'telegram',
      role: 'assistant',
      content: cleanReply
    });

    if (technicalPrompt) {
      this.store.update(userId, {
        phase: 'awaiting_confirmation',
        pendingTechnicalPrompt: technicalPrompt,
        pendingSpecSummary: cleanReply,
        lastAgentReply: cleanReply,
      });
      // If the user already confirmed in this same message, build immediately.
      if (isExplicitConfirmation(cleaned)) {
        if (deferDispatch) {
          return {
            reply: cleanReply || '',
            phase: 'awaiting_confirmation',
            needsDispatch: true,
            pendingBuild: true,
          };
        }
        return this._executeConfirmed(userId, signal);
      }
      return {
        reply:
          cleanReply ||
          'I have a clear plan for joinUp. Should I proceed with building this for joinUp?',
        phase: 'awaiting_confirmation',
        pendingBuild: true,
      };
    }

    // Safety net: LLM claimed "sending to fix/build" but omitted READY_TO_BUILD.
    if (claimsSendingToBuild(cleanReply)) {
      const synthesized = this._ensureTechnicalPrompt(userId, cleanReply);
      if (synthesized) {
        this.onLog(
          '[joinup-telegram] LLM claimed send-to-fix/build — dispatching (synthesized READY_TO_BUILD if needed)'
        );
        if (deferDispatch) {
          return {
            reply: cleanReply,
            phase: 'awaiting_confirmation',
            needsDispatch: true,
            pendingBuild: true,
          };
        }
        return this._executeConfirmed(userId, signal);
      }
    }

    // Heuristic: if the agent asked for confirmation without the marker, still track phase.
    const asksConfirm =
      /should i proceed|proceed with building|תבנה|לאשר|מאשר|לְאַשֵׁר|האם להמשיך|נכון\?/i.test(
        cleanReply
      );
    this.store.update(userId, {
      phase:
        asksConfirm || hasPendingBuild ? 'awaiting_confirmation' : 'grilling',
      lastAgentReply: cleanReply,
    });

    return {
      reply: cleanReply,
      phase: this.store.get(userId).phase,
      pendingBuild: Boolean(this.store.get(userId).pendingTechnicalPrompt),
    };
  }

  /**
   * Clear Claude session + JoinUp store (including stuck pendingBuild).
   */
  resetUser(userId) {
    this.claude.reset(this.clientIdFor(userId));
    this.store.reset(userId);
    this.store.update(userId, {
      phase: 'idle',
      pendingTechnicalPrompt: '',
      pendingSpecSummary: '',
      lastAgentReply: '',
    });
  }

  /**
   * Start Cursor build for a pending technical prompt (used by async /api/joinup/dispatch).
   */
  async executePending(userId, signal) {
    return this._executeConfirmed(userId, signal);
  }

  /**
   * Ensure a pending technical prompt exists before Cursor dispatch.
   * Synthesizes one from the product summary + recent history when the LLM forgot READY_TO_BUILD.
   */
  _ensureTechnicalPrompt(userId, cleanReply) {
    const session = this.store.get(userId);
    if (session.pendingTechnicalPrompt) return session.pendingTechnicalPrompt;

    const history = (session.history || [])
      .slice(-14)
      .map((h) => `${h.role}: ${String(h.text || '').slice(0, 500)}`)
      .join('\n');
    const summary = String(cleanReply || session.lastAgentReply || '').slice(0, 1800);
    if (!summary && !history) return null;

    const technicalPrompt = [
      'Product-confirmed joinUp fix from Telegram collaborator.',
      'Stay strictly inside the joinUp repository. Do not touch other projects.',
      '',
      'Product summary / intent:',
      summary || '(see conversation)',
      '',
      'Recent conversation:',
      history || '(none)',
      '',
      'Implement the described UX/behavior change end-to-end (web + mobile if the feature spans both).',
      'Run local quality gates, then merge to Dev when green.',
    ].join('\n');

    this.store.update(userId, {
      phase: 'awaiting_confirmation',
      pendingTechnicalPrompt: technicalPrompt,
      pendingSpecSummary: summary,
      lastAgentReply: summary,
    });
    return technicalPrompt;
  }

  async _askAgent(userId, userText, signal) {
    if (this.mock) {
      return this._mockProductTurn(userId, userText);
    }

    const clientId = this.clientIdFor(userId);
    this.onLog(
      `[joinup-telegram] ask user=${userId} llm=${this.llmProvider}/${this.llmModel}`
    );
    let full = '';
    for await (const event of this.claude.ask(clientId, userText, { signal })) {
      if (event.type === 'text' && event.text) full += event.text;
      if (event.type === 'error') {
        const err = new Error(event.error || 'Product agent error');
        if (event.code) err.code = event.code;
        if (event.authUrl) err.authUrl = event.authUrl;
        if (event.tool) err.tool = event.tool;
        throw err;
      }
    }
    return full.trim();
  }

  /**
   * Deterministic grilling flow for tests / JOINUP_TELEGRAM_MOCK=1.
   */
  _mockProductTurn(userId, userText) {
    const session = this.store.get(userId);
    const turns = (session.history || []).filter((h) => h.role === 'user').length;

    if (isExplicitConfirmation(userText) && session.pendingTechnicalPrompt) {
      return session.lastAgentReply || 'Confirmed.';
    }

    if (turns <= 1) {
      return [
        'Thanks — I want to make sure this feels right in joinUp.',
        '',
        '1) Who is this for (which kind of user), and what should they see on screen?',
        '2) What should happen when they try this action?',
        '3) What should happen if something goes wrong (empty state / error)?',
      ].join('\n');
    }

    if (turns === 2) {
      return [
        'Great details. A couple more:',
        '',
        '1) Any must-have visuals or wording?',
        '2) Anything that must NOT change for other users?',
      ].join('\n');
    }

    const summary = [
      'Here is the plan for joinUp in simple terms:',
      '',
      `• Based on what you described: ${userText.slice(0, 280)}`,
      '• We will shape the experience to match that behavior and the edge cases you mentioned.',
      '',
      'Should I proceed with building this for joinUp?',
      '',
      `READY_TO_BUILD: Implement the joinUp product change described by the collaborator. User-facing intent: ${userText.slice(0, 500)}. Keep UX clear; handle empty/error states gracefully. Stay inside the joinUp repository only.`,
    ].join('\n');
    return summary;
  }

  async _executeConfirmed(userId, signal) {
    const session = this.store.get(userId);
    const technicalPrompt = session.pendingTechnicalPrompt;
    if (!technicalPrompt) {
      return {
        reply:
          'I still need a few product details before building. Please describe the joinUp change you want.',
        phase: 'grilling',
      };
    }

    this.store.update(userId, { phase: 'executing' });
    this.onLog(`[joinup-telegram] executing for user=${userId}`);

    try {
      const execResult = await this.executor.execute(technicalPrompt, {
        signal,
        onLog: this.onLog,
      });
      this.store.update(userId, {
        phase: 'completed',
        pendingTechnicalPrompt: '',
        lastVercelUrl: execResult?.vercel?.url || '',
        lastStagingUrl: execResult?.staging?.stagingUrl || '',
      });
      this.claude.reset(this.clientIdFor(userId));
      return {
        reply: formatCompletionMessage({
          ok: true,
          vercel: execResult?.vercel,
          staging: execResult?.staging,
        }),
        phase: 'completed',
        dispatched: true,
        vercelUrl: execResult?.vercel?.url || '',
        stagingUrl: execResult?.staging?.stagingUrl || '',
      };
    } catch (err) {
      this.store.update(userId, { phase: 'awaiting_confirmation' });
      this.onLog(`[joinup-telegram] execute failed: ${err.message}`);
      return {
        reply: formatCompletionMessage({
          ok: false,
          error: err.message,
          vercel: { url: process.env.JOINUP_VERCEL_PRODUCTION_URL || '' },
          staging: {
            stagingUrl:
              process.env.JOINUP_STAGING_URL ||
              'https://my-app-staging-ijyp.onrender.com',
            skipped: true,
            reason: 'execute_failed',
          },
        }),
        phase: 'awaiting_confirmation',
        dispatched: false,
      };
    }
  }
}
