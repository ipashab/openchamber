/**
 * Team Mode routes for the client.
 *
 * The work-status panel of a team session renders the roster, the task board
 * and the mailbox tail from one fetch, refreshed by `openchamber:team-*`
 * events on the UI event stream. Everything the panel needs is public to the
 * user who owns the sessions anyway; agent-side writes stay on the agent tool,
 * while these routes carry what the app itself creates: a team from the "New
 * Team" dialog, and the presets that dialog offers.
 */

import express from 'express';

// This server parses JSON per route, not globally; every POST here that
// reads req.body needs the parser attached to the route itself.
const jsonBody = express.json({ limit: '1mb' });

export const registerTeamRoutes = (app, dependencies) => {
  const { teamService, teamPresets } = dependencies;
  if (!teamService) throw new Error('team routes need a team service');

  // One payload for every team the server knows; the panel belongs to a
  // session, and membership is a client-side lookup. Team state is small and
  // the route is only read by open panels.
  app.get('/api/openchamber/teams', async (_req, res) => {
    try {
      const teams = await teamService.overview();
      return res.json({ teams });
    } catch (error) {
      console.error('[team] failed to build the team board:', error?.message ?? error);
      return res.status(500).json({ error: 'Failed to load team board' });
    }
  });

  // Create a team from the app. The service validates the lineup against the
  // live agent/model catalog and answers with TeamError status codes, which
  // pass through so the dialog can show the reason.
  app.post('/api/openchamber/teams', jsonBody, async (req, res) => {
    try {
      const result = await teamService.createFromUi(req.body ?? {});
      return res.status(201).json(result);
    } catch (error) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      if (status >= 500) console.error('[team] team creation failed:', error?.message ?? error);
      return res.status(status).json({ error: error?.message ?? 'Failed to create team' });
    }
  });

  // "Edit team": the app adds a member to a live roster through the same
  // spawn path the lead tool uses, with the dialog's tool allowances, and
  // requests a member's shutdown with the same approval handshake.
  app.post('/api/openchamber/teams/:teamId/members', jsonBody, async (req, res) => {
    try {
      const result = await teamService.addMemberFromUi({ teamId: req.params?.teamId, input: req.body ?? {} });
      return res.status(201).json(result);
    } catch (error) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      if (status >= 500) console.error('[team] member add failed:', error?.message ?? error);
      return res.status(status).json({ error: error?.message ?? 'Failed to add member' });
    }
  });

  app.post('/api/openchamber/teams/:teamId/members/:slotId/shutdown', jsonBody, async (req, res) => {
    try {
      const result = await teamService.shutdownMemberFromUi({
        teamId: req.params?.teamId,
        slotId: req.params?.slotId,
        reason: req.body?.reason,
      });
      return res.json(result);
    } catch (error) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      if (status >= 500) console.error('[team] shutdown request failed:', error?.message ?? error);
      return res.status(status).json({ error: error?.message ?? 'Failed to request shutdown' });
    }
  });

  // Presets are always wired in the server; a missing store is a wiring bug.
  if (!teamPresets) throw new Error('team routes need a team preset store');

  app.get('/api/openchamber/team-presets', async (_req, res) => {
    try {
      const presets = await teamPresets.list();
      return res.json({ presets });
    } catch (error) {
      console.error('[team] failed to list presets:', error?.message ?? error);
      return res.status(500).json({ error: 'Failed to load team presets' });
    }
  });

  app.post('/api/openchamber/team-presets', jsonBody, async (req, res) => {
    try {
      const preset = await teamPresets.upsert(req.body ?? {});
      return res.json({ preset });
    } catch (error) {
      const status = /required|cannot exceed/.test(String(error?.message ?? '')) ? 400 : 500;
      if (status >= 500) console.error('[team] preset save failed:', error?.message ?? error);
      return res.status(status).json({ error: error?.message ?? 'Failed to save team preset' });
    }
  });

  app.delete('/api/openchamber/team-presets/:id', async (req, res) => {
    try {
      const removed = await teamPresets.remove(req.params?.id);
      if (!removed) return res.status(404).json({ error: 'Preset not found' });
      return res.json({ removed: true });
    } catch (error) {
      const message = String(error?.message ?? '');
      if (/built-in/.test(message)) return res.status(400).json({ error: message });
      if (!/required/.test(message)) console.error('[team] preset delete failed:', message);
      return res.status(/required/.test(message) ? 400 : 500).json({ error: message || 'Failed to delete preset' });
    }
  });
};
