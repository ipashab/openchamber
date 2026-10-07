import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createTeamService } from './service.js';

const temporaryDirectories = [];
const services = [];

afterEach(async () => {
  services.splice(0);
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const makeService = async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-team-'));
  temporaryDirectories.push(dataDir);

  const sent = [];
  const broadcasts = [];
  const openCodeState = {
    interrupts: 0,
    parentID: null,
    creates: [],
    sessions: {
      ses_lead: { id: 'ses_lead', title: 'Main', directory: '/work/project' },
    },
  };

  const createOpenCodeClient = () => ({
    session: {
      get: async ({ sessionID }) => {
        const session = openCodeState.sessions[sessionID];
        if (!session) throw new Error('session not found');
        return session;
      },
      create: async (input) => {
        const { parentID, title, location, metadata } = input;
        const id = `ses_${Math.random().toString(36).slice(2, 10)}`;
        openCodeState.creates.push(input);
        openCodeState.sessions[id] = { id, title, directory: location.directory, parentID, metadata };
        openCodeState.parentID = parentID;
        return openCodeState.sessions[id];
      },
      interrupt: async () => {
        openCodeState.interrupts += 1;
        return { interrupted: true };
      },
      update: async () => {},
    },
    agent: {
      list: async () => ({
        data: [
          { id: 'build', name: 'Build', mode: 'primary', description: 'builds' },
          { id: 'plan', name: 'Plan', mode: 'subagent', description: 'plans' },
          { id: 'ghost', name: 'Ghost', mode: 'primary', hidden: true },
        ],
      }),
    },
    model: {
      list: async () => ({ data: [{ providerID: 'prov', modelID: 'alpha' }] }),
    },
    mcp: {
      list: async () => ({ data: [{ name: 'docs' }, { name: 'tracker' }] }),
    },
  });

  const service = createTeamService({
    fsPromises: fs,
    path,
    dataDir,
    buildOpenCodeUrl: () => 'http://127.0.0.1:1/api',
    getOpenCodeAuthHeaders: () => ({}),
    waitForOpenCodeReady: async () => {},
    createOpenCodeClient,
    sessionService: {
      send: async (sessionID, payload) => {
        sent.push({ sessionID, payload });
      },
    },
    broadcastUiEvent: (event) => broadcasts.push(event),
  });
  await service.init();
  services.push(service);
  return { service, sent, broadcasts, openCodeState, dataDir };
};

/**
 * Start → spawn two teammates → end every briefing turn, so each test wakes
 * an idle member the way the orchestrator leaves it in production.
 */
const makeTeam = async (service, { teammates = ['Alice', 'Bob'] } = {}) => {
  await service.executeAction('team.start', { name: 'Crew' }, 'ses_lead');
  for (const name of teammates) {
    await service.executeAction('team.spawn_agent', { name, agent: 'build' }, 'ses_lead');
  }
  const [team] = await service.snapshot();
  const roster = team.members.filter((member) => member.slotId !== 'lead');
  for (const member of roster) {
    await service.processPayload(idleEvent(member.sessionId));
  }
  return { teamId: team.id, roster };
};

const idleEvent = (sessionID, extra = {}) => ({
  type: 'session.idle',
  properties: { sessionID, ...extra },
});

describe('team service', () => {
  it('rejects team actions from a session outside any team', async () => {
    const { service } = await makeService();
    await expect(service.executeAction('team.members', {}, 'ses_lead'))
      .rejects.toMatchObject({ message: expect.stringContaining('not part of a team') });
  });

  it('starts a team and returns the lead briefing', async () => {
    const { service } = await makeService();
    const result = await service.executeAction('team.start', { name: 'Crew' }, 'ses_lead');
    expect(result.team.name).toBe('Crew');
    expect(result.team.directory).toBe('/work/project');
    expect(result.briefing).toContain('You are the Team Lead');
    expect(result.briefing).toContain('slot_id: lead');
  });

  it('refuses a second team for the same session', async () => {
    const { service } = await makeService();
    await service.executeAction('team.start', { name: 'One' }, 'ses_lead');
    await expect(service.executeAction('team.start', { name: 'Two' }, 'ses_lead'))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('spawns a teammate as a child of the lead with its briefing dispatched', async () => {
    const { service, sent, openCodeState } = await makeService();
    await service.executeAction('team.start', { name: 'Crew' }, 'ses_lead');
    const spawned = await service.executeAction('team.spawn_agent', { name: 'Alice', agent: 'build' }, 'ses_lead');

    expect(spawned.member.status).toBe('busy');
    expect(openCodeState.parentID).toBe('ses_lead');
    const briefing = sent.find((entry) => entry.sessionID === spawned.member.sessionId)
      ?? sent.find((entry) => entry.payload.prompt.includes('You are a Team Member'));
    expect(briefing.payload.prompt).toContain('You are a Team Member');
    expect(briefing.payload.prompt).toContain('Alice');
    expect(briefing.payload.prompt).toContain('slot_id: lead');
    expect(briefing.payload.agent).toBe('build');

    const [team] = await service.snapshot();
    const member = team.members.find((entry) => entry.slotId === spawned.member.slotId);
    expect(member.role).toBe('teammate');
    expect(member.status).toBe('busy');
  });

  it('hides subagents and hidden agents from the spawnable catalog', async () => {
    const { service } = await makeService();
    await service.executeAction('team.start', { name: 'Crew' }, 'ses_lead');
    const { assistants } = await service.executeAction('team.list_assistants', {}, 'ses_lead');
    expect(assistants.map((assistant) => assistant.id)).toEqual(['build']);
  });

  it('enforces lead-only actions per call', async () => {
    const { service } = await makeService();
    const { roster } = await makeTeam(service);
    const alice = roster[0];

    await expect(
      service.executeAction('team.spawn_agent', { name: 'Mallory', agent: 'build' }, alice.sessionId),
    ).rejects.toMatchObject({ statusCode: 403 });

    const { members } = await service.executeAction('team.members', {}, 'ses_lead');
    expect(members.length).toBe(3);
  });

  it('delivers a message as a wake and keeps it unread until the turn succeeds', async () => {
    const { service, sent } = await makeService();
    const { roster } = await makeTeam(service);
    const alice = roster[0];

    await service.executeAction('team.send_message', { to: alice.slotId, message: 'Survey the codebase' }, 'ses_lead');
    const wake = sent.filter((entry) => entry.sessionID === alice.sessionId).at(-1);
    expect(wake.payload.prompt).toContain('Survey the codebase');
    expect(wake.payload.prompt).not.toContain('You are a Team Member');

    const mailbox = async () => (await service.snapshot())[0].mailbox;
    expect((await mailbox()).every((message) => message.read === false)).toBe(true);

    // Failed turn: the delivery claim is dropped, mail stays queued for retry.
    await service.processPayload(idleEvent(alice.sessionId, { aborted: true }));
    expect((await mailbox()).every((message) => message.read === false)).toBe(true);

    // A retry delivers the whole backlog; the successful turn marks it read.
    await service.executeAction('team.send_message', { to: alice.slotId, message: 'Try again' }, 'ses_lead');
    await service.processPayload(idleEvent(alice.sessionId));
    const settled = await mailbox();
    expect(settled.filter((message) => message.read === true).length).toBe(2);
    expect(settled.filter((message) => message.read !== true).length).toBe(0);
  });

  it('creates a task, assigns it and wakes the owner with its details', async () => {
    const { service, sent } = await makeService();
    const { roster } = await makeTeam(service);
    const alice = roster[0];

    const { task } = await service.executeAction('team.task_create', {
      subject: 'Map the modules',
      description: 'List every module',
      owner: alice.slotId,
    }, 'ses_lead');

    expect(task.owner).toBe(alice.slotId);
    const wake = sent.filter((entry) => entry.sessionID === alice.sessionId).at(-1);
    expect(wake.payload.prompt).toContain('Task assigned to you: Map the modules');
    expect(wake.payload.prompt).toContain('List every module');

    const updated = await service.executeAction('team.task_update', {
      taskId: task.taskId,
      status: 'completed',
    }, alice.sessionId);
    expect(updated.task.status).toBe('completed');
  });

  it('notifies the lead when a teammate finishes a turn with something for it', async () => {
    const { service, sent } = await makeService();
    const { roster } = await makeTeam(service);
    const alice = roster[0];

    await service.executeAction('team.send_message', { to: 'lead', message: 'Report: mapped modules' }, alice.sessionId);
    await service.processPayload(idleEvent(alice.sessionId));

    const leadWake = sent.filter((entry) => entry.sessionID === 'ses_lead').at(-1);
    expect(leadWake.payload.prompt).toContain('Report: mapped modules');
  });

  it('moves a failed teammate to failed and tells the lead', async () => {
    const { service, sent } = await makeService();
    const { roster } = await makeTeam(service);
    const alice = roster[0];

    await service.processPayload({
      type: 'session.error',
      properties: { sessionID: alice.sessionId, error: { message: 'boom' } },
    });

    const [team] = await service.snapshot();
    const member = team.members.find((entry) => entry.slotId === alice.slotId);
    expect(member.status).toBe('failed');
    const leadWake = sent.filter((entry) => entry.sessionID === 'ses_lead').at(-1);
    expect(leadWake.payload.prompt).toContain('failed');
  });

  it('retires a teammate on shutdown approval and keeps history readable', async () => {
    const { service } = await makeService();
    const { roster } = await makeTeam(service);
    const alice = roster[0];

    await service.executeAction('team.shutdown_agent', { slotId: alice.slotId, reason: 'done' }, 'ses_lead');
    // The approval line from the teammate retires the member.
    await service.executeAction('team.send_message', { to: 'lead', message: 'shutdown_approved' }, alice.sessionId);

    const [team] = await service.snapshot();
    const member = team.members.find((entry) => entry.slotId === alice.slotId);
    expect(member.removed).toBe(true);
    expect(member.status).toBe('shut_down');

    await expect(
      service.executeAction('team.members', {}, alice.sessionId),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('stacks a wake for a busy member and dispatches it on idle', async () => {
    const { service, sent } = await makeService();
    const { roster } = await makeTeam(service);
    const alice = roster[0];
    const briefings = sent.length;

    await service.executeAction('team.send_message', { to: alice.slotId, message: 'first' }, 'ses_lead');
    expect(sent.length).toBe(briefings + 1);
    // Alice is busy with the first wake; the second must stack, not send.
    await service.executeAction('team.send_message', { to: alice.slotId, message: 'second' }, 'ses_lead');
    expect(sent.length).toBe(briefings + 1);

    await service.processPayload(idleEvent(alice.sessionId));
    expect(sent.length).toBe(briefings + 2);
    const wake = sent.filter((entry) => entry.sessionID === alice.sessionId).at(-1);
    expect(wake.payload.prompt).toContain('second');
  });

  it('interrupts a busy teammate on demand', async () => {
    const { service, openCodeState } = await makeService();
    const { roster } = await makeTeam(service);
    const alice = roster[0];

    await service.executeAction('team.send_message', { to: alice.slotId, message: 'Investigate' }, 'ses_lead');
    const outcome = await service.executeAction('team.interrupt_agent', {
      slotId: alice.slotId,
      message: 'Change of plan',
    }, 'ses_lead');

    expect(outcome.interrupted).toBe(true);
    expect(openCodeState.interrupts).toBe(1);
    const [team] = await service.snapshot();
    const member = team.members.find((entry) => entry.slotId === alice.slotId);
    expect(member.status).toBe('busy');
  });

  it('broadcasts team events on the control stream', async () => {
    const { service, broadcasts } = await makeService();
    await service.executeAction('team.start', { name: 'Crew' }, 'ses_lead');
    expect(broadcasts.some((event) => event.type === 'openchamber:team-created')).toBe(true);

    await service.executeAction('team.spawn_agent', { name: 'Alice', agent: 'build' }, 'ses_lead');
    expect(broadcasts.some((event) => event.type === 'openchamber:team-members')).toBe(true);
  });

  it('renders the overview the panel reads: unread counts, clipped mail, no deleted tasks', async () => {
    const { service } = await makeService();
    const { roster } = await makeTeam(service, { teammates: ['Alice'] });
    const alice = roster[0];

    await service.executeAction('team.send_message', { to: alice.slotId, message: 'one' }, 'ses_lead');
    await service.executeAction('team.send_message', { to: 'lead', message: 'Report ready' }, alice.sessionId);
    const { task } = await service.executeAction('team.task_create', {
      subject: 'Map the modules',
      owner: alice.slotId,
    }, 'ses_lead');
    await service.executeAction('team.task_update', { taskId: task.taskId, status: 'deleted' }, 'ses_lead');

    const [overview] = await service.overview();
    const member = overview.members.find((entry) => entry.slotId === alice.slotId);
    // The 'one' message plus the task_assignment the lead's create pushed.
    expect(member.unreadCount).toBe(2);
    expect(member.sessionId).toBe(alice.sessionId);
    // Deleted tasks leave the board the panel renders; their history stays on disk.
    expect(overview.tasks).toEqual([]);
    expect(overview.recentMessages.length).toBeGreaterThan(0);
    const lead = overview.members.find((entry) => entry.slotId === 'lead');
    expect(lead.unreadCount).toBe(1);
  });

  it('survives a restart: members reload, busy falls back to idle, mail persists', async () => {
    const { service, dataDir } = await makeService();
    const { roster } = await makeTeam(service);
    // Wake Alice so one member is busy when the process restarts.
    await service.executeAction('team.send_message', { to: roster[0].slotId, message: 'hello' }, 'ses_lead');
    let [team] = await service.snapshot();
    expect(team.members.some((member) => member.status === 'busy')).toBe(true);
    await service.flush();

    const reloaded = createTeamService({
      fsPromises: fs,
      path,
      dataDir,
      buildOpenCodeUrl: () => 'http://127.0.0.1:1/api',
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => {},
      createOpenCodeClient: () => ({}),
      sessionService: { send: async () => {} },
      broadcastUiEvent: () => {},
    });
    await reloaded.init();
    services.push(reloaded);

    [team] = await reloaded.snapshot();
    expect(team.members.length).toBe(3);
    expect(team.members.filter((member) => member.status === 'busy')).toEqual([]);
    expect(team.mailbox.length).toBe(1);

    // The reloaded session index answers for persisted members.
    const { members } = await reloaded.executeAction('team.members', {}, roster[0].sessionId);
    expect(members.length).toBe(3);
  });
});

describe('readActivity', () => {
  it('merges mailbox and task streams newest-first with a page cursor', async () => {
    const { service } = await makeService();
    const { teamId, roster } = await makeTeam(service);
    // Distinct millisecond stamps keep the feed order (not the id tiebreak)
    // under test — the tiebreak's own guarantee is stability, not sequence.
    const tick = async () => new Promise((resolve) => setTimeout(resolve, 2));
    await service.executeAction('team.task_create', { subject: 'First' }, 'ses_lead');
    await tick();
    await service.executeAction('team.send_message', { to: roster[0].slotId, message: 'warm hello' }, 'ses_lead');
    await tick();
    await service.executeAction('team.task_create', { subject: 'Second', owner: roster[0].slotId }, 'ses_lead');

    const first = await service.readActivity({ teamId, limit: 2 });
    expect(first.events).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    // Newest first: the second task, then one of the same-second events.
    expect(first.events[0].kind).toBe('task');
    expect(first.events[0].subject).toBe('Second');
    // A same-second burst keeps a stable order through the id tiebreak, and
    // the next page starts strictly below the cursor's (at, id) pair.
    for (const event of first.events) {
      expect(event.at <= Number(first.nextCursor.split(':')[0])).toBe(true);
    }

    const second = await service.readActivity({ teamId, before: first.nextCursor, limit: 2 });
    expect(second.events.length).toBeGreaterThan(0);
    const idsSeen = new Set([...first.events, ...second.events].map((event) => event.id));
    expect(idsSeen.size).toBe(first.events.length + second.events.length);

    // The remainder drains: a page ends the walk with a null cursor, not a
    // page of echoes.
    expect(second.nextCursor).toBeNull();
  });

  it('returns full pages only while older retained events remain', async () => {
    const { service } = await makeService();
    const { teamId } = await makeTeam(service);
    await service.executeAction('team.task_create', { subject: 'Only' }, 'ses_lead');

    const page = await service.readActivity({ teamId, limit: 1 });
    // Exactly one event remains: the page is full but nothing follows it.
    expect(page.events).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it('rejects an unknown team, a malformed cursor and a bad limit', async () => {
    const { service } = await makeService();
    const { teamId } = await makeTeam(service);
    await expect(service.readActivity({ teamId: 'team_missing' }))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(service.readActivity({ teamId, before: 'nope' }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(service.readActivity({ teamId, before: '12:' }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(service.readActivity({ teamId, limit: 0 }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(service.readActivity({ teamId, limit: 'many' }))
      .rejects.toMatchObject({ statusCode: 400 });
    // Omitted limit is the default page, and a missing cursor is page one.
    await expect(service.readActivity({ teamId })).resolves.toMatchObject({ teamId });
  });
});

describe('createFromUi', () => {
  it('creates the lead and member sessions, then briefs every member', async () => {
    const { service, sent, broadcasts, openCodeState } = await makeService();
    const result = await service.createFromUi({
      name: 'Board Crew',
      directory: '/work/project',
      task: 'Собери отчёт',
      members: [
        { name: 'Лид', isLead: true, agent: 'build' },
        { name: 'Альфа', agent: 'build', brief: 'Тесты' },
      ],
    });

    expect(result.leadSessionId).toMatch(/^ses_/);
    expect(result.members.map((member) => [member.role, member.status])).toEqual([
      ['lead', 'busy'],
      ['teammate', 'busy'],
    ]);

    const [leadCreate, mateCreate] = openCodeState.creates;
    expect(leadCreate.parentID).toBeUndefined();
    expect(leadCreate.metadata.openchamber.team).toMatchObject({ role: 'lead', name: 'Лид' });
    expect(mateCreate.parentID).toBe(result.leadSessionId);
    expect(mateCreate.title).toBe('Board Crew · Альфа');
    expect(mateCreate.metadata.openchamber.team).toMatchObject({ role: 'teammate', name: 'Альфа' });

    expect(sent[0].sessionID).toBe(result.leadSessionId);
    expect(sent[0].payload.prompt).toContain('First Task From The User');
    expect(sent[0].payload.prompt).toContain('Собери отчёт');
    expect(sent[1].sessionID).not.toBe(result.leadSessionId);
    expect(sent[1].payload.prompt).toContain('Do not invent work');

    expect(broadcasts.filter((event) => event.type === 'openchamber:team-created')).toHaveLength(1);
    expect(broadcasts.filter((event) => event.type === 'openchamber:team-members')).toHaveLength(1);

    const [board] = await service.overview();
    expect(board.members).toHaveLength(2);
  });

  it('treats the first member as the lead when none is flagged', async () => {
    const { service, openCodeState } = await makeService();
    await service.createFromUi({
      name: 'Crew',
      directory: '/work/project',
      members: [{ name: 'Первый' }, { name: 'Второй', isLead: true }],
    });
    expect(openCodeState.creates[0].metadata.openchamber.team).toMatchObject({ role: 'lead', name: 'Второй' });
    expect(openCodeState.creates[1].metadata.openchamber.team).toMatchObject({ role: 'teammate', name: 'Первый' });
  });

  it('rejects lineups the team model cannot express', async () => {
    const { service } = await makeService();
    const base = { name: 'Crew', directory: '/work/project' };
    await expect(service.createFromUi({ ...base, members: [] })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.createFromUi({
      ...base,
      members: [{ name: 'A', isLead: true }, { name: 'B', isLead: true }],
    })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.createFromUi({
      ...base,
      members: [{ name: 'A' }, { name: 'A' }],
    })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.createFromUi({
      ...base,
      members: [{ name: 'A', agent: 'plan' }],
    })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.createFromUi({
      ...base,
      members: [{ name: 'A', model: 'nope/model' }],
    })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('gates the selected skills and MCP servers as session permissions', async () => {
    const { service, openCodeState } = await makeService();
    await service.createFromUi({
      name: 'Gated',
      directory: '/work/project',
      members: [{ name: 'Лид', isLead: true, skills: ['demo'], mcpServers: ['docs'] }],
    });
    expect(openCodeState.creates[0].permissions).toEqual([
      { action: 'skill', resource: '*', effect: 'deny' },
      { action: 'skill', resource: 'demo', effect: 'allow' },
      { action: 'tracker_*', resource: '*', effect: 'deny' },
    ]);

    await service.createFromUi({
      name: 'Ungated',
      directory: '/work/project',
      members: [{ name: 'Лид', isLead: true }],
    });
    expect(openCodeState.creates[1].permissions).toEqual([]);
  });
});

describe('createTaskFromUi', () => {
  it('puts an unowned task on the board, marked as the user\'s', async () => {
    const { service, sent, broadcasts } = await makeService();
    const { teamId } = await makeTeam(service);
    const sentBefore = sent.length;

    const { task } = await service.createTaskFromUi({ teamId, input: { subject: 'Проверить сборку' } });

    expect(task.status).toBe('pending');
    expect(task.owner).toBeNull();
    expect(task.createdBy).toBe('user');
    // No owner means no wake: the task waits on the board for the lead.
    expect(sent).toHaveLength(sentBefore);

    const [team] = await service.snapshot();
    const persisted = team.tasks.find((entry) => entry.taskId === task.taskId);
    expect(persisted.createdBy).toBe('user');
    expect(broadcasts.some((event) => event.type === 'openchamber:team-task' && event.properties.taskId === task.taskId)).toBe(true);
  });

  it('carries the brief and wakes the owner with the assignment', async () => {
    const { service, sent } = await makeService();
    const { teamId, roster } = await makeTeam(service);
    const alice = roster[0];

    const { task } = await service.createTaskFromUi({
      teamId,
      input: { subject: 'Собрать отчёт', description: 'По всем сервисам', owner: alice.slotId },
    });

    expect(task.owner).toBe(alice.slotId);
    const wake = sent.filter((entry) => entry.sessionID === alice.sessionId).at(-1);
    expect(wake.payload.prompt).toContain('Task assigned to you: Собрать отчёт');
    expect(wake.payload.prompt).toContain('По всем сервисам');
  });

  it('rejects unknown teams, empty subjects and invalid owners', async () => {
    const { service } = await makeService();
    const { teamId } = await makeTeam(service);

    await expect(service.createTaskFromUi({ teamId: 'team_none', input: { subject: 'X' } }))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(service.createTaskFromUi({ teamId, input: { subject: '   ' } }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(service.createTaskFromUi({ teamId, input: { subject: 'X', owner: 'lead' } }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(service.createTaskFromUi({ teamId, input: { subject: 'X', owner: 'member_nobody' } }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('team service: sub-teams and live roster editing', () => {
  it('spawns a sub-team lead and nests its workers under it', async () => {
    const { service, sent, openCodeState } = await makeService();
    await service.executeAction('team.start', { name: 'Crew' }, 'ses_lead');
    await service.executeAction('team.spawn_agent', { name: 'Анна', agent: 'build', domain: 'development', isDomainLead: true }, 'ses_lead');
    await service.executeAction('team.spawn_agent', { name: 'Богдан', agent: 'build', domain: 'development' }, 'ses_lead');

    const [team] = await service.snapshot();
    const leader = team.members.find((member) => member.name === 'Анна');
    const worker = team.members.find((member) => member.name === 'Богдан');
    expect(leader.isDomainLead).toBe(true);
    expect(leader.domain).toBe('development');
    expect(worker.isDomainLead).toBe(false);

    const leadCreate = openCodeState.creates.find((create) => create.metadata?.openchamber?.team?.slotId === leader.slotId);
    const workerCreate = openCodeState.creates.find((create) => create.metadata?.openchamber?.team?.slotId === worker.slotId);
    expect(leadCreate.parentID).toBe('ses_lead');
    expect(workerCreate.parentID).toBe(leader.sessionId);

    const leadBriefing = sent.find((entry) => entry.sessionID === leader.sessionId).payload.prompt;
    expect(leadBriefing).toContain("You Lead the 'development' Sub-Team");
    const workerBriefing = sent.find((entry) => entry.sessionID === worker.sessionId).payload.prompt;
    expect(workerBriefing).toContain(`Your sub-team lead: Анна (slot_id: ${leader.slotId})`);
  });

  it('refuses a second lead for the same sub-team', async () => {
    const { service } = await makeService();
    await service.executeAction('team.start', { name: 'Crew' }, 'ses_lead');
    await service.executeAction('team.spawn_agent', { name: 'Анна', agent: 'build', domain: 'review', isDomainLead: true }, 'ses_lead');
    await expect(service.executeAction('team.spawn_agent', { name: 'Вера', agent: 'build', domain: 'review', isDomainLead: true }, 'ses_lead'))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('routes a domain member’s reports through its sub-team lead', async () => {
    const { service } = await makeService();
    await service.executeAction('team.start', { name: 'Crew' }, 'ses_lead');
    await service.executeAction('team.spawn_agent', { name: 'Анна', agent: 'build', domain: 'qa', isDomainLead: true }, 'ses_lead');
    await service.executeAction('team.spawn_agent', { name: 'Богдан', agent: 'build', domain: 'qa' }, 'ses_lead');
    const [team] = await service.snapshot();
    const leader = team.members.find((member) => member.name === 'Анна');
    const worker = team.members.find((member) => member.name === 'Богдан');
    await service.processPayload(idleEvent(leader.sessionId));
    await service.processPayload(idleEvent(worker.sessionId));

    // The worker reports to the sub-team lead, not to the Team Lead.
    await service.executeAction('team.send_message', { to: leader.slotId, message: 'QA: тесты зелёные' }, worker.sessionId);
    await service.processPayload(idleEvent(worker.sessionId));
    let [teamNow] = await service.snapshot();
    expect(teamNow.mailbox.some((message) => (
      message.type === 'idle_notification' && message.to === leader.slotId && message.from === worker.slotId
    ))).toBe(true);
    expect(teamNow.mailbox.some((message) => (
      message.type === 'idle_notification' && message.to === 'lead' && message.from === worker.slotId
    ))).toBe(false);

    // The sub-team lead aggregates upward to the Team Lead.
    await service.executeAction('team.send_message', { to: 'lead', message: 'Итог по QA: всё зелёное' }, leader.sessionId);
    await service.processPayload(idleEvent(leader.sessionId));
    [teamNow] = await service.snapshot();
    expect(teamNow.mailbox.some((message) => (
      message.type === 'idle_notification' && message.to === 'lead' && message.from === leader.slotId
    ))).toBe(true);
  });

  it('retires a member that approves shutdown through its sub-team lead', async () => {
    const { service } = await makeService();
    await service.executeAction('team.start', { name: 'Crew' }, 'ses_lead');
    await service.executeAction('team.spawn_agent', { name: 'Анна', agent: 'build', domain: 'review', isDomainLead: true }, 'ses_lead');
    await service.executeAction('team.spawn_agent', { name: 'Богдан', agent: 'build', domain: 'review' }, 'ses_lead');
    const [team] = await service.snapshot();
    const leader = team.members.find((member) => member.name === 'Анна');
    const worker = team.members.find((member) => member.name === 'Богдан');
    await service.processPayload(idleEvent(leader.sessionId));
    await service.processPayload(idleEvent(worker.sessionId));

    await service.executeAction('team.send_message', { to: leader.slotId, message: 'shutdown_approved' }, worker.sessionId);
    const [teamNow] = await service.snapshot();
    expect(teamNow.members.find((member) => member.slotId === worker.slotId).removed).toBe(true);
  });

  it('creates sub-team leads ahead of their workers and nests the sessions', async () => {
    const { service, openCodeState } = await makeService();
    await service.createFromUi({
      name: 'Студия',
      directory: '/work/project',
      members: [
        { name: 'Тим-лид', isLead: true },
        { name: 'Работяга разработки', domain: 'development' },
        { name: 'Лид разработки', domain: 'development', isDomainLead: true },
      ],
    });
    const [team] = await service.snapshot();
    const domainLead = team.members.find((member) => member.name === 'Лид разработки');
    const worker = team.members.find((member) => member.name === 'Работяга разработки');
    expect(domainLead.isDomainLead).toBe(true);
    expect(worker.domain).toBe('development');
    const workerCreate = openCodeState.creates.find((create) => create.metadata?.openchamber?.team?.slotId === worker.slotId);
    expect(workerCreate.parentID).toBe(domainLead.sessionId);
  });

  it('rejects a lineup with two leads of the same sub-team', async () => {
    const { service } = await makeService();
    await expect(service.createFromUi({
      name: 'Студия',
      directory: '/work/project',
      members: [
        { name: 'Тим-лид', isLead: true },
        { name: 'Аналитик-1', domain: 'analytics', isDomainLead: true },
        { name: 'Аналитик-2', domain: 'analytics', isDomainLead: true },
      ],
    })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('adds a member to a live team and requests its shutdown from the app', async () => {
    const { service, sent, openCodeState } = await makeService();
    const created = await service.createFromUi({
      name: 'Дуэт',
      directory: '/work/project',
      members: [{ name: 'Тим-лид', isLead: true }, { name: 'Исполнитель' }],
    });
    const teamId = created.team.id;

    const added = await service.addMemberFromUi({ teamId, input: { name: 'Новый', agent: 'build', domain: 'qa', skills: ['demo'], mcpServers: ['docs'] } });
    expect(added.member.slotId).toMatch(/^member_/);
    const [team] = await service.snapshot();
    const newer = team.members.find((member) => member.name === 'Новый');
    expect(newer.domain).toBe('qa');
    expect(newer.skills).toEqual(['demo']);
    expect(sent.some((entry) => entry.sessionID === newer.sessionId
      && entry.payload.prompt.includes('You are a Team Member'))).toBe(true);
    const create = openCodeState.creates.find((entry) => entry.metadata?.openchamber?.team?.slotId === newer.slotId);
    expect(create.permissions).toEqual([
      { action: 'skill', resource: '*', effect: 'deny' },
      { action: 'skill', resource: 'demo', effect: 'allow' },
      { action: 'tracker_*', resource: '*', effect: 'deny' },
    ]);

    // The app dismissal rides the same approval handshake as the lead tool.
    await service.shutdownMemberFromUi({ teamId, slotId: newer.slotId, reason: 'не нужен' });
    const [teamNow] = await service.snapshot();
    const shutdownMessage = teamNow.mailbox.find((message) => message.type === 'shutdown_request' && message.to === newer.slotId);
    expect(shutdownMessage.from).toBe('lead');
    expect(shutdownMessage.summary).toBe('не нужен');

    await expect(service.shutdownMemberFromUi({ teamId, slotId: 'lead' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.addMemberFromUi({ teamId, input: { name: 'Новый' } })).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.addMemberFromUi({ teamId: 'team_missing', input: { name: 'Кто-то' } })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('team.export_preset', () => {
  it('snaps the live roster into a preset recipe with briefs and tools', async () => {
    const { service } = await makeService();
    await service.createFromUi({
      name: 'Дуэт',
      description: 'Правки регресса',
      directory: '/work/project',
      members: [
        { name: 'Тим-лид', isLead: true },
        {
          name: 'Лид тестирования',
          agent: 'build',
          model: 'prov/alpha',
          brief: 'Руководишь прогонами',
          skills: ['demo'],
          mcpServers: ['docs'],
          domain: 'qa',
          isDomainLead: true,
        },
      ],
    });
    // createFromUi spawns the lead its own session; the recipe call is the
    // lead's, once the roster names it.
    const [team] = await service.snapshot();
    const leadSessionId = team.members.find((member) => member.role === 'lead').sessionId;

    const result = await service.executeAction('team.export_preset', {}, leadSessionId);
    expect(result.preset.name).toBe('Дуэт');
    expect(result.preset.description).toBe('Правки регресса');
    const [lead, qaLead] = result.preset.members;
    expect(lead.isLead).toBe(true);
    expect(lead.domain).toBeNull();
    expect(lead.isDomainLead).toBe(false);
    expect(qaLead.isLead).toBe(false);
    expect(qaLead.agent).toBe('build');
    expect(qaLead.model).toBe('prov/alpha');
    expect(qaLead.brief).toBe('Руководишь прогонами');
    expect(qaLead.skills).toEqual(['demo']);
    expect(qaLead.mcpServers).toEqual(['docs']);
    expect(qaLead.domain).toBe('qa');
    expect(qaLead.isDomainLead).toBe(true);
  });

  it('keeps the recipe to the active roster and takes name overrides', async () => {
    const { service } = await makeService();
    const created = await service.createFromUi({
      name: 'Дуэт',
      directory: '/work/project',
      members: [
        { name: 'Тим-лид', isLead: true },
        { name: 'Тестер', agent: 'build' },
      ],
    });
    const tester = created.members.find((member) => member.name === 'Тестер');
    const [teamInit] = await service.snapshot();
    const leadSessionId = teamInit.members.find((member) => member.role === 'lead').sessionId;
    const testerSessionId = teamInit.members.find((member) => member.name === 'Тестер').sessionId;
    await expect(service.executeAction('team.export_preset', {}, testerSessionId))
      .rejects.toMatchObject({ statusCode: 403 });

    await service.executeAction('team.shutdown_agent', { slotId: tester.slotId, reason: 'не нужен' }, leadSessionId);
    await service.executeAction('team.send_message', { to: 'lead', message: 'shutdown_approved' }, testerSessionId);

    const result = await service.executeAction('team.export_preset', { name: 'Рецепт', description: 'Схема' }, leadSessionId);
    expect(result.preset.name).toBe('Рецепт');
    expect(result.preset.description).toBe('Схема');
    expect(result.preset.members).toHaveLength(1);
    expect(result.preset.members[0].isLead).toBe(true);
  });

  it('serves the app its own recipe export', async () => {
    const { service } = await makeService();
    const created = await service.createFromUi({
      name: 'Соло',
      directory: '/work/project',
      members: [{ name: 'Тим-лид', isLead: true }],
    });
    const { preset } = await service.exportPresetFromUi({ teamId: created.team.id });
    expect(preset.name).toBe('Соло');
    expect(preset.members).toHaveLength(1);
    expect(preset.members[0].isLead).toBe(true);
    await expect(service.exportPresetFromUi({ teamId: 'team_missing' })).rejects.toMatchObject({ statusCode: 404 });
  });
});
