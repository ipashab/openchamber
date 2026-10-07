/**
 * Missions routes for the client: the goal list the user files prompts into
 * and watches from. The list reads one fetch, refreshed by
 * `openchamber:mission-changed` events on the UI event stream; writes are
 * file, cancel, retry and delete — the queue itself is the service's.
 */

import express from 'express';

// This server parses JSON per route, not globally; every POST here that
// reads req.body needs the parser attached to the route itself.
const jsonBody = express.json({ limit: '1mb' });

const errorStatus = (error) => (Number.isInteger(error?.statusCode) ? error.statusCode : 500);

export const registerMissionsRoutes = (app, dependencies) => {
  const { missionsService } = dependencies;
  if (!missionsService) throw new Error('mission routes need a missions service');

  // One payload for every mission, newest first — same shape the panel lists.
  app.get('/api/openchamber/missions', async (_req, res) => {
    try {
      const missions = await missionsService.listMissions();
      return res.json({ missions });
    } catch (error) {
      console.error('[missions] failed to list missions:', error?.message ?? error);
      return res.status(500).json({ error: 'Failed to load missions' });
    }
  });

  // File a new goal. Validation errors answer with the reasons the form can
  // show beside the fields.
  app.post('/api/openchamber/missions', jsonBody, async (req, res) => {
    try {
      const result = await missionsService.createMission(req.body ?? {});
      return res.json(result);
    } catch (error) {
      const status = errorStatus(error);
      if (status >= 500) console.error('[missions] failed to create mission:', error?.message ?? error);
      return res.status(status).json({ error: error?.message ?? 'Failed to create the mission' });
    }
  });

  // Cancel waits for a queued mission or stops watching a running one; the
  // session a running mission started keeps going where its own user stops it.
  app.post('/api/openchamber/missions/:missionId/cancel', jsonBody, async (req, res) => {
    try {
      const result = await missionsService.cancelMission(req.params?.missionId);
      return res.json(result);
    } catch (error) {
      const status = errorStatus(error);
      if (status >= 500) console.error('[missions] failed to cancel mission:', error?.message ?? error);
      return res.status(status).json({ error: error?.message ?? 'Failed to cancel the mission' });
    }
  });

  // Requeue a finished mission as a fresh run with the same goal.
  app.post('/api/openchamber/missions/:missionId/retry', jsonBody, async (req, res) => {
    try {
      const result = await missionsService.retryMission(req.params?.missionId);
      return res.json(result);
    } catch (error) {
      const status = errorStatus(error);
      if (status >= 500) console.error('[missions] failed to retry mission:', error?.message ?? error);
      return res.status(status).json({ error: error?.message ?? 'Failed to retry the mission' });
    }
  });

  // Delete the record — the only write that also forgets the goal itself.
  // A running mission's session is not stopped, only unwatched.
  app.delete('/api/openchamber/missions/:missionId', async (req, res) => {
    try {
      const result = await missionsService.deleteMission(req.params?.missionId);
      return res.json(result);
    } catch (error) {
      const status = errorStatus(error);
      if (status >= 500) console.error('[missions] failed to delete mission:', error?.message ?? error);
      return res.status(status).json({ error: error?.message ?? 'Failed to delete the mission' });
    }
  });
};
