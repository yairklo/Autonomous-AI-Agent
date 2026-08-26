/**
 * Jobs-engine ops HTTP (tracked groups + recent Mongo jobs + GUI track/resolve).
 *
 * GET    /api/jobs/tracked-groups
 * POST   /api/jobs/tracked-groups  { name }  — track by live WA match, or by name if WA is down
 * DELETE /api/jobs/tracked-groups  { name }
 * GET    /api/jobs/recent?limit=&status=
 */

import { mongoReady } from './group-store.js';
import { listRecentJobs } from './job-store.js';
import {
  listGroupsForGui,
  trackGroupFromGui,
  untrackGroupFromGui,
} from './track-gui.js';

function mongoUnavailable(res) {
  return res.status(503).json({
    ok: false,
    error: 'MongoDB is not connected',
    code: 'MONGO_UNAVAILABLE',
  });
}

/**
 * @param {import('express').Express} app
 */
export function mountJobsEngineRoutes(app) {
  app.get('/api/jobs/tracked-groups', async (req, res) => {
    try {
      // GUI-friendly list works with file fallback when Mongo is down.
      if (String(req.query.gui || '') === '1' || !mongoReady()) {
        const payload = await listGroupsForGui();
        return res.json(payload);
      }
      const { listTrackedGroups } = await import('./group-store.js');
      const activeOnly = String(req.query.active || '1') !== '0';
      const groups = await listTrackedGroups({ activeOnly });
      const gui = await listGroupsForGui();
      res.json({
        ok: true,
        groups: groups.map((g) => g.name),
        tracked: groups,
        whatsapp: gui.whatsapp,
        source: 'mongo',
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message, code: err.code });
    }
  });

  app.post('/api/jobs/tracked-groups', async (req, res) => {
    try {
      const name = req.body?.name || req.body?.group;
      const result = await trackGroupFromGui(name, { addedBy: 'gui' });
      if (!result.ok) {
        const status =
          result.code === 'GROUP_NAME_REQUIRED'
            ? 400
            : result.code === 'WA_GROUP_AMBIGUOUS' || result.code === 'WA_NOT_READY'
              ? 409
              : 404;
        return res.status(status).json(result);
      }
      res.json(result);
    } catch (err) {
      const status = err.code === 'GROUP_NAME_REQUIRED' ? 400 : 500;
      res.status(status).json({
        ok: false,
        found: false,
        added: false,
        error: err.message,
        code: err.code,
      });
    }
  });

  app.delete('/api/jobs/tracked-groups', async (req, res) => {
    try {
      const name = req.body?.name || req.body?.group || req.query?.name;
      const result = await untrackGroupFromGui(name);
      if (!result.ok) {
        const status =
          result.code === 'GROUP_NAME_REQUIRED'
            ? 400
            : result.code === 'GROUP_NOT_TRACKED'
              ? 404
              : 500;
        return res.status(status).json(result);
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({
        ok: false,
        removed: false,
        error: err.message,
        code: err.code,
      });
    }
  });

  app.get('/api/jobs/recent', async (req, res) => {
    if (!mongoReady()) return mongoUnavailable(res);
    try {
      const jobs = await listRecentJobs({
        limit: req.query.limit,
        status: req.query.status,
      });
      res.json({ ok: true, jobs });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message, code: err.code });
    }
  });
}
