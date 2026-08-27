/**
 * Jobs-engine ops HTTP (tracked groups, CV/profile, jobs table, Drive tracker).
 *
 * GET    /api/jobs/tracked-groups
 * POST   /api/jobs/tracked-groups  { name }
 * DELETE /api/jobs/tracked-groups  { name }
 * GET    /api/jobs/recent?limit=&status=
 * GET    /api/jobs/profile
 * PUT    /api/jobs/profile
 * GET    /api/jobs/cv
 * POST   /api/jobs/cv   multipart field "cv"
 * GET    /api/jobs/drive-tracker
 * POST   /api/jobs/drive-tracker   sync Excel to Drive
 */

import multer from 'multer';
import { mongoReady } from './group-store.js';
import { listJobsForGui } from './job-store.js';
import {
  listGroupsForGui,
  trackGroupFromGui,
  untrackGroupFromGui,
} from './track-gui.js';
import {
  getProfileForGui,
  saveCvProfile,
  saveCvPdf,
  readCvPdfBuffer,
} from './profile-store.js';
import { driveTrackerStatus, syncTrackerToDrive } from './drive-tracker.js';

const cvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

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
    try {
      const payload = await listJobsForGui({
        limit: req.query.limit,
        status: req.query.status,
      });
      res.json({ ok: true, ...payload });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message, code: err.code });
    }
  });

  app.get('/api/jobs/profile', (_req, res) => {
    try {
      res.json(getProfileForGui());
    } catch (err) {
      const status = err.code === 'CV_PROFILE_INVALID' ? 400 : 500;
      res.status(status).json({ ok: false, error: err.message, code: err.code });
    }
  });

  app.put('/api/jobs/profile', (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      res.json(saveCvProfile(body));
    } catch (err) {
      const status = err.code === 'CV_PROFILE_INVALID' ? 400 : 500;
      res.status(status).json({ ok: false, error: err.message, code: err.code });
    }
  });

  app.get('/api/jobs/cv', (_req, res) => {
    try {
      const buf = readCvPdfBuffer();
      if (!buf) {
        return res.status(404).json({
          ok: false,
          error: 'No CV uploaded yet. Use Settings → CV (saved on the data volume).',
          code: 'CV_NOT_FOUND',
        });
      }
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="cv.pdf"');
      res.send(buf);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message, code: err.code });
    }
  });

  app.post('/api/jobs/cv', (req, res, next) => {
    cvUpload.single('cv')(req, res, (err) => {
      if (err) {
        const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        return res.status(status).json({
          ok: false,
          error: err.message || 'CV upload failed',
          code: err.code || 'CV_UPLOAD_FAILED',
        });
      }
      next();
    });
  }, (req, res) => {
    try {
      const file = req.file;
      if (!file?.buffer) {
        return res.status(400).json({
          ok: false,
          error: 'Missing PDF file (multipart field name: cv)',
          code: 'CV_MISSING',
        });
      }
      const result = saveCvPdf(file.buffer, file.originalname || 'cv.pdf');
      res.json(result);
    } catch (err) {
      const status =
        err.code === 'CV_NOT_PDF' || err.code === 'CV_EMPTY' ? 400 : 500;
      res.status(status).json({ ok: false, error: err.message, code: err.code });
    }
  });

  app.get('/api/jobs/drive-tracker', (_req, res) => {
    res.json({ ok: true, ...driveTrackerStatus() });
  });

  app.post('/api/jobs/drive-tracker', async (_req, res) => {
    try {
      const result = await syncTrackerToDrive({ onLog: console.log });
      const status = result.ok ? 200 : result.code === 'GDRIVE_NOT_CONFIGURED' ? 409 : 400;
      res.status(status).json({ ...driveTrackerStatus(), ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message, code: err.code });
    }
  });
}
