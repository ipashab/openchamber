import { z } from 'zod';

/**
 * Assistants as contacts: named personas the user chats with like people.
 *
 * A contact is a saved assistant — a name, a one-line description and the
 * persona prompt that opens its chat. Opening a contact continues one
 * continuing thread: the first open creates a session and hands it the
 * persona as its opening message, every later open jumps back into that
 * same session while it still exists. The contact outlives the session: if
 * the session is gone, the next open starts a fresh thread for the contact.
 *
 * The contact itself is just state — a list persisted to assistants.json
 * beside teams.json and missions.json. No queue, no watch: the chat is an
 * ordinary session and the user steers it from the conversation itself.
 */

const STATE_FILE_NAME = 'assistants.json';
const PERSIST_DEBOUNCE_MS = 500;
const MAX_ASSISTANTS = 50;

class AssistantError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

const nonEmptyTextSchema = z.string().trim().min(1);
const asNonEmptyString = (value) => {
  const parsed = nonEmptyTextSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const asList = (value) => (Array.isArray(value) ? value : []);

const assistantNameSchema = z.string().trim().min(1).max(80);
const assistantDescriptionSchema = z.string().trim().max(500);
const assistantPromptSchema = z.string().trim().min(1).max(20_000);
const assistantModelSchema = z.string().trim().regex(/^[^/]+\/[^/]+$/);
const assistantAgentSchema = z.string().trim().min(1).max(120);

/**
 * A field the request may carry, may omit, or may clear with null/''.
 * `present` distinguishes "the caller wants this changed" from "leave it".
 */
const optionalField = (value, schema) => {
  if (value === undefined) return { present: false, value: undefined };
  if (value === null || value === '') return { present: true, value: null };
  const parsed = schema.safeParse(value);
  if (!parsed.success) return { present: true, invalid: true };
  return { present: true, value: parsed.data };
};

/**
 * The create input parses whole at this boundary; the update input parses
 * only the fields the request carries. Both answer with every reason at
 * once so the form can show them together.
 */
const parseCreateInput = (input) => {
  const errors = [];
  const name = assistantNameSchema.safeParse(input?.name);
  if (!name.success) errors.push('name is required: at most 80 characters');
  const description = optionalField(input?.description, assistantDescriptionSchema);
  if (description.invalid) errors.push('description is at most 500 characters');
  const prompt = assistantPromptSchema.safeParse(input?.prompt);
  if (!prompt.success) errors.push('prompt is required: what this contact opens its chat with, at most 20,000 characters');
  const model = optionalField(input?.model, assistantModelSchema);
  if (model.invalid) errors.push('model must look like provider/model');
  const agent = optionalField(input?.agent, assistantAgentSchema);
  if (agent.invalid) errors.push('agent must be 1-120 characters');
  const directory = asNonEmptyString(input?.directory);
  if (!directory) errors.push('directory is required: where this contact works');
  if (errors.length > 0) throw new AssistantError(errors.join('; '), 400);
  return {
    name: name.data,
    description: description.value ?? '',
    prompt: prompt.data,
    model: model.value ?? null,
    agent: agent.value ?? null,
    directory,
  };
};

const parseUpdateInput = (input) => {
  const errors = [];
  const patch = {};
  if (input?.name !== undefined) {
    const name = assistantNameSchema.safeParse(input.name);
    if (name.success) patch.name = name.data;
    else errors.push('name must be 1-80 characters');
  }
  const description = optionalField(input?.description, assistantDescriptionSchema);
  if (description.invalid) errors.push('description is at most 500 characters');
  else if (description.present) patch.description = description.value ?? '';
  const prompt = optionalField(input?.prompt, assistantPromptSchema);
  if (prompt.invalid) errors.push('prompt must be 1-20,000 characters');
  else if (prompt.present) patch.prompt = prompt.value;
  const model = optionalField(input?.model, assistantModelSchema);
  if (model.invalid) errors.push('model must look like provider/model');
  else if (model.present) patch.model = model.value;
  const agent = optionalField(input?.agent, assistantAgentSchema);
  if (agent.invalid) errors.push('agent must be 1-120 characters');
  else if (agent.present) patch.agent = agent.value;
  const directory = asNonEmptyString(input?.directory);
  if (directory) patch.directory = directory;
  if (errors.length > 0) throw new AssistantError(errors.join('; '), 400);
  return patch;
};

export const createAssistantsService = (dependencies) => {
  const {
    fsPromises,
    path,
    dataDir,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    waitForOpenCodeReady,
    createOpenCodeClient,
    sessionService,
    broadcastUiEvent = null,
    now = Date.now,
  } = dependencies;

  if (!sessionService?.send) {
    throw new Error('assistants service needs a session service with send()');
  }

  const stateFilePath = path.join(dataDir, STATE_FILE_NAME);
  const clientFor = (directory) => createOpenCodeClient({
    baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
    headers: getOpenCodeAuthHeaders(),
    directory,
  });

  /** @type {Array<object>} */
  let assistants = [];
  let loaded = false;
  let loadPromise = null;
  let persistTimer = null;

  const broadcast = (change, assistantId) => {
    if (!broadcastUiEvent) return;
    try {
      broadcastUiEvent({ type: 'openchamber:assistant-changed', properties: { change, assistantId } });
    } catch {
      // Best-effort, like every other state frame; the next one repairs it.
    }
  };

  const persist = async () => {
    const payload = JSON.stringify({ assistants }, null, 2);
    await fsPromises.mkdir(path.dirname(stateFilePath), { recursive: true });
    const temporary = `${stateFilePath}.tmp`;
    await fsPromises.writeFile(temporary, payload, 'utf8');
    await fsPromises.rename(temporary, stateFilePath);
  };

  const schedulePersist = () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persist().catch((error) =>
        console.warn('[assistants] could not persist state:', error?.message ?? error));
    }, PERSIST_DEBOUNCE_MS);
  };

  const load = async () => {
    if (loaded) return;
    if (!loadPromise) {
      loadPromise = (async () => {
        try {
          const raw = await fsPromises.readFile(stateFilePath, 'utf8');
          const parsed = JSON.parse(raw);
          assistants = asList(parsed?.assistants).filter((entry) => asNonEmptyString(entry?.id));
        } catch (error) {
          if (error?.code !== 'ENOENT') {
            console.warn('[assistants] could not load state, starting empty:', error?.message ?? error);
          }
          assistants = [];
        }
        loaded = true;
      })();
    }
    await loadPromise;
  };

  const publicAssistant = (assistant) => ({ ...assistant });

  const findAssistant = (assistantId) => {
    const id = asNonEmptyString(assistantId);
    if (!id) throw new AssistantError('assistantId is required', 400);
    const assistant = assistants.find((entry) => entry.id === id);
    if (!assistant) throw new AssistantError('No such assistant', 404);
    return assistant;
  };

  /**
   * The thread of a contact is its last session, reused while it exists.
   * The probe is a plain session read: an error or a missing body means the
   * session is gone (deleted, archived away from the runtime), and the next
   * open starts a fresh thread for the same contact.
   */
  const sessionStillExists = async (assistant) => {
    if (!assistant.lastSessionId) return false;
    try {
      const client = clientFor(assistant.directory);
      const session = await client.session.get(assistant.lastSessionId);
      return asNonEmptyString(session?.id ?? session?.session?.id) !== null;
    } catch {
      return false;
    }
  };

  const openChat = async (assistantId, input) => {
    await load();
    const assistant = findAssistant(assistantId);
    if (await sessionStillExists(assistant)) {
      broadcast('thread-reused', assistant.id);
      return { assistant: publicAssistant(assistant), sessionId: assistant.lastSessionId, created: false };
    }
    // A fresh chat for the contact: the directory the request carries wins
    // over the saved one, so a contact can move between projects.
    const directory = asNonEmptyString(input?.directory) ?? assistant.directory;
    if (!directory) throw new AssistantError('directory is required to start this contact a chat', 400);
    await waitForOpenCodeReady();
    const client = clientFor(directory);
    const createOptions = {
      title: assistant.name,
      location: { directory },
      metadata: { openchamber: { assistant: { id: assistant.id, version: 1 } } },
    };
    if (assistant.model) {
      createOptions.model = { id: assistant.model.split('/')[1] ?? assistant.model, providerID: assistant.model.split('/')[0] };
    }
    if (assistant.agent) {
      createOptions.agent = assistant.agent;
    }
    const session = await client.session.create(createOptions);
    const sessionId = asNonEmptyString(session?.id);
    if (!sessionId) throw new AssistantError('OpenCode created no session for the contact', 502);
    assistant.lastSessionId = sessionId;
    assistant.directory = directory;
    assistant.updatedAt = now();
    schedulePersist();
    // The persona is the opening message: the contact speaks as its prompt
    // says from the very first turn.
    const dispatch = { prompt: assistant.prompt, directory };
    if (assistant.model) dispatch.model = assistant.model;
    if (assistant.agent) dispatch.agent = assistant.agent;
    await sessionService.send(sessionId, dispatch);
    broadcast('thread-started', assistant.id);
    return { assistant: publicAssistant(assistant), sessionId, created: true };
  };

  return {
    init: load,

    listAssistants: async () => {
      await load();
      return assistants.map(publicAssistant);
    },

    createAssistant: async (input) => {
      await load();
      if (assistants.length >= MAX_ASSISTANTS) {
        throw new AssistantError(`The contact list holds at most ${MAX_ASSISTANTS} contacts`, 409);
      }
      const fields = parseCreateInput(input ?? {});
      const assistant = {
        id: `assistant_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        name: fields.name,
        description: fields.description,
        prompt: fields.prompt,
        model: fields.model,
        agent: fields.agent,
        directory: fields.directory,
        lastSessionId: null,
        createdAt: now(),
        updatedAt: now(),
      };
      assistants.unshift(assistant);
      schedulePersist();
      broadcast('created', assistant.id);
      return { assistant: publicAssistant(assistant) };
    },

    updateAssistant: async (assistantId, input) => {
      await load();
      const assistant = findAssistant(assistantId);
      const patch = parseUpdateInput(input ?? {});
      Object.assign(assistant, patch, { updatedAt: now() });
      schedulePersist();
      broadcast('updated', assistant.id);
      return { assistant: publicAssistant(assistant) };
    },

    deleteAssistant: async (assistantId) => {
      await load();
      const assistant = findAssistant(assistantId);
      // The contact is forgotten; the chat it started is an ordinary
      // session and stays where its own user can find it.
      assistants = assistants.filter((entry) => entry.id !== assistant.id);
      schedulePersist();
      broadcast('deleted', assistant.id);
      return { deleted: true, assistantId: assistant.id };
    },

    openChat,
  };
};
