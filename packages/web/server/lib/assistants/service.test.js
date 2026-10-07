import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAssistantsService } from './service.js';

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

const PATH = { join: (...parts) => parts.join('/'), dirname: (value) => value.split('/').slice(0, -1).join('/') };

const makeService = ({ liveSessions } = {}) => {
  const fs = makeFs();
  const events = [];
  const sent = [];
  const sessionsCreated = [];
  // Sessions the runtime still knows about; the probe reads this set.
  const live = liveSessions ?? new Set();
  let sessionCounter = 0;
  const createOpenCodeClient = () => ({
    session: {
      create: vi.fn(async (input) => {
        sessionCounter += 1;
        const id = `ses_${sessionCounter}`;
        sessionsCreated.push({ id, input });
        live.add(id);
        return { id };
      }),
      get: vi.fn(async (sessionId) => (live.has(sessionId) ? { id: sessionId } : (() => {
        throw new Error('session not found');
      })())),
    },
  });
  const service = createAssistantsService({
    fsPromises: fs.promises,
    path: PATH,
    dataDir: '/data',
    buildOpenCodeUrl: (suffix) => `http://opencode${suffix}`,
    getOpenCodeAuthHeaders: () => ({}),
    waitForOpenCodeReady: async () => {},
    createOpenCodeClient,
    sessionService: { send: vi.fn(async (sessionId, payload) => { sent.push({ sessionId, payload }); }) },
    broadcastUiEvent: (event) => events.push(event),
  });
  return { service, fs, events, sent, sessionsCreated, live };
};

const input = {
  name: 'Reviewbot',
  description: 'Reviews diffs in plain French',
  prompt: 'You review code as a French-speaking senior engineer.',
  directory: '/projects/app',
};

describe('createAssistantsService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a contact with the fields it was given and files it first', async () => {
    const { service, events } = makeService();
    const { assistant } = await service.createAssistant(input);
    expect(assistant.name).toBe('Reviewbot');
    expect(assistant.description).toBe('Reviews diffs in plain French');
    expect(assistant.lastSessionId).toBeNull();
    const list = await service.listAssistants();
    expect(list[0].id).toBe(assistant.id);
    expect(events.map((event) => event.properties.change)).toContain('created');
  });

  it('refuses a contact without a name, a prompt or a directory in one answer', async () => {
    const { service } = makeService();
    await expect(service.createAssistant({ prompt: 'x' })).rejects.toThrow(/name is required/);
    await expect(service.createAssistant({ name: 'a', prompt: 'p' })).rejects.toThrow(/directory is required/);
    await expect(service.createAssistant({ name: 'a', directory: '/d' })).rejects.toThrow(/prompt is required/);
  });

  it('rejects a model that does not look like provider/model', async () => {
    const { service } = makeService();
    await expect(service.createAssistant({ ...input, model: 'gpt-only' })).rejects.toThrow(/provider\/model/);
  });

  it('opens a contact a fresh chat seeded with its persona, once', async () => {
    const { service, sent, sessionsCreated } = makeService();
    const { assistant } = await service.createAssistant(input);
    const first = await service.openChat(assistant.id, {});
    expect(first.created).toBe(true);
    expect(first.assistant.lastSessionId).toBe(first.sessionId);
    expect(sessionsCreated[0].input.title).toBe('Reviewbot');
    expect(sent[0].payload.prompt).toBe(input.prompt);
    // The second open continues the same thread and sends nothing new.
    const second = await service.openChat(assistant.id, {});
    expect(second.created).toBe(false);
    expect(second.sessionId).toBe(first.sessionId);
    expect(sent).toHaveLength(1);
  });

  it('starts a fresh thread when the saved session is gone', async () => {
    const { service, live } = makeService();
    const { assistant } = await service.createAssistant(input);
    const first = await service.openChat(assistant.id, {});
    live.delete(first.sessionId);
    const again = await service.openChat(assistant.id, {});
    expect(again.created).toBe(true);
    expect(again.sessionId).not.toBe(first.sessionId);
  });

  it('lets the request move a contact to another project when the thread restarts', async () => {
    const { service, sessionsCreated } = makeService();
    const { assistant } = await service.createAssistant(input);
    const opened = await service.openChat(assistant.id, { directory: '/other/project' });
    expect(opened.assistant.directory).toBe('/other/project');
    expect(sessionsCreated[0].input.location.directory).toBe('/other/project');
  });

  it('patches only the fields an update carries', async () => {
    const { service } = makeService();
    const { assistant } = await service.createAssistant(input);
    const { assistant: updated } = await service.updateAssistant(assistant.id, { name: 'Reviewbot 2' });
    expect(updated.name).toBe('Reviewbot 2');
    expect(updated.prompt).toBe(input.prompt);
    expect(updated.description).toBe(input.description);
  });

  it('clears a model with null and refuses a broken patch', async () => {
    const { service } = makeService();
    const { assistant } = await service.createAssistant({ ...input, model: 'okko/Expert' });
    const { assistant: cleared } = await service.updateAssistant(assistant.id, { model: null });
    expect(cleared.model).toBeNull();
    await expect(service.updateAssistant(assistant.id, { model: 'broken' })).rejects.toThrow(/provider\/model/);
  });

  it('deletes a contact and keeps its chat session alone', async () => {
    const { service, live, sessionsCreated } = makeService();
    const { assistant } = await service.createAssistant(input);
    const opened = await service.openChat(assistant.id, {});
    const { deleted } = await service.deleteAssistant(assistant.id);
    expect(deleted).toBe(true);
    expect(await service.listAssistants()).toHaveLength(0);
    expect(live.has(opened.sessionId)).toBe(true);
    expect(sessionsCreated).toHaveLength(1);
  });

  it('answers 404-shaped errors for an unknown contact', async () => {
    const { service } = makeService();
    await expect(service.updateAssistant('assistant_nope', { name: 'x' })).rejects.toThrow('No such assistant');
    await expect(service.openChat('assistant_nope', {})).rejects.toThrow('No such assistant');
  });

  it('caps the address book at its maximum', async () => {
    const filled = {
      assistants: Array.from({ length: 50 }, (_, i) => ({
        id: `assistant_filled_${i}`,
        name: `Contact ${i}`,
        description: '',
        prompt: 'persona',
        model: null,
        agent: null,
        directory: '/projects/app',
        lastSessionId: null,
        createdAt: 1,
        updatedAt: 1,
      })),
    };
    const { service, fs } = makeService();
    fs.files.set('/data/assistants.json', JSON.stringify(filled));
    await expect(service.createAssistant(input)).rejects.toThrow(/at most 50/);
  });

  it('persists the address book and reloads it after a restart', async () => {
    const { service, fs } = makeService();
    const { assistant } = await service.createAssistant(input);
    await vi.advanceTimersByTimeAsync(600);
    const raw = fs.files.get('/data/assistants.json');
    expect(JSON.parse(raw).assistants[0].id).toBe(assistant.id);
    const revived = makeService({});
    revived.fs.files.set('/data/assistants.json', raw);
    const list = await revived.service.listAssistants();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Reviewbot');
  });
});
