import { describe, expect, it, vi } from 'vitest';

import { registerTeamRoutes } from './routes.js';

const makeApp = () => {
  const routes = [];
  // Registration may pass route middleware (express.json) before the handler;
  // the last argument is the handler the tests invoke.
  const record = (method) => (path, ...handlers) => routes.push({ method, path, handler: handlers.at(-1) });
  return {
    routes,
    get: record('GET'),
    post: record('POST'),
    delete: record('DELETE'),
  };
};

const makeService = ({ overview = [], createFromUi } = {}) => ({
  overview: vi.fn(async () => overview),
  ...(createFromUi ? { createFromUi: vi.fn(createFromUi) } : { createFromUi: vi.fn(async () => ({ team: {}, leadSessionId: 'ses_1', members: [] })) }),
});

const makePresets = (overrides = {}) => ({
  list: vi.fn(async () => [{ id: 'builtin-duo', name: 'Дуэт', builtIn: true }]),
  upsert: vi.fn(async (preset) => ({ id: 'preset_1', ...preset })),
  remove: vi.fn(async () => true),
  ...overrides,
});

const makeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  return res;
};

const findRoute = (app, method, path) => {
  const route = app.routes.find((entry) => entry.method === method && entry.path === path);
  if (!route) throw new Error(`route ${method} ${path} was not registered`);
  return route;
};

describe('team routes', () => {
  it('serves the overview payload on GET /api/openchamber/teams', async () => {
    const app = makeApp();
    const boards = [{
      id: 'team_1',
      name: 'Crew',
      members: [{ slotId: 'lead', name: 'Team Lead', role: 'lead', status: 'idle', sessionId: 'ses_1', unreadCount: 1 }],
      tasks: [],
      recentMessages: [],
    }];
    registerTeamRoutes(app, { teamService: makeService({ overview: boards }), teamPresets: makePresets() });

    const res = makeRes();
    await findRoute(app, 'GET', '/api/openchamber/teams').handler({}, res);
    expect(res.statusCode).toBeNull();
    expect(res.body).toEqual({ teams: boards });
  });

  it('answers 500 without leaking the error when the service fails', async () => {
    const app = makeApp();
    const service = makeService();
    service.overview = async () => {
      throw new Error('state unreadable');
    };
    registerTeamRoutes(app, { teamService: service, teamPresets: makePresets() });

    const res = makeRes();
    await findRoute(app, 'GET', '/api/openchamber/teams').handler({}, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to load team board' });
  });

  it('creates a team on POST /api/openchamber/teams and forwards the result', async () => {
    const app = makeApp();
    const service = makeService({
      createFromUi: async (body) => ({ team: { id: 'team_9', name: body.name }, leadSessionId: 'ses_lead', members: [] }),
    });
    registerTeamRoutes(app, { teamService: service, teamPresets: makePresets() });

    const res = makeRes();
    await findRoute(app, 'POST', '/api/openchamber/teams').handler({ body: { name: 'Crew' } }, res);
    expect(res.statusCode).toBe(201);
    expect(res.body.team).toEqual({ id: 'team_9', name: 'Crew' });
    expect(service.createFromUi).toHaveBeenCalledWith({ name: 'Crew' });
  });

  it('passes a TeamError status through on team creation', async () => {
    const app = makeApp();
    const refusal = Object.assign(new Error('only one member can be the team lead'), { statusCode: 400 });
    const service = makeService({ createFromUi: async () => { throw refusal; } });
    registerTeamRoutes(app, { teamService: service, teamPresets: makePresets() });

    const res = makeRes();
    await findRoute(app, 'POST', '/api/openchamber/teams').handler({ body: {} }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'only one member can be the team lead' });
  });

  it('lists presets on GET /api/openchamber/team-presets', async () => {
    const app = makeApp();
    registerTeamRoutes(app, { teamService: makeService(), teamPresets: makePresets() });

    const res = makeRes();
    await findRoute(app, 'GET', '/api/openchamber/team-presets').handler({}, res);
    expect(res.body.presets).toEqual([{ id: 'builtin-duo', name: 'Дуэт', builtIn: true }]);
  });

  it('saves a preset on POST, turning a validation failure into 400', async () => {
    const app = makeApp();
    registerTeamRoutes(app, { teamService: makeService(), teamPresets: makePresets() });

    const res = makeRes();
    await findRoute(app, 'POST', '/api/openchamber/team-presets').handler({ body: { name: 'Моя' } }, res);
    expect(res.body.preset.name).toBe('Моя');

    const failing = makePresets({ upsert: async () => { throw new Error('preset name is required'); } });
    const app2 = makeApp();
    registerTeamRoutes(app2, { teamService: makeService(), teamPresets: failing });
    const res2 = makeRes();
    await findRoute(app2, 'POST', '/api/openchamber/team-presets').handler({ body: {} }, res2);
    expect(res2.statusCode).toBe(400);
  });

  it('deletes a preset and answers 404 for an unknown id', async () => {
    const app = makeApp();
    registerTeamRoutes(app, { teamService: makeService(), teamPresets: makePresets({ remove: async (id) => id !== 'gone' }) });

    const res = makeRes();
    await findRoute(app, 'DELETE', '/api/openchamber/team-presets/:id').handler({ params: { id: 'preset_1' } }, res);
    expect(res.body).toEqual({ removed: true });

    const res404 = makeRes();
    await findRoute(app, 'DELETE', '/api/openchamber/team-presets/:id').handler({ params: { id: 'gone' } }, res404);
    expect(res404.statusCode).toBe(404);
  });

  it('refuses to delete a built-in preset with 400', async () => {
    const app = makeApp();
    const store = makePresets({
      remove: async () => { throw new Error('a built-in preset cannot be deleted'); },
    });
    registerTeamRoutes(app, { teamService: makeService(), teamPresets: store });

    const res = makeRes();
    await findRoute(app, 'DELETE', '/api/openchamber/team-presets/:id').handler({ params: { id: 'builtin-duo' } }, res);
    expect(res.statusCode).toBe(400);
  });

  it('refuses to register without a team service or preset store', () => {
    expect(() => registerTeamRoutes(makeApp(), { teamPresets: makePresets() })).toThrow(/team service/);
    expect(() => registerTeamRoutes(makeApp(), { teamService: makeService() })).toThrow(/preset store/);
  });
});
