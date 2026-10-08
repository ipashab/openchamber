import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMissionsService } from './service.js';

const makeFs = () => {
  const files = new Map();
  return {
    files,
    promises: {
      mkdir: vi.fn(async () => {}),
      readFile: vi.fn(async (filePath) => {
        if (!files.has(filePath)) {
          const error = new Error('not found');
          error.code = 'ENOENT';
          throw error;
        }
        return files.get(filePath);
      }),
      writeFile: vi.fn(async (filePath, payload) => {
        files.set(filePath, payload);
      }),
      rename: vi.fn(async (from, to) => {
        files.set(to, files.get(from));
        files.delete(from);
      }),
    },
  };
};

const flushAsync = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const PATH = { join: (...parts) => parts.join('/'), dirname: (value) => value.split('/').slice(0, -1).join('/') };

const makeService = ({ maxConcurrent = 2, maxRunMs = 60 * 60 * 1000, sessionState, spawnFails = false } = {}) => {
  const fs = makeFs();
  const events = [];
  const sent = [];
  const teamsCreated = [];
  const sessionsCreated = [];
  const probe = sessionState ?? new Map();
  let sessionCounter = 0;
  const createOpenCodeClient = () => ({
    session: {
      create: vi.fn(async (input) => {
        if (spawnFails) throw new Error('provider refused');
        sessionCounter += 1;
        const record = { id: `ses_${sessionCounter}`, input };
        sessionsCreated.push(record);
        return { id: record.id };
      }),
    },
  });
  const teamService = {
    createFromUi: vi.fn(async (input) => {
      teamsCreated.push(input);
      if (spawnFails) throw new Error('no catalog');
      sessionCounter += 1;
      return { team: { id: 'team_1', name: input.name }, leadSessionId: `ses_${sessionCounter}` };
    }),
  };
  const service = createMissionsService({
    fsPromises: fs.promises,
    path: PATH,
    dataDir: '/data',
    buildOpenCodeUrl: (suffix) => `http://opencode${suffix}`,
    getOpenCodeAuthHeaders: () => ({}),
    waitForOpenCodeReady: async () => {},
    createOpenCodeClient,
    sessionService: { send: vi.fn(async (sessionId, payload) => { sent.push({ sessionId, payload }); }) },
    teamService,
    getSessionState: (sessionId) => probe.get(sessionId) ?? null,
    broadcastUiEvent: (event) => events.push(event),
    maxConcurrent,
    maxRunMs,
  });
  return { service, fs, events, sent, teamsCreated, sessionsCreated, probe };
};

const input = {
  title: 'Ship the checklist',
  prompt: 'Walk every step and write doc/deploy.md',
  mode: 'session',
  directory: '/projects/app',
};

describe('createMissionsService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('files a mission and dispatches it into a fresh session', async () => {
    const { service, events, sessionsCreated, sent } = makeService();
    const { mission } = await service.createMission(input);
    await flushAsync();

    expect(mission.status).toBe('running');
    expect(sessionsCreated).toHaveLength(1);
    expect(sessionsCreated[0].input.title).toBe('Ship the checklist');
    expect(sessionsCreated[0].input.location).toEqual({ directory: '/projects/app' });
    expect(sessionsCreated[0].input.metadata).toEqual({ openchamber: { mission: { id: mission.missionId, version: 1 } } });
    expect(sent).toHaveLength(1);
    expect(sent[0].sessionId).toBe(sessionsCreated[0].id);
    expect(sent[0].payload.prompt).toBe(input.prompt);
    expect(sent[0].payload.directory).toBe('/projects/app');
    expect(events.map((event) => event.properties.change)).toEqual(['created', 'updated', 'updated']);
  });

  it('rejects malformed input with the reasons the form shows', async () => {
    const { service } = makeService();
    await expect(service.createMission({ prompt: '' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.createMission({ ...input, mode: 'swarm' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.createMission({ ...input, directory: '' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.createMission({ ...input, model: 'not-a-path' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('passes the agent and model the form picked to the session and dispatch', async () => {
    const { service, sessionsCreated, sent } = makeService();
    await service.createMission({ ...input, agent: 'build', model: 'anthropic/claude-sonnet-4-5' });
    await flushAsync();

    expect(sessionsCreated[0].input.agent).toBe('build');
    expect(sessionsCreated[0].input.model).toEqual({ id: 'claude-sonnet-4-5', providerID: 'anthropic' });
    expect(sent[0].payload.agent).toBe('build');
    expect(sent[0].payload.model).toBe('anthropic/claude-sonnet-4-5');
  });

  it('paces the queue: only maxConcurrent missions run, a settled one admits the next', async () => {
    const { service, probe, sessionsCreated } = makeService({ maxConcurrent: 2 });
    await service.createMission(input);
    await service.createMission({ ...input, title: 'Second' });
    await service.createMission({ ...input, title: 'Third' });
    await flushAsync();

    expect(sessionsCreated).toHaveLength(2);
    const list = await service.listMissions();
    expect(list.filter((mission) => mission.status === 'running')).toHaveLength(2);
    expect(list.find((mission) => mission.title === 'Third').status).toBe('queued');

    // The turn of the first mission: busy, then idle — completing it admits
    // the queued one.
    const first = list.find((mission) => mission.title === 'Third');
    expect(first.status).toBe('queued');
    const running = list.filter((mission) => mission.status === 'running').sort((a, b) => b.createdAt - a.createdAt);
    probe.set(running[0].sessionId, { status: 'busy' });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(running[0] && (await service.listMissions()).find((m) => m.missionId === running[0].missionId).status).toBe('running');
    probe.set(running[0].sessionId, { status: 'idle' });
    await vi.advanceTimersByTimeAsync(6_000);

    const after = await service.listMissions();
    expect(after.find((mission) => mission.missionId === running[0].missionId).status).toBe('completed');
    expect(after.find((mission) => mission.title === 'Third').status).toBe('running');
  });

  it('completes only after the turn it started went busy', async () => {
    const { service, probe } = makeService();
    const { mission } = await service.createMission(input);
    await flushAsync();
    const sessionId = (await service.listMissions())[0].sessionId;
    expect(sessionId).toBeTruthy();

    // Idle before busy is waiting, not finishing.
    probe.set(sessionId, { status: 'idle' });
    await vi.advanceTimersByTimeAsync(12_000);
    expect((await service.listMissions())[0].status).toBe('running');

    probe.set(sessionId, { status: 'busy' });
    await vi.advanceTimersByTimeAsync(6_000);
    probe.set(sessionId, { status: 'idle' });
    await vi.advanceTimersByTimeAsync(6_000);
    const done = (await service.listMissions())[0];
    expect(done.status).toBe('completed');
    expect(done.finishedAt).toBeGreaterThan(0);
  });

  it('fails a mission whose turn never reported busy within the watch window', async () => {
    const { service, probe } = makeService({ maxRunMs: 1000 });
    await service.createMission(input);
    await flushAsync();
    const busySession = (await service.listMissions())[0].sessionId;

    probe.set(busySession, { status: 'busy' });
    await vi.advanceTimersByTimeAsync(1_100);
    const list = await service.listMissions();
    expect(list[0].status).toBe('completed');

    const silent = makeService({ maxRunMs: 1000 });
    await silent.service.createMission(input);
    await flushAsync();
    const silentSession = (await silent.service.listMissions())[0].sessionId;
    silent.probe.set(silentSession, { status: 'idle' });
    await vi.advanceTimersByTimeAsync(1_200);
    const finished = await silent.service.listMissions();
    expect(finished[0].status).toBe('failed');
    expect(finished[0].error).toContain('never reported');
  });

  it('runs a team mission as a lead-led team whose first task is the prompt', async () => {
    const { service, teamsCreated } = makeService();
    await service.createMission({ ...input, mode: 'team' });
    await flushAsync();

    expect(teamsCreated).toHaveLength(1);
    expect(teamsCreated[0].name).toBe('Ship the checklist');
    expect(teamsCreated[0].task).toBe(input.prompt);
    expect(teamsCreated[0].members).toEqual([{ name: 'Lead', isLead: true }]);
    const list = await service.listMissions();
    expect(list[0].status).toBe('running');
    expect(list[0].teamId).toBe('team_1');
    expect(list[0].sessionId).toBeTruthy();
  });

  it('marks a spawn failure on the mission and keeps the queue moving', async () => {
    const { service, sent } = makeService({ spawnFails: true });
    await service.createMission(input);
    await service.createMission({ ...input, title: 'Second' });
    await flushAsync();

    const list = await service.listMissions();
    expect(list[0].status).toBe('failed');
    expect(list[0].error).toBeTruthy();
    expect(list[1].status).toBe('failed');
    expect(sent).toHaveLength(0);
  });

  it('answers 404 and 400 where the API contract says so', async () => {
    const { service } = makeService();
    await expect(service.cancelMission('mission_none')).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.deleteMission('mission_none')).rejects.toMatchObject({ statusCode: 404 });

    const { mission } = await service.createMission(input);
    await flushAsync();
    await expect(service.retryMission(mission.missionId)).rejects.toMatchObject({ statusCode: 400 });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 10_000);
    const list = await service.listMissions();
    expect(['completed', 'failed']).toContain(list[0].status);
  });

  it('cancels a queued mission and stops watching a running one', async () => {
    const { service, probe } = makeService({ maxConcurrent: 1 });
    await service.createMission(input);
    const queued = await service.createMission({ ...input, title: 'Second' });
    await flushAsync();

    // The queue holds the second mission back; cancelling it while queued is
    // the plain case.
    const cancelled = await service.cancelMission(queued.mission.missionId);
    expect(cancelled.mission.status).toBe('cancelled');

    const runningList = await service.listMissions();
    const running = runningList.find((mission) => mission.status === 'running');
    await expect(service.cancelMission(running.missionId)).resolves.toMatchObject({ mission: { status: 'cancelled' } });
    // The cancelled mission no longer reacts to its session's state.
    probe.set(running.sessionId, { status: 'idle' });
    await vi.advanceTimersByTimeAsync(10 * 6_000);
    const settledList = await service.listMissions();
    expect(settledList.find((mission) => mission.missionId === running.missionId).status).toBe('cancelled');
  });

  it('requeues a finished mission as a fresh run of the same goal', async () => {
    const { service, probe, sessionsCreated } = makeService();
    const { mission } = await service.createMission(input);
    await flushAsync();
    const firstSession = (await service.listMissions())[0].sessionId;
    probe.set(firstSession, { status: 'busy' });
    await vi.advanceTimersByTimeAsync(6_000);
    probe.set(firstSession, { status: 'idle' });
    await vi.advanceTimersByTimeAsync(6_000);
    expect((await service.listMissions())[0].status).toBe('completed');

    const retried = await service.retryMission(mission.missionId);
    // The retry requeued and the free slot picked it up in the same breath.
    expect(retried.mission.status).toBe('running');
    await flushAsync();
    expect(sessionsCreated).toHaveLength(2);
    expect((await service.listMissions())[0].status).toBe('running');
  });

  it('deletes the record and forgets the goal', async () => {
    const { service } = makeService();
    const { mission } = await service.createMission(input);
    await flushAsync();
    await service.deleteMission(mission.missionId);
    expect(await service.listMissions()).toHaveLength(0);
  });

  it('reads the queue config and updates it with bounds-checked values', async () => {
    const { service } = makeService({ maxConcurrent: 1, maxRunMs: 30 * 60 * 1000 });
    expect(await service.getMissionConfig()).toEqual({ maxConcurrent: 1, maxRunMs: 30 * 60 * 1000 });

    const updated = await service.updateMissionConfig({ maxConcurrent: 4, maxRunMs: 5 * 60 * 1000 });
    expect(updated.config).toEqual({ maxConcurrent: 4, maxRunMs: 5 * 60 * 1000 });
    expect(await service.getMissionConfig()).toEqual({ maxConcurrent: 4, maxRunMs: 5 * 60 * 1000 });

    // One field at a time: the other keeps its value.
    const partial = await service.updateMissionConfig({ maxRunMs: 2 * 60 * 60 * 1000 });
    expect(partial.config.maxConcurrent).toBe(4);

    await expect(service.updateMissionConfig({ maxConcurrent: 0 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.updateMissionConfig({ maxConcurrent: 17 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.updateMissionConfig({ maxRunMs: 30 * 1000 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.updateMissionConfig({})).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.updateMissionConfig({ maxConcurrent: 'two' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('a raised lane count starts queued missions on the same pass', async () => {
    const { service, sessionsCreated } = makeService({ maxConcurrent: 1 });
    await service.createMission(input);
    await service.createMission({ ...input, title: 'Second' });
    await service.createMission({ ...input, title: 'Third' });
    await flushAsync();
    expect(sessionsCreated).toHaveLength(1);

    await service.updateMissionConfig({ maxConcurrent: 3 });
    await flushAsync();
    const list = await service.listMissions();
    expect(list.filter((mission) => mission.status === 'running')).toHaveLength(3);

    // A lowered limit stops admissions; running missions are not cancelled.
    await service.updateMissionConfig({ maxConcurrent: 1 });
    await flushAsync();
    expect(list.filter((mission) => mission.status === 'running')).toHaveLength(3);
    const fourth = await service.createMission({ ...input, title: 'Fourth' });
    await flushAsync();
    expect(fourth.mission.status).toBe('queued');
  });

  it('persists the queue config beside the missions and restores it', async () => {
    const base = makeService({ maxConcurrent: 2 });
    await base.service.createMission(input);
    await base.service.updateMissionConfig({ maxConcurrent: 6, maxRunMs: 90 * 60 * 1000 });
    await vi.advanceTimersByTimeAsync(700);
    const raw = JSON.parse(base.fs.files.get('/data/missions.json'));
    expect(raw.config).toEqual({ maxConcurrent: 6, maxRunMs: 90 * 60 * 1000 });

    const revived = createMissionsService({
      fsPromises: base.fs.promises,
      path: PATH,
      dataDir: '/data',
      buildOpenCodeUrl: (suffix) => `http://opencode${suffix}`,
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => {},
      createOpenCodeClient: () => ({ session: { create: vi.fn(async () => ({ id: 'ses_new' })) } }),
      sessionService: { send: vi.fn(async () => {}) },
      teamService: { createFromUi: vi.fn(async () => ({ team: { id: 'team_2' }, leadSessionId: 'ses_new2' })) },
      getSessionState: () => null,
      broadcastUiEvent: () => {},
    });
    await revived.init();
    expect(await revived.getMissionConfig()).toEqual({ maxConcurrent: 6, maxRunMs: 90 * 60 * 1000 });

    // A config from an older or corrupt file falls back to the bounds-safe
    // defaults rather than refusing to boot.
    base.fs.files.set('/data/missions.json', JSON.stringify({ missions: [], config: { maxConcurrent: 'many' } }));
    const tolerant = createMissionsService({
      fsPromises: base.fs.promises,
      path: PATH,
      dataDir: '/data',
      buildOpenCodeUrl: (suffix) => `http://opencode${suffix}`,
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => {},
      createOpenCodeClient: () => ({ session: { create: vi.fn(async () => ({ id: 'ses_new' })) } }),
      sessionService: { send: vi.fn(async () => {}) },
      teamService: { createFromUi: vi.fn(async () => ({ team: { id: 'team_2' }, leadSessionId: 'ses_new2' })) },
      getSessionState: () => null,
      broadcastUiEvent: () => {},
    });
    await tolerant.init();
    expect((await tolerant.getMissionConfig()).maxConcurrent).toBe(2);
  });

  it('survives a restart: queued missions drain, running ones keep their watch', async () => {
    const base = makeService({ maxConcurrent: 1 });
    await base.service.createMission(input);
    const held = await base.service.createMission({ ...input, title: 'Second' });
    await flushAsync();
    // The second mission is queued; the first is running mid-turn.
    const beforeRestart = await base.service.listMissions();
    expect(beforeRestart.find((mission) => mission.missionId === held.mission.missionId).status).toBe('queued');

    await vi.advanceTimersByTimeAsync(700);
    const raw = JSON.parse(base.fs.files.get('/data/missions.json'));

    const revived = makeService({ maxConcurrent: 1, sessionState: base.probe });
    // Instance the service directly over the same on-disk state.
    const second = createMissionsService({
      fsPromises: revived.fs.promises,
      path: PATH,
      dataDir: '/data',
      buildOpenCodeUrl: (suffix) => `http://opencode${suffix}`,
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => {},
      createOpenCodeClient: () => ({ session: { create: vi.fn(async () => ({ id: 'ses_new' })) } }),
      sessionService: { send: vi.fn(async () => {}) },
      teamService: { createFromUi: vi.fn(async () => ({ team: { id: 'team_2' }, leadSessionId: 'ses_new2' })) },
      getSessionState: (sessionId) => base.probe.get(sessionId) ?? null,
      broadcastUiEvent: (event) => revived.events.push(event),
      maxConcurrent: 1,
    });
    revived.fs.files.set('/data/missions.json', JSON.stringify(raw));
    await second.init();
    await flushAsync();

    const list = await second.listMissions();
    // The queued mission resumed after restart; the running one is still running.
    const resumed = list.find((mission) => mission.title === 'Second');
    const carrier = list.find((mission) => mission.title !== 'Second');
    expect(resumed.status).toBe('running');
    expect(carrier.status).toBe('running');

    // The pre-restart mission finishes through the resumed watch.
    base.probe.set(carrier.sessionId, { status: 'busy' });
    await vi.advanceTimersByTimeAsync(6_000);
    base.probe.set(carrier.sessionId, { status: 'idle' });
    await vi.advanceTimersByTimeAsync(6_000);
    expect((await second.listMissions()).find((mission) => mission.missionId === carrier.missionId).status).toBe('completed');
  });
});
