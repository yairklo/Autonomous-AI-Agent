/**
 * GET /api/metrics/tokens?period=day|week|all
 */

import { summarizeTokenUsage } from './token-logger.js';

export function mountTokenMetricsRoutes(app) {
  app.get('/api/metrics/tokens', (req, res) => {
    try {
      const period = String(req.query.period || 'day').toLowerCase();
      const summary = summarizeTokenUsage({ period });
      res.json({ ok: true, ...summary });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}
