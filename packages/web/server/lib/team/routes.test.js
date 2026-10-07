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

const makeService = ({ overview = [], createFromUi, readActivity } = {}) => ({
  overview: vi.fn(async () => overview),
  ...(createFromUi ? { createFromUi: vi.fn(createFromUi) } : { createFromUi: vi.fn(async () => ({ team: {}, leadSessionId: 'ses_1', members: [] })) }),
  ...(readActivity ? { readActivity: vi.fn(readActivity) } : { readActivity: vi.fn(async () => ({ teamId: 'team_1', events: [], nextCursor: null })) }),
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

  it('adds a member to a live team on POST /api/openchamber/teams/:teamId/members', async () => {
    const app = makeApp();
    const service = makeService();
    service.addMemberFromUi = vi.fn(async ({ teamId, input }) => {
      expect(teamId).toBe('team_1');
      expect(input.name).toBe('Новый');
      expect(input.domain).toBe('qa');
      return { member: { slotId: 'member_1', name: 'Новый', status: 'starting' } };
    });
    registerTeamRoutes(app, { teamService: service, teamPresets: makePresets() });

    const res = makeRes();
    await findRoute(app, 'POST', '/api/openchamber/teams/:teamId/members')
      .handler({ params: { teamId: 'team_1' }, body: { name: 'Новый', domain: 'qa' } }, res);
    expect(res.statusCode).toBe(201);
    expect(res.body.member.slotId).toBe('member_1');
    expect(service.addMemberFromUi).toHaveBeenCalledTimes(1);
  });

  it('creates a task on POST /api/openchamber/teams/:teamId/tasks and forwards the result', async () => {
    const app = makeApp();
    const service = makeService();
    service.createTaskFromUi = vi.fn(async ({ teamId, input }) => {
      expect(teamId).toBe('team_1');
      expect(input.subject).toBe('Проверить сборку');
      return { task: { taskId: 'task_7', subject: 'Проверить сборку', status: 'pending', owner: null } };
    });
    registerTeamRoutes(app, { teamService: service, teamPresets: makePresets() });

    const res = makeRes();
    await findRoute(app, 'POST', '/api/openchamber/teams/:teamId/tasks')
      .handler({ params: { teamId: 'team_1' }, body: { subject: 'Проверить сборку' } }, res);
    expect(res.statusCode).toBe(201);
    expect(res.body.task.taskId).toBe('task_7');
    expect(service.createTaskFromUi).toHaveBeenCalledTimes(1);
  });

  it('passes a validation failure through as 400 on task creation', async () => {
    const app = makeApp();
    const service = makeService();
    const invalid = new Error('subject is required: what the task asks for');
    invalid.statusCode = 400;
    service.createTaskFromUi = vi.fn(async () => { throw invalid; });
    registerTeamRoutes(app, { teamService: service, teamPresets: makePresets() });

    const res = makeRes();
    await findRoute(app, 'POST', '/api/openchamber/teams/:teamId/tasks')
      .handler({ params: { teamId: 'team_1' }, body: {} }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('subject is required');
  });

  it('forwards TeamError status codes from member mutations and shutdown requests', async () => {
    const app = makeApp();
    const service = makeService();
    const conflict = new Error('A teammate named ’Новый’ already exists in this team');
    conflict.statusCode = 409;
    service.addMemberFromUi = vi.fn(async () => { throw conflict; });
    service.shutdownMemberFromUi = vi.fn(async () => {
      const missing = new Error("No active member with slotId 'member_x'");
      missing.statusCode = 404;
      throw missing;
    });
    registerTeamRoutes(app, { teamService: service, teamPresets: makePresets() });

    const addRes = makeRes();
    await findRoute(app, 'POST', '/api/openchamber/teams/:teamId/members')
      .handler({ params: { teamId: 'team_1' }, body: { name: 'Новый' } }, addRes);
    expect(addRes.statusCode).toBe(409);
    expect(addRes.body.error).toContain('already exists');

    const shutdownRes = makeRes();
    await findRoute(app, 'POST', '/api/openchamber/teams/:teamId/members/:slotId/shutdown')
      .handler({ params: { teamId: 'team_1', slotId: 'member_x' }, body: { reason: 'не нужен' } }, shutdownRes);
    expect(shutdownRes.statusCode).toBe(404);
    expect(service.shutdownMemberFromUi).toHaveBeenCalledWith({
      teamId: 'team_1',
      slotId: 'member_x',
      reason: 'не нужен',
    });
  });

  it('requests a member shutdown through the approval handshake', async () => {
    const app = makeApp();
    const service = makeService();
    service.shutdownMemberFromUi = vi.fn(async () => ({ requested: true }));
    registerTeamRoutes(app, { teamService: service, teamPresets: makePresets() });

    const res = makeRes();
    await findRoute(app, 'POST', '/api/openchamber/teams/:teamId/members/:slotId/shutdown')
      .handler({ params: { teamId: 'team_1', slotId: 'member_1' }, body: {} }, res);
    expect(res.statusCode).toBeNull();
    expect(res.body).toEqual({ requested: true });
  });

  it('serves the roster as a preset recipe on GET /api/openchamber/teams/:teamId/preset', async () => {
    const app = makeApp();
    const service = makeService();
    service.exportPresetFromUi = vi.fn(async ({ teamId }) => {
      expect(teamId).toBe('team_1');
      return { preset: { id: 'preset_x', name: 'Crew', members: [{ name: 'Team Lead', isLead: true }] } };
    });
    registerTeamRoutes(app, { teamService: service, teamPresets: makePresets() });

    const res = makeRes();
    await findRoute(app, 'GET', '/api/openchamber/teams/:teamId/preset')
      .handler({ params: { teamId: 'team_1' } }, res);
    expect(res.statusCode).toBeNull();
    expect(res.body.preset.name).toBe('Crew');

    const missing = new Error("No team with id 'team_missing'");
    missing.statusCode = 404;
    service.exportPresetFromUi = vi.fn(async () => { throw missing; });
    const res404 = makeRes();
    await findRoute(app, 'GET', '/api/openchamber/teams/:teamId/preset')
      .handler({ params: { teamId: 'team_missing' } }, res404);
    expect(res404.statusCode).toBe(404);
    expect(res404.body.error).toContain('No team with id');
  });

  it('serves a page of the activity feed on GET /api/openchamber/teams/:teamId/activity', async () => {
    const app = makeApp();
    const service = makeService();
    service.readActivity = vi.fn(async ({ teamId, before, limit }) => {
      expect(teamId).toBe('team_1');
      expect(before).toBe('100:m_9');
      expect(limit).toBe('25');
      return { teamId, events: [{ kind: 'message', id: 'm_9', at: 100, from: 'lead', to: 'a', type: 'report', content: 'done', summary: null, read: true }], nextCursor: null };
    });
    registerTeamRoutes(app, { teamService: service, teamPresets: makePresets() });

    const res = makeRes();
    await findRoute(app, 'GET', '/api/openchamber/teams/:teamId/activity')
      .handler({ params: { teamId: 'team_1' }, query: { before: '100:m_9', limit: '25' } }, res);
    expect(res.statusCode).toBeNull();
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].kind).toBe('message');
  });

  it('omits the cursor and limit when the query is empty, and passes a TeamError status through', async () => {
    const app = makeApp();
    const service = makeService();
    service.readActivity = vi.fn(async ({ before, limit }) => {
      expect(before).toBeUndefined();
      expect(limit).toBeUndefined();
      return { teamId: 'team_1', events: [], nextCursor: null };
    });
    registerTeamRoutes(app, { teamService: service, teamPresets: makePresets() });

    const res = makeRes();
    await findRoute(app, 'GET', '/api/openchamber/teams/:teamId/activity')
      .handler({ params: { teamId: 'team_1' } }, res);
    expect(res.statusCode).toBeNull();
    expect(res.body.events).toEqual([]);

    const invalid = Object.assign(new Error('Invalid activity cursor'), { statusCode: 400 });
    service.readActivity = vi.fn(async () => { throw invalid; });
    const res400 = makeRes();
    await findRoute(app, 'GET', '/api/openchamber/teams/:teamId/activity')
      .handler({ params: { teamId: 'team_1' }, query: { before: 'not-a-cursor' } }, res400);
    expect(res400.statusCode).toBe(400);
    expect(res400.body.error).toBe('Invalid activity cursor');
  });
});
