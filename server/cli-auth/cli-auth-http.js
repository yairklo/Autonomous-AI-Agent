/**
 * HTTP endpoints for CLI auth health / operator retry / Claude code paste.
 *
 * GET  /api/cli-auth/status
 * GET  /api/cli-auth/health
 * POST /api/cli-auth/retry
 * POST /api/cli-auth/submit-code  { code }  — paste Claude browser login code
 */

import {
  checkClaudeAuth,
  checkCursorAuth,
} from './health.js';
import {
  expireParked,
  listParked,
  markAllResumeRequested,
} from './queue.js';
import {
  getActiveClaudeLoginSession,
  submitClaudeLoginCode,
} from './claude-login-session.js';
import {
  getActiveCursorLoginSession,
  hasActiveCursorLoginSession,
} from './cursor-login-session.js';

export function mountCliAuthRoutes(app) {
  app.get('/api/cli-auth/status', async (_req, res) => {
    try {
      expireParked();
      const cursor = await checkCursorAuth();
      const claude = await checkClaudeAuth();
      const parked = listParked();
      res.json({
        ok: cursor.ok && claude.ok,
        cursor,
        claude,
        parked,
        parkedCount: parked.length,
        liveLogin: {
          cursor: getActiveCursorLoginSession(),
          claude: getActiveClaudeLoginSession(),
        },
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/cli-auth/health', async (req, res) => {
    const tool = String(req.query.tool || 'cursor').toLowerCase();
    try {
      if (tool === 'claude') {
        const claude = await checkClaudeAuth();
        return res.status(claude.ok ? 200 : 503).json(claude);
      }
      if (tool === 'all') {
        const cursor = await checkCursorAuth();
        const claude = await checkClaudeAuth();
        const ok = cursor.ok && claude.ok;
        return res.status(ok ? 200 : 503).json({ ok, cursor, claude });
      }
      const cursor = await checkCursorAuth();
      return res.status(cursor.ok ? 200 : 503).json({
        ...cursor,
        liveLogin: getActiveCursorLoginSession(),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/cli-auth/retry', async (_req, res) => {
    try {
      const marked = markAllResumeRequested();
      const cursor = await checkCursorAuth();
      const claude = await checkClaudeAuth();
      const parked = listParked();
      const liveCursor = getActiveCursorLoginSession();
      res.json({
        ok: cursor.ok,
        marked,
        cursor,
        claude,
        parkedCount: parked.length,
        liveCursorLogin: liveCursor,
        message: cursor.ok
          ? 'CLI auth healthy — waiting dispatches should resume on next poll'
          : hasActiveCursorLoginSession()
            ? 'Cursor login process still alive — finish the SAME browser URL (do not request a new link)'
            : 'Still unauthenticated — start a new dispatch to get a fresh live login URL',
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/cli-auth/submit-code', async (req, res) => {
    try {
      const code = String(req.body?.code || req.body?.authCode || '').trim();
      if (!code) {
        return res.status(400).json({ ok: false, error: 'code is required' });
      }
      const result = await submitClaudeLoginCode(code);
      const claude = await checkClaudeAuth();
      return res.status(result.ok || claude.ok ? 200 : 409).json({
        ...result,
        claude,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}
