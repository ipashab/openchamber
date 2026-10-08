import { describe, expect, it, vi } from 'vitest';
import express from 'express';

import { registerMissionsRoutes } from './routes.js';

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

describe('registerMissionsRoutes', () => {
  it('registers the six mission resources', () => {
    const app = makeApp();
    registerMissionsRoutes(app, { missionsService: {} });
    const paths = [...app.routes.keys()].sort();
    expect(paths).toEqual([
      'DELETE /api/openchamber/missions/:missionId',
      'GET /api/openchamber/missions',
      'POST /api/openchamber/missions',
      'POST /api/openchamber/missions/:missionId/cancel',
      'POST /api/openchamber/missions/:missionId/retry',
      'PUT /api/openchamber/missions/config',
    ]);
  });

  it('requires a missions service', () => {
    expect(() => registerMissionsRoutes(makeApp(), {})).toThrow('missions service');
  });

  it('serves the list with the queue config and passes write failures through with their status', async () => {
    const app = makeApp();
    const missionsService = {
      listMissions: vi.fn(async () => [{ missionId: 'mission_1', status: 'running' }]),
      getMissionConfig: vi.fn(async () => ({ maxConcurrent: 2, maxRunMs: 3_600_000 })),
      updateMissionConfig: vi.fn(async (input) => ({ config: { maxConcurrent: 2, maxRunMs: 3_600_000, ...input } })),
      createMission: vi.fn(async (input) => ({ mission: { missionId: 'mission_2', status: 'queued', ...input } })),
      cancelMission: vi.fn(async () => { throw Object.assign(new Error('A completed mission cannot be cancelled'), { statusCode: 400 }); }),
    };
    registerMissionsRoutes(app, { missionsService });

    const list = makeRes();
    await findRoute(app, 'GET', '/api/openchamber/missions').handler(undefined, list);
    expect(list.statusCode).toBeNull();
    expect(list.body.missions[0].missionId).toBe('mission_1');
    expect(list.body.config).toEqual({ maxConcurrent: 2, maxRunMs: 3_600_000 });

    const savedConfig = makeRes();
    await findRoute(app, 'PUT', '/api/openchamber/missions/config').handler({ body: { maxConcurrent: 6 } }, savedConfig);
    expect(savedConfig.statusCode).toBeNull();
    expect(savedConfig.body.config).toEqual({ maxConcurrent: 6, maxRunMs: 3_600_000 });

    const badConfig = makeRes();
    const rangeError = Object.assign(new Error('maxConcurrent must be a whole number between 1 and 16'), { statusCode: 400 });
    missionsService.updateMissionConfig.mockImplementation(async () => { throw rangeError; });
    await findRoute(app, 'PUT', '/api/openchamber/missions/config').handler({ body: { maxConcurrent: 0 } }, badConfig);
    expect(badConfig.statusCode).toBe(400);
    expect(badConfig.body.error).toContain('whole number');

    const created = makeRes();
    await findRoute(app, 'POST', '/api/openchamber/missions').handler({ body: { title: 'T', prompt: 'P', directory: '/d' } }, created);
    expect(created.statusCode).toBeNull();
    expect(created.body.mission.status).toBe('queued');

    const cancelled = makeRes();
    await findRoute(app, 'POST', '/api/openchamber/missions/:missionId/cancel')
      .handler({ params: { missionId: 'mission_1' }, body: {} }, cancelled);
    expect(cancelled.statusCode).toBe(400);
    expect(cancelled.body.error).toContain('cannot be cancelled');
  });

  it('answers 500 with the server error logged, not leaked raw', async () => {
    const app = makeApp();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const missionsService = {
      listMissions: vi.fn(async () => { throw new Error('disk is on fire'); }),
    };
    registerMissionsRoutes(app, { missionsService });
    const res = makeRes();
    await findRoute(app, 'GET', '/api/openchamber/missions').handler(undefined, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('Failed to load missions');
    errorSpy.mockRestore();
  });
});
