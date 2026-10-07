import { describe, expect, it, vi } from 'vitest';

import { registerAssistantsRoutes } from './routes.js';

const makeApp = () => {
  const routes = new Map();
  const record = (method) => (routePath, ...handlers) => {
    routes.set(`${method} ${routePath}`, handlers);
  };
  return {
    routes,
    get: record('GET'),
    post: record('POST'),
    put: record('PUT'),
    delete: record('DELETE'),
  };
};

const makeRes = () => {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
};

const findRoute = (app, method, routePath) => {
  const handlers = app.routes.get(`${method} ${routePath}`);
  if (!handlers) throw new Error(`route not registered: ${method} ${routePath}`);
  return { handler: handlers[handlers.length - 1] };
};

describe('registerAssistantsRoutes', () => {
  it('registers the five contact resources', () => {
    const app = makeApp();
    registerAssistantsRoutes(app, { assistantsService: {} });
    const paths = [...app.routes.keys()].sort();
    expect(paths).toEqual([
      'DELETE /api/openchamber/assistants/:assistantId',
      'GET /api/openchamber/assistants',
      'POST /api/openchamber/assistants',
      'POST /api/openchamber/assistants/:assistantId/chat',
      'PUT /api/openchamber/assistants/:assistantId',
    ]);
  });

  it('requires an assistants service', () => {
    expect(() => registerAssistantsRoutes(makeApp(), {})).toThrow('assistants service');
  });

  it('serves the address book', async () => {
    const app = makeApp();
    const assistants = [{ id: 'assistant_1', name: 'Reviewbot' }];
    registerAssistantsRoutes(app, { assistantsService: { listAssistants: async () => assistants } });
    const { handler } = findRoute(app, 'GET', '/api/openchamber/assistants');
    const res = makeRes();
    await handler({}, res);
    expect(res.statusCode).toBeNull();
    expect(res.body).toEqual({ assistants });
  });

  it('passes validation failures through with their status', async () => {
    const app = makeApp();
    const error = Object.assign(new Error('name is required'), { statusCode: 400 });
    registerAssistantsRoutes(app, { assistantsService: { createAssistant: async () => { throw error; } } });
    const { handler } = findRoute(app, 'POST', '/api/openchamber/assistants');
    const res = makeRes();
    await handler({ body: {} }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('name is required');
  });

  it('routes edit, delete and chat-opening to the service', async () => {
    const app = makeApp();
    const updateAssistant = vi.fn(async () => ({ assistant: { id: 'assistant_1' } }));
    const deleteAssistant = vi.fn(async () => ({ deleted: true, assistantId: 'assistant_1' }));
    const openChat = vi.fn(async () => ({ assistant: {}, sessionId: 'ses_1', created: true }));
    registerAssistantsRoutes(app, { assistantsService: { updateAssistant, deleteAssistant, openChat } });

    const edit = findRoute(app, 'PUT', '/api/openchamber/assistants/:assistantId');
    await edit.handler({ params: { assistantId: 'assistant_1' }, body: { name: 'New name' } }, makeRes());
    expect(updateAssistant).toHaveBeenCalledWith('assistant_1', { name: 'New name' });

    const remove = findRoute(app, 'DELETE', '/api/openchamber/assistants/:assistantId');
    const removedRes = makeRes();
    await remove.handler({ params: { assistantId: 'assistant_1' } }, removedRes);
    expect(removedRes.body).toEqual({ deleted: true, assistantId: 'assistant_1' });

    const chat = findRoute(app, 'POST', '/api/openchamber/assistants/:assistantId/chat');
    const chatRes = makeRes();
    await chat.handler({ params: { assistantId: 'assistant_1' }, body: { directory: '/work' } }, chatRes);
    expect(openChat).toHaveBeenCalledWith('assistant_1', { directory: '/work' });
    expect(chatRes.body.sessionId).toBe('ses_1');
  });

  it('answers 500 when the chat cannot open at all', async () => {
    const app = makeApp();
    registerAssistantsRoutes(app, {
      assistantsService: { openChat: async () => { throw new Error('runtime down'); } },
    });
    const { handler } = findRoute(app, 'POST', '/api/openchamber/assistants/:assistantId/chat');
    const res = makeRes();
    await handler({ params: { assistantId: 'assistant_1' }, body: {} }, res);
    expect(res.statusCode).toBe(500);
  });
});
