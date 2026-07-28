/**
 * HTTP endpoints for CLI auth health / operator retry.
 *
 * GET  /api/cli-auth/status
 * POST /api/cli-auth/retry   — mark parked tasks + re-probe; resume is automatic
 *                             for in-flight waiters on the next poll tick
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

export function mountCliAuthRoutes(app) {
  app.get('/api/cli-auth/status', async (_req, res) => {
    try {
      expireParked();
      const cursor = await checkCursorAuth();
      const parked = listParked();
      res.json({
        ok: cursor.ok,
        cursor,
        parked,
        parkedCount: parked.length,
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
      return res.status(cursor.ok ? 200 : 503).json(cursor);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * Operator signal after completing browser login.
   * In-flight assertCliAuthReady waiters re-probe on their next interval;
   * this marks the queue and returns current health.
   */
  app.post('/api/cli-auth/retry', async (_req, res) => {
    try {
      const marked = markAllResumeRequested();
      const cursor = await checkCursorAuth();
      const parked = listParked();
      res.json({
        ok: cursor.ok,
        marked,
        cursor,
        parkedCount: parked.length,
        message: cursor.ok
          ? 'CLI auth healthy — waiting dispatches should resume on next poll'
          : 'Still unauthenticated — complete the login URL then POST /api/cli-auth/retry again',
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}
