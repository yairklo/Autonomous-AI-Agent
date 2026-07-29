/**
 * Jobs-engine ops HTTP (tracked groups + recent Mongo jobs).
 *
 * GET    /api/jobs/tracked-groups
 * POST   /api/jobs/tracked-groups  { name }
 * DELETE /api/jobs/tracked-groups  { name }
 * GET    /api/jobs/recent?limit=&status=
 */

import {
  listTrackedGroups,
  trackGroupByName,
  untrackGroupByName,
  mongoReady,
} from './group-store.js';
import { listRecentJobs } from './job-store.js';

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
    if (!mongoReady()) return mongoUnavailable(res);
    try {
      const activeOnly = String(req.query.active || '1') !== '0';
      const groups = await listTrackedGroups({ activeOnly });
      res.json({ ok: true, groups });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message, code: err.code });
    }
  });

  app.post('/api/jobs/tracked-groups', async (req, res) => {
    if (!mongoReady()) return mongoUnavailable(res);
    try {
      const name = req.body?.name || req.body?.group;
      const group = await trackGroupByName(name, { addedBy: 'api' });
      res.json({ ok: true, group });
    } catch (err) {
      const status = err.code === 'GROUP_NAME_REQUIRED' ? 400 : 500;
      res.status(status).json({ ok: false, error: err.message, code: err.code });
    }
  });

  app.delete('/api/jobs/tracked-groups', async (req, res) => {
    if (!mongoReady()) return mongoUnavailable(res);
    try {
      const name = req.body?.name || req.body?.group;
      const group = await untrackGroupByName(name);
      if (!group) {
        return res.status(404).json({ ok: false, error: 'Group not found' });
      }
      res.json({ ok: true, group });
    } catch (err) {
      const status = err.code === 'GROUP_NAME_REQUIRED' ? 400 : 500;
      res.status(status).json({ ok: false, error: err.message, code: err.code });
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
