/**
 * Assistant-contact routes for the client: the saved personas the user
 * chats with. The list reads one fetch, refreshed by
 * `openchamber:assistant-changed` events on the UI event stream; writes are
 * create, edit, delete, and opening the contact's continuing chat.
 */

import express from 'express';

// This server parses JSON per route, not globally; every POST here that
// reads req.body needs the parser attached to the route itself.
const jsonBody = express.json({ limit: '1mb' });

const errorStatus = (error) => (Number.isInteger(error?.statusCode) ? error.statusCode : 500);

export const registerAssistantsRoutes = (app, dependencies) => {
  const { assistantsService } = dependencies;
  if (!assistantsService) throw new Error('assistant routes need an assistants service');

  // Every contact at once — the page lists the whole address book.
  app.get('/api/openchamber/assistants', async (_req, res) => {
    try {
      const assistants = await assistantsService.listAssistants();
      return res.json({ assistants });
    } catch (error) {
      console.error('[assistants] failed to list contacts:', error?.message ?? error);
      return res.status(500).json({ error: 'Failed to load contacts' });
    }
  });

  // Save a new persona. Validation errors answer with every reason the form
  // can show beside the fields.
  app.post('/api/openchamber/assistants', jsonBody, async (req, res) => {
    try {
      const result = await assistantsService.createAssistant(req.body ?? {});
      return res.json(result);
    } catch (error) {
      const status = errorStatus(error);
      if (status >= 500) console.error('[assistants] failed to create contact:', error?.message ?? error);
      return res.status(status).json({ error: error?.message ?? 'Failed to create the contact' });
    }
  });

  // Edit a persona. The chat it already started keeps its old opening;
  // a fresh thread after this point speaks the new prompt.
  app.put('/api/openchamber/assistants/:assistantId', jsonBody, async (req, res) => {
    try {
      const result = await assistantsService.updateAssistant(req.params?.assistantId, req.body ?? {});
      return res.json(result);
    } catch (error) {
      const status = errorStatus(error);
      if (status >= 500) console.error('[assistants] failed to update contact:', error?.message ?? error);
      return res.status(status).json({ error: error?.message ?? 'Failed to update the contact' });
    }
  });

  // Forget the persona; the chat it started stays as an ordinary session.
  app.delete('/api/openchamber/assistants/:assistantId', async (req, res) => {
    try {
      const result = await assistantsService.deleteAssistant(req.params?.assistantId);
      return res.json(result);
    } catch (error) {
      const status = errorStatus(error);
      if (status >= 500) console.error('[assistants] failed to delete contact:', error?.message ?? error);
      return res.status(status).json({ error: error?.message ?? 'Failed to delete the contact' });
    }
  });

  // Open the contact's chat: continue its thread while it exists, start a
  // fresh one (seeded with the persona) when it does not.
  app.post('/api/openchamber/assistants/:assistantId/chat', jsonBody, async (req, res) => {
    try {
      const result = await assistantsService.openChat(req.params?.assistantId, req.body ?? {});
      return res.json(result);
    } catch (error) {
      const status = errorStatus(error);
      if (status >= 500) console.error('[assistants] failed to open contact chat:', error?.message ?? error);
      return res.status(status).json({ error: error?.message ?? 'Failed to open the contact chat' });
    }
  });
};
