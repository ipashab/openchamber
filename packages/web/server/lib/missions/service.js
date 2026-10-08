import { z } from 'zod';

/**
 * Missions: a list of goal prompts the user starts and walks away from.
 *
 * A mission is one goal in one lane of its own — a fresh session that
 * receives the prompt (mode 'session') or a lead-led team whose first task is
 * the prompt (mode 'team'). The user files several at once and watches from
 * the list; the executor is the one that paces them: as many missions run at
 * a time as the queue config allows (maxConcurrent, default 2), the rest
 * wait as 'queued'. The config is the user's to set and lives beside the
 * missions in the state file.
 *
 * Completion is watched, not assumed: after the prompt is dispatched the
 * executor observes the session's busy/idle state and marks the mission
 * 'completed' when the turn it started goes idle. The watch ends after
 * maxRunMs no matter what — a turn that never reported busy was failed far
 * sooner, and a turn longer than the window is released as completed, so
 * no session can hold the queue hostage. maxRunMs is part of the queue
 * config; a change arms new watches with the new window and leaves running
 * ones on the window they were armed with — re-arming would forget the
 * seen-busy phase and fail a mission finishing right now.
 *
 * State persists to missions.json beside teams.json and survives restarts:
 * queued missions resume draining, a running mission that was mid-turn when
 * the server died is still watched to its end (the claim is the session's,
 * not the process's).
 */

const STATE_FILE_NAME = 'missions.json';
const PERSIST_DEBOUNCE_MS = 500;
const MAX_MISSIONS = 200;
const POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_MAX_RUN_MS = 60 * 60 * 1000;
// The queue config is a user setting, not a free-for-all: a lane count past
// sixteen is a fleet the user cannot watch, a window past a day is no window.
const MAX_CONCURRENT_LIMIT = 16;
const MIN_RUN_MS = 60 * 1000;
const MAX_RUN_MS = 24 * 60 * 60 * 1000;

const MISSION_STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'cancelled']);

class MissionError extends Error {
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

const missionTitleSchema = z.string().trim().min(1).max(120);
const missionPromptSchema = z.string().trim().min(1).max(50_000);
const missionModeSchema = z.enum(['session', 'team']);
const missionModelSchema = z.string().trim().regex(/^[^/]+\/[^/]+$/);
const missionAgentSchema = z.string().trim().min(1).max(120);
const missionConcurrencySchema = z.number().int().min(1).max(MAX_CONCURRENT_LIMIT);
const missionRunMsSchema = z.number().int().min(MIN_RUN_MS).max(MAX_RUN_MS);
const storedConfigSchema = z.object({
  maxConcurrent: missionConcurrencySchema,
  maxRunMs: missionRunMsSchema,
}).partial();

/**
 * The create input parses at this boundary; everything past it works with
 * domain values rather than raw request shapes.
 */
const parseCreateInput = (input) => {
  const title = missionTitleSchema.safeParse(input?.title ?? input?.prompt?.slice(0, 120));
  const prompt = missionPromptSchema.safeParse(input?.prompt);
  const mode = missionModeSchema.safeParse(input?.mode ?? 'session');
  const directory = asNonEmptyString(input?.directory);
  const model = input?.model === undefined || input?.model === null || input?.model === ''
    ? null
    : (missionModelSchema.safeParse(input.model).data ?? null);
  const agent = asNonEmptyString(input?.agent);
  const agentValid = input?.agent === undefined || input?.agent === null || input?.agent === ''
    ? null
    : (missionAgentSchema.safeParse(input.agent).data ?? null);
  const inputErrors = [];
  if (!title.success) inputErrors.push('title is required: at most 120 characters');
  if (!prompt.success) inputErrors.push('prompt is required: at most 50,000 characters');
  if (!mode.success) inputErrors.push("mode must be 'session' or 'team'");
  if (!directory) inputErrors.push('directory is required: where the mission works');
  if (input?.model !== undefined && input?.model !== null && input?.model !== '' && !model) {
    inputErrors.push('model must look like provider/model');
  }
  if (agent && !agentValid) inputErrors.push('agent must be 1-120 characters');
  if (inputErrors.length > 0) throw new MissionError(inputErrors.join('; '), 400);
  return {
    title: title.data,
    prompt: prompt.data,
    mode: mode.data,
    directory,
    model,
    agent: agentValid,
  };
};

/**
 * The queue config parses at this boundary, one field at a time: every
 * rejected value names the field and the bounds the settings form shows.
 */
const parseConfigInput = (input) => {
  const next = {};
  const inputErrors = [];
  if (input?.maxConcurrent !== undefined) {
    const parsed = missionConcurrencySchema.safeParse(input.maxConcurrent);
    if (parsed.success) {
      next.maxConcurrent = parsed.data;
    } else {
      inputErrors.push(`maxConcurrent must be a whole number between 1 and ${MAX_CONCURRENT_LIMIT}`);
    }
  }
  if (input?.maxRunMs !== undefined) {
    const parsed = missionRunMsSchema.safeParse(input.maxRunMs);
    if (parsed.success) {
      next.maxRunMs = parsed.data;
    } else {
      const minutes = Math.round(MIN_RUN_MS / 60_000);
      const hours = Math.round(MAX_RUN_MS / 60_000) / 60;
      inputErrors.push(`maxRunMs must be a whole number of milliseconds between ${MIN_RUN_MS} (${minutes} minute) and ${MAX_RUN_MS} (${hours} hours)`);
    }
  }
  if (Object.keys(next).length === 0 && inputErrors.length === 0) {
    inputErrors.push('maxConcurrent or maxRunMs is required');
  }
  if (inputErrors.length > 0) throw new MissionError(inputErrors.join('; '), 400);
  return next;
};

/** A config read off disk keeps only valid fields; the rest fall back. */
const parseStoredConfig = (stored) => {
  const config = { maxConcurrent: DEFAULT_MAX_CONCURRENT, maxRunMs: DEFAULT_MAX_RUN_MS };
  const parsed = storedConfigSchema.safeParse(stored);
  if (parsed.success) Object.assign(config, parsed.data);
  return config;
};

export const createMissionsService = (dependencies) => {
  const {
    fsPromises,
    path,
    dataDir,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    waitForOpenCodeReady,
    createOpenCodeClient,
    sessionService,
    teamService,
    getSessionState,
    broadcastUiEvent = null,
    now = Date.now,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    maxRunMs = DEFAULT_MAX_RUN_MS,
  } = dependencies;

  if (!sessionService?.send) {
    throw new Error('missions service needs a session service with send()');
  }
  if (!teamService?.createFromUi) {
    throw new Error('missions service needs a team service with createFromUi()');
  }
  if (!getSessionState) {
    throw new Error('missions service needs a getSessionState() probe');
  }

  const stateFilePath = path.join(dataDir, STATE_FILE_NAME);
  const clientFor = (directory) => createOpenCodeClient({
    baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
    headers: getOpenCodeAuthHeaders(),
    directory,
  });

  /** @type {Array<object>} */
  let missions = [];
  // The queue's own settings. The injected values are the starting point for
  // tests and fresh installs; the last saved config replaces them on load.
  const config = { maxConcurrent, maxRunMs };
  let loaded = false;
  let loadPromise = null;
  let persistTimer = null;

  // The in-flight executor bookkeeping. Timers are process state, never
  // persisted: a restart re-arms everything from the loaded statuses.
  const claimedSlots = new Set();
  const pollTimers = new Map();
  const watchdogTimers = new Map();

  const broadcast = (change, missionId) => {
    if (!broadcastUiEvent) return;
    try {
      broadcastUiEvent({ type: 'openchamber:mission-changed', properties: { change, missionId } });
    } catch {
      // Best-effort, like every other state frame; the next one repairs it.
    }
  };

  const persist = async () => {
    const payload = JSON.stringify({ config, missions }, null, 2);
    await fsPromises.mkdir(path.dirname(stateFilePath), { recursive: true });
    const temporary = `${stateFilePath}.tmp`;
    await fsPromises.writeFile(temporary, payload, 'utf8');
    await fsPromises.rename(temporary, stateFilePath);
  };

  const schedulePersist = () => {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persist().catch((error) => console.warn('[missions] state write failed:', error?.message ?? error));
    }, PERSIST_DEBOUNCE_MS);
  };

  const load = async () => {
    if (loaded) return;
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      try {
        const raw = await fsPromises.readFile(stateFilePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.missions)) {
          missions = parsed.missions.slice(-MAX_MISSIONS).map((mission) => ({
            ...mission,
            status: MISSION_STATUSES.has(mission.status) ? mission.status : 'failed',
          }));
        }
        Object.assign(config, parseStoredConfig(parsed?.config));
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          console.warn('[missions] could not read state:', error?.message ?? error);
        }
        missions = [];
      } finally {
        loaded = true;
        // Server states from before the restart mean nothing for the turn a
        // running mission was mid-way through: the session's own state is
        // still observable, so the watch resumes instead of the mission
        // hanging as running forever.
        for (const mission of missions) {
          if (mission.status === 'running') watchMission(mission);
        }
        drainQueue();
      }
    })();
    return loadPromise;
  };

  const serializeMission = (mission) => ({
    missionId: mission.missionId,
    title: mission.title,
    prompt: mission.prompt,
    mode: mission.mode,
    status: mission.status,
    directory: mission.directory,
    sessionId: mission.sessionId ?? null,
    teamId: mission.teamId ?? null,
    model: mission.model ?? null,
    agent: mission.agent ?? null,
    error: mission.error ?? null,
    createdAt: mission.createdAt,
    startedAt: mission.startedAt ?? null,
    finishedAt: mission.finishedAt ?? null,
  });

  const getMission = (missionId) => missions.find((candidate) => candidate.missionId === missionId) ?? null;

  const releaseSlot = (mission) => {
    claimedSlots.delete(mission.missionId);
    drainQueue();
  };

  const clearMissionTimers = (mission) => {
    const pollTimer = pollTimers.get(mission.missionId);
    if (pollTimer) clearInterval(pollTimer);
    pollTimers.delete(mission.missionId);
    const watchdog = watchdogTimers.get(mission.missionId);
    if (watchdog) clearTimeout(watchdog);
    watchdogTimers.delete(mission.missionId);
  };

  const settleMission = (mission, status, extra = {}) => {
    clearMissionTimers(mission);
    mission.status = status;
    mission.finishedAt = now();
    Object.assign(mission, extra);
    schedulePersist();
    releaseSlot(mission);
    broadcast('updated', mission.missionId);
  };

  /**
   * The watch is the mission's notion of done: the turn its prompt started
   * goes busy, then idle. Idle-before-busy is waiting, not finished — a fresh
   * session has no state until its first event, and the first event of a
   * dispatched turn is the busy one.
   *
   * Both loops die at maxRunMs: a turn that never reports busy was never
   * really started (failed), a turn still busy after the window is released
   * as completed so its session cannot hold the queue hostage — and neither
   * interval outlives the watch window.
   */
  const watchMission = (mission) => {
    clearMissionTimers(mission);
    let seenBusy = false;
    pollTimers.set(mission.missionId, setInterval(() => {
      if (mission.status !== 'running') {
        clearMissionTimers(mission);
        return;
      }
      const state = getSessionState(mission.sessionId);
      if (!state) return;
      if (state.status === 'busy' || state.status === 'retry') {
        seenBusy = true;
        return;
      }
      if (state.status === 'idle' && seenBusy) {
        settleMission(mission, 'completed');
      }
    }, POLL_INTERVAL_MS));
    watchdogTimers.set(mission.missionId, setTimeout(() => {
      if (mission.status !== 'running') return;
      // One last read, in case the poll phase has not caught up: a turn
      // that is busy right now must not be named a failure by timing.
      const state = getSessionState(mission.sessionId);
      const busyNow = state?.status === 'busy' || state?.status === 'retry';
      if (seenBusy || busyNow) {
        // A long turn is not a stuck one: report it done and let the session
        // finish where its own user can watch it.
        settleMission(mission, 'completed');
        return;
      }
      settleMission(mission, 'failed', { error: 'The session never reported a running turn within the mission watch window' });
    }, Math.max(1, config.maxRunMs)));
  };

  const spawnSessionMission = async (mission) => {
    const client = clientFor(mission.directory);
    // Session options are built statement by statement: an absent model or
    // agent stays absent, never a present-but-empty guess.
    const createOptions = {
      title: mission.title,
      location: { directory: mission.directory },
      metadata: { openchamber: { mission: { id: mission.missionId, version: 1 } } },
    };
    if (mission.model) {
      createOptions.model = { id: mission.model.split('/')[1] ?? mission.model, providerID: mission.model.split('/')[0] };
    }
    if (mission.agent) {
      createOptions.agent = mission.agent;
    }
    const session = await client.session.create(createOptions);
    const sessionId = asNonEmptyString(session?.id);
    if (!sessionId) throw new MissionError('OpenCode created no session for the mission', 502);
    mission.sessionId = sessionId;
    schedulePersist();
    const dispatch = { prompt: mission.prompt, directory: mission.directory };
    if (mission.model) dispatch.model = mission.model;
    if (mission.agent) dispatch.agent = mission.agent;
    await sessionService.send(sessionId, dispatch);
  };

  const spawnTeamMission = async (mission) => {
    const result = await teamService.createFromUi({
      name: mission.title,
      directory: mission.directory,
      description: mission.title,
      // One member — the lead. The mission's prompt is its first task, which
      // the lead starts alone; teammates are added later if the goal needs
      // them, from the team page like any other team.
      members: [{ name: 'Lead', isLead: true }],
      task: mission.prompt,
    });
    mission.teamId = result?.team?.id ?? null;
    mission.sessionId = result?.leadSessionId ?? null;
    schedulePersist();
    if (!mission.sessionId) throw new MissionError('The team was created but its lead session is unknown', 502);
  };

  const runMission = async (mission) => {
    mission.status = 'running';
    mission.startedAt = now();
    mission.error = null;
    mission.sessionId = null;
    mission.teamId = null;
    schedulePersist();
    broadcast('updated', mission.missionId);
    claimedSlots.add(mission.missionId);
    try {
      await waitForOpenCodeReady(10_000, 250);
      if (mission.mode === 'team') {
        await spawnTeamMission(mission);
      } else {
        await spawnSessionMission(mission);
      }
      broadcast('updated', mission.missionId);
      watchMission(mission);
    } catch (error) {
      const message = error instanceof MissionError
        ? error.message
        : `Failed to start the mission: ${error?.message ?? error}`;
      console.warn('[missions] run failed:', message);
      settleMission(mission, 'failed', { error: message });
    }
  };

  const drainQueue = () => {
    // Within one synchronous pass the queue order is creation order; a slot
    // freed by a settled mission admits the oldest queued mission. The
    // limit is read live, so a config change drains (or stops admitting)
    // on the same pass.
    for (const mission of missions) {
      if (claimedSlots.size >= config.maxConcurrent) return;
      if (mission.status !== 'queued') continue;
      void runMission(mission);
    }
  };

  const createMission = async (input) => {
    await load();
    const parsed = parseCreateInput(input);
    const mission = {
      missionId: `mission_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      ...parsed,
      status: 'queued',
      sessionId: null,
      teamId: null,
      error: null,
      createdAt: now(),
      startedAt: null,
      finishedAt: null,
    };
    missions.push(mission);
    if (missions.length > MAX_MISSIONS) missions = missions.slice(-MAX_MISSIONS);
    schedulePersist();
    broadcast('created', mission.missionId);
    drainQueue();
    return { mission: serializeMission(mission) };
  };

  const listMissions = async () => {
    await load();
    // Newest first: the list's own order is what the panel shows.
    return missions.map(serializeMission).reverse();
  };

  const getMissionConfig = async () => {
    await load();
    return { ...config };
  };

  /**
   * The queue's settings: how many lanes run at once and how long a watch
   * waits. A new maxConcurrent admits queued missions on the same pass; a
   * lower one only stops admissions — running missions are not cancelled.
   * A new maxRunMs arms the watches started after it; running watches keep
   * the window they were armed with.
   */
  const updateMissionConfig = async (input) => {
    await load();
    const next = parseConfigInput(input);
    Object.assign(config, next);
    schedulePersist();
    broadcast('config', null);
    drainQueue();
    return { config: { ...config } };
  };

  const cancelMission = async (missionId) => {
    await load();
    const mission = getMission(asNonEmptyString(missionId));
    if (!mission) throw new MissionError(`No mission with id '${missionId}'`, 404);
    if (mission.status !== 'queued' && mission.status !== 'running') {
      throw new MissionError(`A ${mission.status} mission cannot be cancelled`, 400);
    }
    // Cancel stops the mission's claim on the queue, not the session it
    // started: a running turn keeps going where its user can stop it from.
    settleMission(mission, 'cancelled');
    return { mission: serializeMission(mission) };
  };

  const retryMission = async (missionId) => {
    await load();
    const mission = getMission(asNonEmptyString(missionId));
    if (!mission) throw new MissionError(`No mission with id '${missionId}'`, 404);
    if (mission.status !== 'failed' && mission.status !== 'cancelled' && mission.status !== 'completed') {
      throw new MissionError(`A ${mission.status} mission cannot be retried`, 400);
    }
    clearMissionTimers(mission);
    mission.status = 'queued';
    mission.error = null;
    mission.sessionId = null;
    mission.teamId = null;
    mission.startedAt = null;
    mission.finishedAt = null;
    schedulePersist();
    broadcast('updated', mission.missionId);
    drainQueue();
    return { mission: serializeMission(mission) };
  };

  const deleteMission = async (missionId) => {
    await load();
    const mission = getMission(asNonEmptyString(missionId));
    if (!mission) throw new MissionError(`No mission with id '${missionId}'`, 404);
    clearMissionTimers(mission);
    claimedSlots.delete(mission.missionId);
    missions = missions.filter((candidate) => candidate !== mission);
    schedulePersist();
    broadcast('deleted', mission.missionId);
    drainQueue();
    return { mission: serializeMission(mission) };
  };

  const init = async () => {
    await load();
  };

  return {
    init,
    createMission,
    listMissions,
    getMissionConfig,
    updateMissionConfig,
    cancelMission,
    retryMission,
    deleteMission,
  };
};

export { MissionError };
