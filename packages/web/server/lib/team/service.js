import { resolveTeamAction, isLeadOnlyTeamAction, TEAM_DOMAIN_IDS } from './tools.js';
import {
  buildLeadBriefing,
  buildTeammateBriefing,
  buildWakePayload,
} from './prompts.js';

/**
 * Team Mode service.
 *
 * One team = one lead session plus teammate sessions spawned as its children
 * (parentID), all in the lead session's directory. Coordination state — the
 * roster, the mailbox, the task board — lives here, persisted atomically as
 * `<data-dir>/teams.json`, and reaches the agents only through the
 * `openchamber_team` tool. Teammate sessions being children of the lead makes
 * the existing Subagents panel show each member's live status, running time
 * and failures with no extra UI.
 *
 * Turn semantics follow AionUi's Team Mode: waking a member delivers its
 * unread mail as one prompt; a message counts as read only when the turn that
 * received it ends successfully, so a failed or cancelled turn keeps it queued
 * for a retry; a teammate that finishes a turn with something for the lead
 * drops an idle notification into the lead's mailbox and wakes the lead.
 *
 * A busy member is never prompted directly — a wake stacks as `pendingWake`
 * and dispatches on the idle event, so each request in Flight stays one.
 */

const STATE_FILE_NAME = 'teams.json';
const PERSIST_DEBOUNCE_MS = 250;
const MAX_TEAMS = 50;
const MAX_MAILBOX_PER_TEAM = 300;
const MAX_TASKS_PER_TEAM = 500;
// Matches AionUi: an open turn beyond the provider's request window is
// treated as a failed member rather than left hanging as "busy".
const MEMBER_STALL_TIMEOUT_MS = 300_000;
const WATCHDOG_INTERVAL_MS = 30_000;

const PEEK_PAGE_SIZE = 50;

const SLOT_LEADER = 'lead';
const SHUTDOWN_APPROVED = 'shutdown_approved';

const MEMBER_STATUSES = new Set(['starting', 'busy', 'idle', 'failed', 'shut_down']);

// Sub-teams: an area label a teammate carries plus one lead per area. A
// domain member reports to its domain lead, the domain lead aggregates and
// reports to the Team Lead. One team, one board — the domain is a chain of
// command, not separate state.
const TEAM_DOMAINS = new Set(TEAM_DOMAIN_IDS);

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const asList = (value) => (Array.isArray(value) ? value : []);

export class TeamError extends Error {
  constructor(message, statusCode = 500, details = null) {
    super(message);
    this.statusCode = statusCode;
    if (details) this.details = details;
  }
}

const shortId = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

const isPrimaryAgentMode = (mode) => !mode || mode === 'primary' || mode === 'all';

/**
 * Sanitized persisted state: only fields `JSON.stringify` can round-trip live
 * on the record; the runtime index and in-flight flags never hit the disk.
 */
const serializeMember = (member) => ({
  slotId: member.slotId,
  name: member.name,
  role: member.role,
  domain: TEAM_DOMAINS.has(member.domain) ? member.domain : null,
  isDomainLead: member.isDomainLead === true,
  sessionId: member.sessionId,
  agent: member.agent ?? null,
  model: member.model ?? null,
  brief: member.brief ?? null,
  status: MEMBER_STATUSES.has(member.status) ? member.status : 'idle',
  removed: member.removed === true,
  deliveredIds: asList(member.deliveredIds).slice(-200),
  producedForLeader: member.producedForLeader === true,
  // Tool allowances chosen in the "New Team" dialog; they survive a restart
  // so the roster keeps showing what the member was configured with.
  skills: asList(member.skills),
  mcpServers: asList(member.mcpServers),
});

const serializeTeam = (team) => ({
  id: team.id,
  name: team.name,
  description: team.description ?? null,
  directory: team.directory,
  createdAt: team.createdAt,
  members: team.members.map(serializeMember),
  mailbox: asList(team.mailbox).map((message) => ({
    id: message.id,
    to: message.to,
    from: message.from,
    type: message.type,
    content: message.content,
    summary: message.summary ?? null,
    read: message.read === true,
    createdAt: message.createdAt,
  })),
  tasks: asList(team.tasks).map((task) => ({
    taskId: task.taskId,
    subject: task.subject,
    description: task.description ?? null,
    status: task.status,
    owner: task.owner ?? null,
    blockedBy: asList(task.blockedBy),
    createdBy: task.createdBy ?? null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  })),
});

export const createTeamService = (dependencies) => {
  const {
    fsPromises,
    path,
    dataDir,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    waitForOpenCodeReady,
    createOpenCodeClient,
    // The shared session service owns validated prompt dispatch (model/agent
    // resolution, snippet expansion, command parsing); team wake-ups and
    // briefings go through it so teammates behave like any dispatched session.
    sessionService,
    now = Date.now,
    broadcastUiEvent = null,
  } = dependencies;

  if (typeof sessionService?.send !== 'function') {
    throw new Error('team service needs a session service with send()');
  }

  const stateFilePath = path.join(dataDir, STATE_FILE_NAME);
  const clientFor = (directory) => createOpenCodeClient({
    baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
    headers: getOpenCodeAuthHeaders(),
    directory,
  });

  /** @type {Array<object>} */
  let teams = [];
  let loaded = false;
  let loadPromise = null;
  let persistTimer = null;
  let watchdogTimer = null;

  // sessionId → { teamId, slotId }; rebuilt from persisted state on load and
  // kept in sync by spawn/remove. Every event of every session pays one Map
  // lookup here, so the orchestrator never iterates all teams.
  const sessionIndex = new Map();

  const indexTeam = (team) => {
    for (const member of team.members) {
      if (member.sessionId) sessionIndex.set(member.sessionId, { teamId: team.id, slotId: member.slotId });
    }
  };

  const load = async () => {
    if (loaded) return;
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      try {
        const raw = await fsPromises.readFile(stateFilePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.teams)) {
          teams = parsed.teams.slice(-MAX_TEAMS).map((team) => ({
            ...team,
            members: asList(team.members).map((member) => ({
              ...member,
              // A server restart cannot trust a persisted "busy": the turn it
              // described is gone. Idle lets the next event correct it.
              status: member.status === 'busy' ? 'idle' : (MEMBER_STATUSES.has(member.status) ? member.status : 'idle'),
            })),
            mailbox: asList(team.mailbox),
            tasks: asList(team.tasks),
          }));
          teams.forEach(indexTeam);
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          console.warn('[team] could not load state, starting empty:', error?.message ?? error);
        }
        teams = [];
      }
      loaded = true;
    })();
    return loadPromise;
  };

  const persist = async () => {
    const payload = JSON.stringify({ schemaVersion: 1, teams: teams.map(serializeTeam) });
    const temporary = `${stateFilePath}.tmp`;
    await fsPromises.mkdir(dataDir, { recursive: true });
    await fsPromises.writeFile(temporary, payload, { mode: 0o600 });
    await fsPromises.rename(temporary, stateFilePath);
  };

  const schedulePersist = () => {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persist().catch((error) => console.warn('[team] state write failed:', error?.message ?? error));
    }, PERSIST_DEBOUNCE_MS);
  };

  const broadcast = (type, properties) => {
    if (typeof broadcastUiEvent !== 'function') return;
    try {
      broadcastUiEvent({ type, properties });
    } catch {
      // The control stream is best-effort for team state; a dropped frame is
      // repaired by the next one.
    }
  };

  const getTeam = (teamId) => teams.find((team) => team.id === teamId) ?? null;

  const findMembership = async (sessionId) => {
    await load();
    const entry = sessionIndex.get(sessionId);
    if (!entry) return null;
    const team = getTeam(entry.teamId);
    if (!team) return null;
    const member = team.members.find((candidate) => candidate.slotId === entry.slotId);
    if (!member) return null;
    // A dismissed member keeps its history readable but no longer acts.
    if (member.removed) throw new TeamError('This session was dismissed from its team', 409);
    return { team, member };
  };

  const inboxOf = (team, member) => team.mailbox
    .filter((message) => message.to === member.slotId && message.read !== true)
    .sort((left, right) => left.createdAt - right.createdAt);

  const trimTeamState = (team) => {
    if (team.mailbox.length > MAX_MAILBOX_PER_TEAM) {
      const unread = team.mailbox.filter((message) => message.read !== true);
      const excess = team.mailbox.length - MAX_MAILBOX_PER_TEAM;
      if (unread.length < team.mailbox.length - excess) {
        // Read mail is history nobody rereads; unread is work in flight and
        // only drops when the cap leaves no other way down.
        team.mailbox = team.mailbox
          .filter((message) => message.read === true)
          .slice(excess)
          .concat(unread);
      } else {
        team.mailbox = team.mailbox.slice(excess);
      }
    }
    if (team.tasks.length > MAX_TASKS_PER_TEAM) {
      team.tasks = team.tasks
        .filter((task) => task.status === 'deleted')
        .concat(team.tasks.filter((task) => task.status !== 'deleted'))
        .slice(0, MAX_TASKS_PER_TEAM);
    }
  };

  const pushMessage = (team, { to, from, type = 'message', content, summary = null }) => {
    const message = {
      id: shortId('msg'),
      to,
      from,
      type,
      content,
      summary,
      read: false,
      createdAt: now(),
    };
    team.mailbox.push(message);
    trimTeamState(team);
    schedulePersist();
    broadcast('openchamber:team-mailbox', {
      teamId: team.id,
      change: 'created',
      message: { id: message.id, to: message.to, from: message.from, type: message.type },
    });
    return message;
  };

  /**
   * Wake one member with its unread mail. Busy → pendingWake, dispatched at
   * the idle event; that keeps one prompt in flight per member.
   */
  const wakeMember = async (team, member) => {
    const unread = inboxOf(team, member);
    if (unread.length === 0 && member.pendingWake !== true) return false;
    if (member.status === 'busy' || member.status === 'starting') {
      member.pendingWake = true;
      return false;
    }
    member.pendingWake = false;
    member.deliveredIds = Array.from(new Set([
      ...asList(member.deliveredIds),
      ...unread.map((message) => message.id),
    ]));
    const prompt = buildWakePayload({ team, member, messages: unread, tasks: team.tasks, reportTo: reportToMember(team, member) });
    try {
      await sessionService.send(member.sessionId, { prompt, directory: team.directory });
      member.status = 'busy';
      member.lastActivityAt = now();
      schedulePersist();
      return true;
    } catch (error) {
      // An undeliverable wake must not strand the delivery state: unread
      // stays unread, so a later wake retries the whole batch.
      member.deliveredIds = member.deliveredIds.filter((id) => !unread.some((message) => message.id === id));
      member.status = 'failed';
      throw error;
    }
  };

  const notifyLead = async (team, { type = 'idle_notification', content, summary = null, from }) => {
    const lead = team.members.find((member) => member.slotId === SLOT_LEADER);
    if (!lead) return;
    pushMessage(team, { to: lead.slotId, from, type, content, summary });
    await wakeMember(team, lead).catch(() => {});
  };

  /**
   * The domain chain's report channel: a member that produced something
   * announces it to its domain lead when it has one, else to the Team Lead.
   * Failures and stalls stay Team Lead news via notifyLead — staffing and
   * dismissal are lead-only actions.
   */
  const notifyReporter = async (team, member, { type = 'idle_notification', content, summary = null } = {}) => {
    const target = reportToMember(team, member)
      ?? team.members.find((candidate) => candidate.slotId === SLOT_LEADER);
    if (!target || target.removed) return;
    pushMessage(team, { to: target.slotId, from: member.slotId, type, content, summary });
    await wakeMember(team, target).catch(() => {});
  };

  const activeMembers = (team) => team.members.filter((member) => member.removed !== true && member.slotId !== SLOT_LEADER);

  /** The active lead of a sub-team domain, or null when the domain has none. */
  const domainLeadOf = (team, domain) => (
    TEAM_DOMAINS.has(domain)
      ? team.members.find((entry) => (
        entry.domain === domain && entry.isDomainLead === true
        && entry.removed !== true && entry.slotId !== SLOT_LEADER
      )) ?? null
      : null
  );

  /**
   * Reads domain input: an unknown or missing domain is nothing, and leading
   * a domain requires belonging to it. Returns the normalized pair.
   */
  const normalizeDomainInput = (input) => {
    const domain = TEAM_DOMAINS.has(input?.domain) ? input.domain : null;
    return { domain, isDomainLead: domain !== null && input?.isDomainLead === true };
  };

  const lineupDomainLeads = (memberInputs) => {
    const seen = new Set();
    for (const entry of memberInputs) {
      if (!entry.isDomainLead || !entry.domain) continue;
      if (seen.has(entry.domain)) {
        throw new TeamError(`two members are marked as the lead of the '${entry.domain}' sub-team`, 400);
      }
      seen.add(entry.domain);
    }
  };

  /**
   * Where a member's reports go: a domain member with an active domain lead
   * reports there; everybody else — straight to the Team Lead.
   */
  const reportToMember = (team, member) => {
    if (member.role !== 'teammate' || member.isDomainLead === true) return null;
    const domainLead = domainLeadOf(team, member.domain);
    return domainLead && domainLead.slotId !== member.slotId ? domainLead : null;
  };

  const touchActivity = (team, member) => {
    member.lastActivityAt = now();
  };

  const markDeliveredRead = (team, member) => {
    const ids = new Set(asList(member.deliveredIds));
    for (const message of team.mailbox) {
      if (message.to === member.slotId && ids.has(message.id)) message.read = true;
    }
    member.deliveredIds = [];
  };

  /**
   * Turn end for a member: successful turns consume their delivered mail,
   * aborted or errored turns keep it queued for the retry (AionUi semantics);
   * then a stacked wake dispatches, and a teammate that produced something
   * for the lead tells the lead it is their turn to synthesize.
   */
  const onMemberTurnEnd = async (team, member, { aborted = false, failed = false } = {}) => {
    member.status = failed ? 'failed' : 'idle';
    if (!aborted && !failed) {
      markDeliveredRead(team, member);
    } else {
      // Redelivery next wake: forget the delivery claim but keep them unread.
      member.deliveredIds = [];
    }
    const producedForLead = member.producedForLeader === true;
    member.producedForLeader = false;
    schedulePersist();
    if (producedForLead && member.role !== 'lead') {
      await notifyReporter(team, member, {
        content: `${member.name} finished a turn with something for you. Read your mailbox (team.read_messages) and decide the next step.`,
        summary: summaryOf(team, member),
      }).catch(() => {});
    }
    if (member.pendingWake === true) {
      await wakeMember(team, member).catch(() => {});
    }
    broadcast('openchamber:team-status', {
      teamId: team.id,
      slotId: member.slotId,
      status: member.status,
    });
  };

  const summaryOf = (team, member) => {
    const last = team.mailbox
      .filter((message) => message.from === member.slotId && message.type === 'message')
      .at(-1);
    return asNonEmptyString(last?.content)?.slice(0, 160) ?? null;
  };

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const actionStart = async (input, _membership, contextSessionId) => {
    // A session belongs to at most one team; a dismissed lead may start fresh.
    if (sessionIndex.has(contextSessionId)) {
      throw new TeamError('This session already belongs to a team. Use team.members and team.read_messages.', 409);
    }
    await waitForOpenCodeReady(10_000, 250).catch(() => {});
    const client = clientFor('');
    const info = await client.session.get({ sessionID: contextSessionId })
      .catch(() => { throw new TeamError('Could not read this session from OpenCode', 503); });
    const directory = asNonEmptyString(info?.directory) || asNonEmptyString(info?.location?.directory);
    if (!directory) throw new TeamError('Could not resolve this session\'s directory', 500);

    const team = {
      id: shortId('team'),
      name: asNonEmptyString(input.name) || `Team ${info?.title || 'session'}`.slice(0, 80),
      description: asNonEmptyString(input.description) || null,
      directory,
      createdAt: now(),
      members: [],
      mailbox: [],
      tasks: [],
    };
    const lead = {
      slotId: SLOT_LEADER,
      name: asNonEmptyString(input.leadName) || 'Team Lead',
      role: 'lead',
      sessionId: contextSessionId,
      agent: null,
      model: null,
      brief: null,
      status: 'idle',
      removed: false,
      deliveredIds: [],
      producedForLeader: false,
      pendingWake: false,
      lastActivityAt: now(),
    };
    team.members.push(lead);
    teams.push(team);
    if (teams.length > MAX_TEAMS) teams = teams.slice(-MAX_TEAMS);
    indexTeam(team);
    schedulePersist();
    broadcast('openchamber:team-created', { teamId: team.id, name: team.name });
    return {
      team: { id: team.id, name: team.name, directory: team.directory },
      briefing: buildLeadBriefing({ team, lead: team.members[0] }),
    };
  };

  /**
   * Session permission rules for a configured member: the selection reads as
   * an allow-list, expressed against the default-allow base policy. Skills
   * gate under the `skill` action with the skill name as resource; an MCP
   * server gates as the `<server>_*` action OpenCode matches against every
   * tool that server exposes. An empty selection means "no narrowing": the
   * user picked nothing to restrict, not "deny everything".
   */
  const composeToolPermissionRules = ({ skills, mcpServers }, allServerNames) => {
    const rules = [];
    const selectedSkills = asList(skills).map((entry) => asNonEmptyString(entry)).filter(Boolean);
    if (selectedSkills.length > 0) {
      rules.push({ action: 'skill', resource: '*', effect: 'deny' });
      for (const skill of selectedSkills) {
        rules.push({ action: 'skill', resource: skill, effect: 'allow' });
      }
    }
    const selectedServers = new Set(asList(mcpServers).map((entry) => asNonEmptyString(entry)).filter(Boolean));
    if (selectedServers.size > 0) {
      for (const server of asList(allServerNames)) {
        if (!selectedServers.has(server)) rules.push({ action: `${server}_*`, resource: '*', effect: 'deny' });
      }
    }
    return rules;
  };

  /**
   * Create a team from the app UI ("New Team"): the lead becomes a fresh
   * session the user chats with, teammates are its children like in the agent
   * tool flow. Unlike `team.start`, nobody has to call a tool first — the
   * roster is fixed at creation and every member receives its briefing right
   * away. The lead's briefing carries the user's first task when there is
   * one; otherwise it tells the lead to wait for the user's message.
   */
  const createFromUi = async (input) => {
    await load();
    const name = asNonEmptyString(input?.name);
    if (!name) throw new TeamError('name is required: the team name', 400);
    const directory = asNonEmptyString(input?.directory);
    if (!directory) throw new TeamError('directory is required: where the team works', 400);

    const memberInputs = asList(input?.members).map((entry) => ({
      name: asNonEmptyString(entry?.name),
      agent: asNonEmptyString(entry?.agent),
      model: asNonEmptyString(entry?.model),
      brief: asNonEmptyString(entry?.brief),
      skills: asList(entry?.skills).map((skill) => asNonEmptyString(skill)).filter(Boolean),
      mcpServers: asList(entry?.mcpServers).map((server) => asNonEmptyString(server)).filter(Boolean),
      isLead: entry?.isLead === true,
      ...normalizeDomainInput(entry),
    }));
    if (memberInputs.length === 0) throw new TeamError('at least one member is required', 400);
    if (memberInputs.some((entry) => !entry.name)) throw new TeamError('every member needs a name', 400);
    if (memberInputs.length > 10) throw new TeamError('a team cannot exceed 10 members', 400);
    if (memberInputs.some((entry) => entry.isLead && !entry.name)) throw new TeamError('the team lead needs a name', 400);
    const seenNames = new Set();
    for (const entry of memberInputs) {
      if (seenNames.has(entry.name)) throw new TeamError(`two members are named '${entry.name}'`, 400);
      seenNames.add(entry.name);
    }
    const flaggedLeads = memberInputs.filter((entry) => entry.isLead);
    if (flaggedLeads.length > 1) throw new TeamError('only one member can be the team lead', 400);
    // One sub-team, one lead — checked before any session is paid for.
    lineupDomainLeads(memberInputs);
    const leadInput = flaggedLeads[0] ?? memberInputs[0];
    // The Team Lead leads the team, not a sub-team: its domain fields are
    // input noise, never a shape the roster should record.
    leadInput.domain = null;
    leadInput.isDomainLead = false;
    const teammateInputs = memberInputs.filter((entry) => entry !== leadInput);

    await waitForOpenCodeReady(10_000, 250).catch(() => {});
    const { agents, models, client } = await fetchAgentCatalog(directory);
    for (const entry of memberInputs) {
      if (!entry.agent || agents.length === 0) continue;
      const known = agents.find((candidate) => candidate?.id === entry.agent);
      if (!known) throw new TeamError(`Unknown agent '${entry.agent}' for member '${entry.name}'`, 400);
      if (!isPrimaryAgentMode(known.mode)) {
        throw new TeamError(`Agent '${entry.agent}' is a subagent and cannot run member '${entry.name}'`, 400);
      }
    }
    if (models.length > 0) {
      for (const entry of memberInputs) {
        if (!entry.model) continue;
        const [providerID, modelID] = entry.model.split('/');
        if (!modelID || !models.some((candidate) => candidate?.providerID === providerID && candidate?.modelID === modelID)) {
          throw new TeamError(`Unknown model '${entry.model}' for member '${entry.name}'. Use provider/model.`, 400);
        }
      }
    }
    // The gate is a deny-list over the servers this instance actually knows,
    // so a member may keep everything except what the user deselected.
    const serverNames = await listMcpServerNames(client, directory);

    const team = {
      id: shortId('team'),
      name: name.slice(0, 80),
      description: asNonEmptyString(input?.description) || null,
      directory,
      createdAt: now(),
      members: [],
      mailbox: [],
      tasks: [],
    };

    const createMemberSession = async ({ memberName, slotId, role, agent, model, skills, mcpServers, parentID }) => {
      const session = await client.session.create({
        ...(parentID ? { parentID } : {}),
        title: parentID ? `${team.name} · ${memberName}`.slice(0, 120) : team.name,
        location: { directory },
        ...(agent ? { agent } : {}),
        ...(model ? { model: { id: model.split('/')[1] ?? model, providerID: model.split('/')[0] } } : {}),
        metadata: { openchamber: { team: { id: team.id, version: 1, slotId, role, name: memberName } } },
        permissions: composeToolPermissionRules({ skills, mcpServers }, serverNames),
      }).catch((error) => {
        throw new TeamError(`OpenCode did not create the ${role === 'lead' ? 'lead' : 'member'} session for '${memberName}': ${error?.message ?? error}`, 502);
      });
      const sessionId = asNonEmptyString(session?.id);
      if (!sessionId) throw new TeamError(`OpenCode created no session for '${memberName}'`, 502);
      return sessionId;
    };

    const leadSessionId = await createMemberSession({
      memberName: leadInput.name || 'Team Lead',
      slotId: SLOT_LEADER,
      role: 'lead',
      agent: leadInput.agent,
      model: leadInput.model,
      skills: leadInput.skills,
      mcpServers: leadInput.mcpServers,
    });

    const lead = {
      slotId: SLOT_LEADER,
      name: leadInput.name || 'Team Lead',
      role: 'lead',
      sessionId: leadSessionId,
      agent: leadInput.agent,
      model: leadInput.model,
      brief: leadInput.brief,
      skills: leadInput.skills,
      mcpServers: leadInput.mcpServers,
      status: 'starting',
      removed: false,
      deliveredIds: [],
      producedForLeader: false,
      pendingWake: false,
      lastActivityAt: now(),
    };
    team.members.push(lead);
    teams.push(team);
    if (teams.length > MAX_TEAMS) teams = teams.slice(-MAX_TEAMS);
    indexTeam(team);
    schedulePersist();
    broadcast('openchamber:team-created', { teamId: team.id, name: team.name });

    // Sub-team leads are created first so a domain member's parent session —
    // its domain lead — exists by the time the member is created.
    const orderedTeammates = [
      ...teammateInputs.filter((entry) => entry.isDomainLead === true),
      ...teammateInputs.filter((entry) => entry.isDomainLead !== true),
    ];
    const domainLeadSessionIds = new Map();

    for (const entry of orderedTeammates) {
      const slotId = shortId('member');
      let sessionId = null;
      try {
        sessionId = await createMemberSession({
          memberName: entry.name,
          slotId,
          role: 'teammate',
          agent: entry.agent,
          model: entry.model,
          skills: entry.skills,
          mcpServers: entry.mcpServers,
          // A domain member's session nests under its domain lead, so the
          // lead's session must exist first — orderedTeammates guarantees that.
          parentID: (!entry.isDomainLead && entry.domain && domainLeadSessionIds.get(entry.domain)) || leadSessionId,
        });
        if (entry.isDomainLead && sessionId) domainLeadSessionIds.set(entry.domain, sessionId);
      } catch (error) {
        // A member whose session the provider refused to create stays on the
        // roster as failed: the team and the rest of the lineup survive.
        console.warn('[team] UI creation: member session failed:', error?.message ?? error);
      }
      const teammate = {
        slotId,
        name: entry.name,
        role: 'teammate',
        domain: entry.domain,
        isDomainLead: entry.isDomainLead === true,
        sessionId,
        agent: entry.agent,
        model: entry.model,
        brief: entry.brief,
        skills: entry.skills,
        mcpServers: entry.mcpServers,
        status: sessionId ? 'starting' : 'failed',
        removed: false,
        deliveredIds: [],
        producedForLeader: false,
        pendingWake: false,
        lastActivityAt: now(),
      };
      team.members.push(teammate);
      if (sessionId) sessionIndex.set(sessionId, { teamId: team.id, slotId });
    }
    schedulePersist();

    // Briefings go last, through the shared dispatch, exactly like the tool
    // flow sends them on spawn; one failed briefing marks that member failed
    // without unwinding the team the user just paid to create.
    const firstTask = asNonEmptyString(input?.task);
    const leadPrompt = firstTask
      ? `${buildLeadBriefing({ team, lead })}\n\n## First Task From The User\n${firstTask}\nStart with it now: delegate per your roster, or do it yourself when the user asked you specifically.`
      : `${buildLeadBriefing({ team, lead })}\n\nThe team was created from the app and no task was given yet. Introduce yourself in one short sentence, say you are ready, and end your turn; the user's next message is your first task.`;
    try {
      await sessionService.send(leadSessionId, {
        prompt: leadPrompt,
        directory,
        ...(leadInput.model ? { model: leadInput.model } : {}),
        ...(leadInput.agent ? { agent: leadInput.agent } : {}),
      });
      lead.status = 'busy';
      lead.lastActivityAt = now();
    } catch (error) {
      console.warn('[team] UI creation: lead briefing failed:', error?.message ?? error);
      lead.status = 'failed';
    }

    for (const member of team.members) {
      if (member.slotId === SLOT_LEADER || !member.sessionId) continue;
      const briefing = `${buildTeammateBriefing({ team, member, lead, brief: member.brief, reportTo: reportToMember(team, member) })}\n\nThe team was created from the app before any task was given. Do not invent work: acknowledge readiness in ONE short sentence and end your turn; your first task arrives as a wake-up message.`;
      try {
        await sessionService.send(member.sessionId, {
          prompt: briefing,
          directory,
          ...(member.model ? { model: member.model } : {}),
          ...(member.agent ? { agent: member.agent } : {}),
        });
        member.status = 'busy';
        member.lastActivityAt = now();
      } catch (error) {
        console.warn('[team] UI creation: member briefing failed:', error?.message ?? error);
        member.status = 'failed';
      }
      broadcast('openchamber:team-members', { teamId: team.id, change: 'spawned', slotId: member.slotId });
    }
    schedulePersist();

    return {
      team: { id: team.id, name: team.name, directory: team.directory },
      leadSessionId,
      members: team.members.map((member) => ({
        slotId: member.slotId,
        name: member.name,
        role: member.role,
        domain: member.domain ?? null,
        isDomainLead: member.isDomainLead === true,
        status: member.status,
      })),
    };
  };

  /** MCP server names of this instance, for the per-member permission gate. */
  const listMcpServerNames = async (client, directory) => {
    try {
      const response = await client.mcp?.list?.({ location: { directory } });
      return asList(response?.data).map((server) => asNonEmptyString(server?.name)).filter(Boolean);
    } catch {
      // No server catalog means no server-specific rules; the member keeps
      // whatever its agent's own permissions allow.
      return [];
    }
  };

  const fetchAgentCatalog = async (directory) => {
    await waitForOpenCodeReady(10_000, 250).catch(() => {});
    const client = clientFor(directory);
    const [agents, models] = await Promise.all([
      client.agent.list().then((response) => asList(response?.data)).catch(() => []),
      client.model.list().then((response) => asList(response?.data)).catch(() => []),
    ]);
    return { agents, models, client };
  };

  const actionListAssistants = async (_input, membership) => {
    const { team } = membership;
    const { agents } = await fetchAgentCatalog(team.directory);
    const spawnable = agents
      .filter((agent) => isPrimaryAgentMode(agent?.mode) && agent?.hidden !== true)
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        mode: agent.mode ?? 'primary',
        description: agent.description ?? null,
      }));
    if (spawnable.length === 0) {
      throw new TeamError('No spawnable agents were found in this OpenCode instance', 503);
    }
    return { assistants: spawnable };
  };

  const actionDescribeAssistant = async (input, membership) => {
    const { team } = membership;
    const agentId = asNonEmptyString(input.agent);
    if (!agentId) throw new TeamError('agent is required: an agent id from team.list_assistants', 400);
    const { agents } = await fetchAgentCatalog(team.directory);
    const agent = agents.find((candidate) => candidate?.id === agentId)
      ?? agents.find((candidate) => candidate?.name === agentId);
    if (!agent) throw new TeamError(`Unknown agent '${agentId}'. Use team.list_assistants for the real ids.`, 400);
    return {
      agent: {
        id: agent.id,
        name: agent.name,
        mode: agent.mode ?? 'primary',
        description: agent.description ?? null,
        // The prompt shows what the agent actually does; it is the closest
        // thing to a "skills" section the v2 catalog offers.
        prompt: String(agent.prompt ?? '').slice(0, 2_000) || null,
      },
      hint: `Propose this agent as a teammate by id '${agent.id}', then call team.spawn_agent with the approved name and this id after the user confirms.`,
    };
  };

  const actionSpawnAgent = async (input, membership) => {
    const { team, member } = membership;
    const name = asNonEmptyString(input.name);
    if (!name) throw new TeamError('name is required: the teammate\'s display name', 400);
    const agent = asNonEmptyString(input.agent) || 'build';
    const model = asNonEmptyString(input.model);
    const { domain, isDomainLead } = normalizeDomainInput(input);
    if (isDomainLead) {
      const existing = domainLeadOf(team, domain);
      if (existing) throw new TeamError(`'${existing.name}' already leads the '${domain}' sub-team`, 409);
    }

    const { agents, models, client } = await fetchAgentCatalog(team.directory);
    if (agents.length > 0) {
      const entry = agents.find((candidate) => candidate?.id === agent);
      if (!entry) throw new TeamError(`Unknown agent '${agent}'. Use team.list_assistants for the real ids.`, 400);
      if (!isPrimaryAgentMode(entry.mode)) {
        throw new TeamError(`Agent '${agent}' is a subagent and cannot run a session of its own`, 400);
      }
    }
    if (model && models.length > 0) {
      const [providerID, modelID] = model.split('/');
      if (!modelID || !models.some((entry) => entry?.providerID === providerID && entry?.modelID === modelID)) {
        throw new TeamError(`Unknown model '${model}'. Use provider/model format from the catalog.`, 400);
      }
    }
    if (activeMembers(team).some((entry) => entry.name === name)) {
      throw new TeamError(`A teammate named '${name}' already exists in this team`, 409);
    }
    if (activeMembers(team).length >= 10) {
      throw new TeamError('This team already has the maximum of 10 teammates', 409);
    }

    const lead = team.members.find((entry) => entry.slotId === SLOT_LEADER) ?? member;
    const slotId = shortId('member');
    const title = `${team.name} · ${name}`.slice(0, 120);
    // A domain member nests under its domain lead's session when one exists; a
    // domain lead (or an unassigned teammate) nests under the lead.
    const domainLead = isDomainLead ? null : domainLeadOf(team, domain);
    const parentID = domainLead?.sessionId ?? lead.sessionId;
    const session = await client.session.create({
      parentID,
      title,
      location: { directory: team.directory },
      metadata: { openchamber: { team: { id: team.id, version: 1, slotId, role: 'teammate', name } } },
    }).catch((error) => {
      throw new TeamError(`OpenCode did not create the teammate session: ${error?.message ?? error}`, 502);
    });
    const sessionId = asNonEmptyString(session?.id);
    if (!sessionId) throw new TeamError('OpenCode created no teammate session', 502);

    const teammate = {
      slotId,
      name,
      role: 'teammate',
      domain,
      isDomainLead,
      sessionId,
      agent,
      model: model || null,
      brief: asNonEmptyString(input.brief) || null,
      status: 'starting',
      removed: false,
      deliveredIds: [],
      producedForLeader: false,
      pendingWake: false,
      lastActivityAt: now(),
    };
    team.members.push(teammate);
    sessionIndex.set(sessionId, { teamId: team.id, slotId });
    schedulePersist();

    // The briefing is the teammate's first prompt: identity, rules, the lead's
    // slot id. Sent through the shared dispatch so model/agent validation and
    // snippet expansion behave like any other send.
    const briefing = buildTeammateBriefing({ team, member: teammate, lead, brief: teammate.brief, reportTo: reportToMember(team, teammate) });
    try {
      await sessionService.send(sessionId, {
        prompt: briefing,
        directory: team.directory,
        ...(model ? { model } : {}),
        agent,
      });
      teammate.status = 'busy';
      teammate.lastActivityAt = now();
    } catch (error) {
      teammate.status = 'failed';
      schedulePersist();
      throw new TeamError(`The teammate session was created but its briefing did not dispatch: ${error?.message ?? error}`, 502);
    }

    broadcast('openchamber:team-members', { teamId: team.id, change: 'spawned', slotId });
    return {
      member: {
        slotId: teammate.slotId,
        name: teammate.name,
        role: teammate.role,
        domain: teammate.domain,
        isDomainLead: teammate.isDomainLead,
        status: teammate.status,
      },
      note: `${name} joined the team and received its briefing.${domain ? ` It belongs to the '${domain}' sub-team${isDomainLead ? ' and leads it' : ''}.` : ''} It appears under the Subagents panel of its parent session; assign work with team.task_create (owner) or team.send_message.`,
    };
  };

  const requireSlot = (team, slotId, { allowLead = false } = {}) => {
    const record = team.members.find((candidate) => candidate.slotId === slotId);
    if (!record || (record.removed && record.slotId !== SLOT_LEADER)) {
      throw new TeamError(`No team member with slotId '${slotId}'. Call team.members for the roster.`, 404);
    }
    if (record.slotId === SLOT_LEADER && !allowLead) {
      throw new TeamError('The Team Lead cannot be the target of this action', 400);
    }
    return record;
  };

  const actionSendMessage = async (input, membership) => {
    const { team, member } = membership;
    const to = asNonEmptyString(input.to);
    const message = asNonEmptyString(input.message);
    if (!to) throw new TeamError('to is required: a slotId from team.members, or "*" for the whole team', 400);
    if (!message) throw new TeamError('message is required', 400);

    const reportTo = reportToMember(team, member);

    // The shutdown handshake rides on ordinary mail: an exact approval line
    // from a teammate retires the member, a refusal is delivered as-is. The
    // reply goes wherever the briefing said — the domain lead for domain
    // members, the Team Lead for the rest.
    if (member.role === 'teammate' && message.trim() === SHUTDOWN_APPROVED
      && (to === SLOT_LEADER || (reportTo && to === reportTo.slotId))) {
      member.removed = true;
      member.status = 'shut_down';
      schedulePersist();
      broadcast('openchamber:team-members', { teamId: team.id, change: 'shut_down', slotId: member.slotId });
    }

    // The teammate has produced something for its reporting lead: its turn end
    // drops an idle notification there (the lead was also woken by the message
    // itself; this is the "I am done" half of the contract).
    if (member.role === 'teammate' && (to === SLOT_LEADER || (reportTo && to === reportTo.slotId))) member.producedForLeader = true;
    if (member.role === 'teammate' && to === '*') {
      const lead = team.members.find((candidate) => candidate.slotId === SLOT_LEADER);
      if (lead && lead.slotId !== member.slotId) member.producedForLeader = true;
    }

    const targets = to === '*'
      ? team.members.filter((candidate) => candidate.removed !== true && candidate.slotId !== member.slotId)
      : [requireSlot(team, to, { allowLead: true })];
    for (const target of targets) {
      pushMessage(team, { to: target.slotId, from: member.slotId, content: message });
    }
    for (const target of targets) {
      if (target.slotId !== member.slotId) await wakeMember(team, target).catch(() => {});
    }
    schedulePersist();
    return {
      deliveredTo: targets.map((target) => target.slotId),
      note: 'The recipient wakes with this message delivered in its wake prompt. Messages are marked read when the receiving turn completes successfully.',
    };
  };

  const actionReadMessages = async (input, membership) => {
    const { team, member } = membership;
    const unread = inboxOf(team, member);
    const since = asNonEmptyString(input.sinceMessageId);
    const startIndex = since
      ? Math.max(0, unread.findIndex((message) => message.id === since))
      : 0;
    const page = unread.slice(startIndex, startIndex + PEEK_PAGE_SIZE);
    const hasMore = unread.length > startIndex + page.length;
    member.deliveredIds = Array.from(new Set([...asList(member.deliveredIds), ...page.map((message) => message.id)]));
    schedulePersist();
    return {
      messages: page.map((message) => ({
        id: message.id,
        from: message.from,
        type: message.type,
        content: message.content,
        createdAt: message.createdAt,
      })),
      hasMore,
      nextSinceMessageId: hasMore ? (page.at(-1)?.id ?? null) : null,
      note: 'These messages are marked read only when your current turn ends successfully; a failed or cancelled turn keeps them for retry.',
    };
  };

  const actionMembers = async (_input, membership) => {
    const { team } = membership;
    return {
      members: team.members
        .filter((candidate) => candidate.removed !== true || candidate.slotId === SLOT_LEADER)
        .map((candidate) => ({
          slotId: candidate.slotId,
          name: candidate.name,
          role: candidate.role,
          domain: candidate.domain ?? null,
          isDomainLead: candidate.isDomainLead === true,
          status: candidate.removed ? 'shut_down' : candidate.status,
        })),
    };
  };

  const actionRenameAgent = async (input, membership) => {
    const { team } = membership;
    const slotId = asNonEmptyString(input.slotId);
    const newName = asNonEmptyString(input.newName);
    if (!slotId) throw new TeamError('slotId is required', 400);
    if (!newName) throw new TeamError('newName is required', 400);
    const record = requireSlot(team, slotId);
    record.name = newName.slice(0, 80);
    try {
      await clientFor(team.directory).session.update({
        sessionID: record.sessionId,
        title: `${team.name} · ${record.name}`.slice(0, 120),
      });
    } catch {
      // A failed retitling must not fail the rename itself.
    }
    schedulePersist();
    return { member: { slotId: record.slotId, name: record.name } };
  };

  const actionInterruptAgent = async (input, membership) => {
    const { team } = membership;
    const slotId = asNonEmptyString(input.slotId);
    const message = asNonEmptyString(input.message);
    if (!slotId) throw new TeamError('slotId is required', 400);
    if (!message) throw new TeamError('message is required: the replacement instruction', 400);
    const record = requireSlot(team, slotId);
    pushMessage(team, { to: record.slotId, from: membership.member.slotId, content: message });
    if (record.status === 'busy') {
      record.pendingWake = true;
      try {
        await clientFor(team.directory).session.interrupt({ sessionID: record.sessionId });
      } catch (error) {
        throw new TeamError(`Could not interrupt '${record.name}': ${error?.message ?? error}`, 502);
      }
      return { interrupted: true, note: `${record.name}'s turn was stopped; the replacement instruction is queued and delivers on its next wake.` };
    }
    await wakeMember(team, record).catch(() => {});
    return { interrupted: false, note: `${record.name} was idle; the instruction was delivered as its next wake.` };
  };

  /** The shared shutdown-request delivery for the lead tool and the app UI. */
  const requestShutdown = async (team, fromSlotId, record, reason) => {
    pushMessage(team, {
      to: record.slotId,
      from: fromSlotId,
      type: 'shutdown_request',
      content: 'The Team Lead is asking you to shut down. Reply with exactly shutdown_approved to the lead slot_id to agree, or shutdown_rejected: <reason> to refuse.',
      summary: reason || null,
    });
    await wakeMember(team, record).catch(() => {});
    broadcast('openchamber:team-members', { teamId: team.id, change: 'shutdown_requested', slotId: record.slotId });
  };

  const actionShutdownAgent = async (input, membership) => {
    const { team, member } = membership;
    const slotId = asNonEmptyString(input.slotId);
    if (!slotId) throw new TeamError('slotId is required', 400);
    const record = requireSlot(team, slotId);
    await requestShutdown(team, member.slotId, record, asNonEmptyString(input.reason));
    return {
      requested: true,
      note: 'A shutdown request was delivered. The teammate approves with a shutdown_approved message (its session stays readable) or refuses with a reason; you will hear back either way.',
    };
  };

  /**
   * The "Edit team" flow: add a teammate to a live roster from the app. Walks
   * the same path as the lead's spawn tool plus the creation dialog's tool
   * allowances, and the domain logic: a domain member nests under its domain
   * lead when one is active, reports go through the chain.
   */
  const addMemberFromUi = async ({ teamId, input }) => {
    await load();
    const team = getTeam(asNonEmptyString(teamId));
    if (!team) throw new TeamError(`No team with id '${teamId}'`, 404);
    const lead = team.members.find((entry) => entry.slotId === SLOT_LEADER);
    if (!lead?.sessionId) throw new TeamError('The lead session of this team is gone', 409);

    const name = asNonEmptyString(input?.name);
    if (!name) throw new TeamError('name is required: the teammate\'s display name', 400);
    const agent = asNonEmptyString(input?.agent);
    const model = asNonEmptyString(input?.model);
    const skills = asList(input?.skills).map((skill) => asNonEmptyString(skill)).filter(Boolean);
    const mcpServers = asList(input?.mcpServers).map((server) => asNonEmptyString(server)).filter(Boolean);
    const { domain, isDomainLead } = normalizeDomainInput(input);
    if (isDomainLead) {
      const existing = domainLeadOf(team, domain);
      if (existing) throw new TeamError(`'${existing.name}' already leads the '${domain}' sub-team`, 409);
    }
    if (activeMembers(team).some((entry) => entry.name === name)) {
      throw new TeamError(`A teammate named '${name}' already exists in this team`, 409);
    }
    if (activeMembers(team).length >= 10) {
      throw new TeamError('This team already has the maximum of 10 teammates', 409);
    }

    await waitForOpenCodeReady(10_000, 250).catch(() => {});
    const { agents, models, client } = await fetchAgentCatalog(team.directory);
    if (agent && agents.length > 0) {
      const entry = agents.find((candidate) => candidate?.id === agent);
      if (!entry) throw new TeamError(`Unknown agent '${agent}' for member '${name}'`, 400);
      if (!isPrimaryAgentMode(entry.mode)) {
        throw new TeamError(`Agent '${agent}' is a subagent and cannot run a session of its own`, 400);
      }
    }
    if (model && models.length > 0) {
      const [providerID, modelID] = model.split('/');
      if (!modelID || !models.some((entry) => entry?.providerID === providerID && entry?.modelID === modelID)) {
        throw new TeamError(`Unknown model '${model}' for member '${name}'. Use provider/model.`, 400);
      }
    }

    const domainLead = isDomainLead ? null : domainLeadOf(team, domain);
    const parentID = domainLead?.sessionId ?? lead.sessionId;
    const slotId = shortId('member');
    const serverNames = await listMcpServerNames(client, team.directory);
    const session = await client.session.create({
      parentID,
      title: `${team.name} · ${name}`.slice(0, 120),
      location: { directory: team.directory },
      ...(agent ? { agent } : {}),
      ...(model ? { model: { id: model.split('/')[1] ?? model, providerID: model.split('/')[0] } } : {}),
      metadata: { openchamber: { team: { id: team.id, version: 1, slotId, role: 'teammate', name } } },
      permissions: composeToolPermissionRules({ skills, mcpServers }, serverNames),
    }).catch((error) => {
      throw new TeamError(`OpenCode did not create the teammate session: ${error?.message ?? error}`, 502);
    });
    const sessionId = asNonEmptyString(session?.id);
    if (!sessionId) throw new TeamError('OpenCode created no teammate session', 502);

    const teammate = {
      slotId,
      name,
      role: 'teammate',
      domain,
      isDomainLead,
      sessionId,
      agent: agent || null,
      model: model || null,
      brief: asNonEmptyString(input?.brief) || null,
      skills,
      mcpServers,
      status: 'starting',
      removed: false,
      deliveredIds: [],
      producedForLeader: false,
      pendingWake: false,
      lastActivityAt: now(),
    };
    team.members.push(teammate);
    sessionIndex.set(sessionId, { teamId: team.id, slotId });
    schedulePersist();

    const briefing = buildTeammateBriefing({ team, member: teammate, lead, brief: teammate.brief, reportTo: reportToMember(team, teammate) });
    try {
      await sessionService.send(sessionId, {
        prompt: briefing,
        directory: team.directory,
        ...(model ? { model } : {}),
        ...(agent ? { agent } : {}),
      });
      teammate.status = 'busy';
      teammate.lastActivityAt = now();
    } catch (error) {
      teammate.status = 'failed';
      schedulePersist();
      throw new TeamError(`The teammate session was created but its briefing did not dispatch: ${error?.message ?? error}`, 502);
    }

    broadcast('openchamber:team-members', { teamId: team.id, change: 'spawned', slotId });
    return {
      member: {
        slotId: teammate.slotId,
        name: teammate.name,
        role: teammate.role,
        domain: teammate.domain,
        isDomainLead: teammate.isDomainLead,
        status: teammate.status,
      },
    };
  };

  /** The "Edit team" dismissal: the lead handshake, requested by the user. */
  const shutdownMemberFromUi = async ({ teamId, slotId, reason }) => {
    await load();
    const team = getTeam(asNonEmptyString(teamId));
    if (!team) throw new TeamError(`No team with id '${teamId}'`, 404);
    const record = team.members.find((candidate) => candidate.slotId === asNonEmptyString(slotId));
    if (!record || record.removed) {
      throw new TeamError(`No active member with slotId '${slotId}'`, 404);
    }
    if (record.slotId === SLOT_LEADER) throw new TeamError('The Team Lead cannot be dismissed', 400);
    await requestShutdown(team, SLOT_LEADER, record, asNonEmptyString(reason));
    return { requested: true };
  };

  const actionTaskCreate = async (input, membership) => {
    const { team, member } = membership;
    const subject = asNonEmptyString(input.subject);
    if (!subject) throw new TeamError('subject is required', 400);
    const owner = asNonEmptyString(input.owner);
    if (owner && owner === SLOT_LEADER) {
      throw new TeamError('Tasks belong to teammates; the lead coordinates the board', 400);
    }
    if (owner) requireSlot(team, owner);
    const blockedBy = asList(input.blockedBy).map(String).filter(Boolean);
    for (const taskId of blockedBy) {
      if (!team.tasks.some((task) => task.taskId === taskId)) {
        throw new TeamError(`blockedBy references unknown task '${taskId}'`, 400);
      }
    }
    const task = {
      taskId: shortId('task'),
      subject: subject.slice(0, 200),
      description: asNonEmptyString(input.description) || null,
      status: 'pending',
      owner: owner || null,
      blockedBy,
      createdBy: member.slotId,
      createdAt: now(),
      updatedAt: now(),
    };
    team.tasks.push(task);
    trimTeamState(team);
    schedulePersist();
    broadcast('openchamber:team-task', { teamId: team.id, change: 'created', taskId: task.taskId });
    if (owner) {
      const record = requireSlot(team, owner);
      // An assignment is itself the notification: the mailbox entry wakes the
      // owner with the task details, so no separate hand-off is needed.
      const details = [task.subject, asNonEmptyString(task.description)].filter(Boolean).join('\n');
      pushMessage(team, {
        to: record.slotId,
        from: member.slotId,
        type: 'task_assignment',
        content: `Task assigned to you: ${details}`,
        summary: task.subject,
      });
      await wakeMember(team, record).catch(() => {});
    }
    return {
      task: { taskId: task.taskId, subject: task.subject, status: task.status, owner: task.owner, blockedBy: task.blockedBy },
      note: owner
        ? 'The owner was notified and woken with this task. Do not send a separate message just to hand it off.'
        : 'The task is on the board with no owner; assign it with team.task_update (owner) when you decide.',
    };
  };

  const actionTaskUpdate = async (input, membership) => {
    const { team, member } = membership;
    const taskId = asNonEmptyString(input.taskId);
    if (!taskId) throw new TeamError('taskId is required', 400);
    const task = team.tasks.find((candidate) => candidate.taskId === taskId && candidate.status !== 'deleted');
    if (!task) throw new TeamError(`No task '${taskId}' on the board. Call team.task_list.`, 404);
    const owner = asNonEmptyString(input.owner);
    if (owner) requireSlot(team, owner);
    if (owner === SLOT_LEADER) throw new TeamError('Tasks belong to teammates; the lead coordinates the board', 400);
    const status = asNonEmptyString(input.status);
    if (status && !['pending', 'in_progress', 'completed', 'deleted'].includes(status)) {
      throw new TeamError('status must be one of pending, in_progress, completed, deleted', 400);
    }
    const description = asNonEmptyString(input.description);
    if (description) task.description = description;
    if (owner) task.owner = owner;
    if (status) task.status = status;
    task.updatedAt = now();
    // A teammate finishing its own task is a deliverable even when it forgets
    // the report message: the member's turn end notifies the lead either way.
    if (member.role === 'teammate'
      && task.owner === member.slotId
      && (status === 'completed' || status === 'deleted')) {
      member.producedForLeader = true;
    }
    schedulePersist();
    broadcast('openchamber:team-task', { teamId: team.id, change: 'updated', taskId: task.taskId });
    if (owner && task.owner !== member.slotId) {
      const record = requireSlot(team, task.owner);
      // Reassignment notifies like assignment does: the mailbox entry carries
      // the change to the new owner and wakes it.
      const details = [task.subject, asNonEmptyString(task.description)].filter(Boolean).join('\n');
      pushMessage(team, {
        to: record.slotId,
        from: member.slotId,
        type: 'task_assignment',
        content: `Task assigned to you: ${details}`,
        summary: task.subject,
      });
      await wakeMember(team, record).catch(() => {});
    }
    return { task: { taskId: task.taskId, subject: task.subject, status: task.status, owner: task.owner } };
  };

  const actionTaskList = async (input, membership) => {
    const { team } = membership;
    const owner = asNonEmptyString(input.owner);
    const status = asNonEmptyString(input.status);
    let tasks = team.tasks.filter((task) => task.status !== 'deleted');
    if (owner) tasks = tasks.filter((task) => task.owner === owner);
    if (status) tasks = tasks.filter((task) => task.status === status);
    tasks = tasks.slice().sort((left, right) => right.createdAt - left.createdAt);
    return {
      tasks: tasks.map((task) => ({
        taskId: task.taskId,
        subject: task.subject,
        description: task.description,
        status: task.status,
        owner: task.owner,
        blockedBy: task.blockedBy,
      })),
    };
  };

  const ACTION_HANDLERS = new Map([
    ['team.start', actionStart],
    ['team.members', actionMembers],
    ['team.list_assistants', actionListAssistants],
    ['team.describe_assistant', actionDescribeAssistant],
    ['team.spawn_agent', actionSpawnAgent],
    ['team.rename_agent', actionRenameAgent],
    ['team.interrupt_agent', actionInterruptAgent],
    ['team.shutdown_agent', actionShutdownAgent],
    ['team.send_message', actionSendMessage],
    ['team.read_messages', actionReadMessages],
    ['team.task_create', actionTaskCreate],
    ['team.task_update', actionTaskUpdate],
    ['team.task_list', actionTaskList],
  ]);

  /**
   * One team action, called from the agent-tool callback. team.start is the
   * only action a session outside a team may call; every other action is
   * checked against the roster and lead-only actions against the role, per
   * call, because every session in the process can see the tool.
   */
  const executeAction = async (action, input = {}, contextSessionId, options = {}) => {
    const handler = ACTION_HANDLERS.get(action);
    if (!handler) throw new TeamError(`Unsupported team action: ${action}`, 400);
    let membership = null;
    if (action !== 'team.start') {
      membership = await findMembership(contextSessionId);
      if (!membership) throw new TeamError('This session is not part of a team. Start one with team.start.', 404);
      if (isLeadOnlyTeamAction(action) && membership.member.role !== 'lead') {
        throw new TeamError('Only the Team Lead can use this action', 403);
      }
    }
    const data = await handler(input, membership, contextSessionId, options);
    const { signal } = options;
    if (signal?.aborted) throw new TeamError('Team action was cancelled', 499);
    return data;
  };

  // ---------------------------------------------------------------------------
  // Event orchestration
  // ---------------------------------------------------------------------------

  const membershipOfEvent = async (sessionId) => {
    await load();
    const entry = sessionIndex.get(sessionId);
    if (!entry) return null;
    const team = getTeam(entry.teamId);
    const member = team?.members.find((candidate) => candidate.slotId === entry.slotId);
    if (!team || !member || member.removed) return null;
    return { team, member };
  };

  /**
   * One translated OpenCode event, from the same subscription every other
   * orchestrator reads. Cheap for unrelated sessions: one Map lookup.
   */
  const processPayload = async (payload) => {
    const sessionId = asNonEmptyString(payload?.properties?.sessionID);
    if (!sessionId) return;
    const membership = await membershipOfEvent(sessionId);
    if (!membership) return;
    const { team, member } = membership;
    touchActivity(team, member);

    switch (payload.type) {
      case 'session.status': {
        const status = payload.properties?.status?.type ?? payload.properties?.info?.type;
        if (status === 'busy' && member.status !== 'busy') {
          member.status = 'busy';
          member.lastActivityAt = now();
          schedulePersist();
          broadcast('openchamber:team-status', { teamId: team.id, slotId: member.slotId, status: 'busy' });
        } else if (status === 'idle' && member.status === 'starting') {
          // The briefing turn of a fresh teammate never emits its own
          // session.idle through this path on every version; a status event is
          // authoritative enough to stop showing it as starting.
          member.status = 'idle';
          schedulePersist();
        }
        return;
      }
      case 'session.idle': {
        const aborted = payload.properties?.aborted === true;
        await onMemberTurnEnd(team, member, { aborted });
        return;
      }
      case 'session.error': {
        const message = payload.properties?.error?.message ?? 'turn failed';
        member.status = 'failed';
        schedulePersist();
        broadcast('openchamber:team-status', { teamId: team.id, slotId: member.slotId, status: 'failed' });
        await notifyLead(team, {
          from: member.slotId,
          content: `${member.name} failed: ${message}. The failed turn's unread messages stay queued; reassign or interrupt, or dismiss the member with team.shutdown_agent.`,
        }).catch(() => {});
        return;
      }
      case 'session.deleted': {
        if (member.slotId === SLOT_LEADER) {
          // The lead session is the user's; deleting it ends the team.
          team.members.forEach((candidate) => { candidate.removed = true; });
          schedulePersist();
          return;
        }
        member.removed = true;
        member.status = 'shut_down';
        schedulePersist();
        broadcast('openchamber:team-members', { teamId: team.id, change: 'removed', slotId: member.slotId });
        await notifyLead(team, {
          from: member.slotId,
          content: `${member.name}'s session was deleted and the member left the team.`,
        }).catch(() => {});
        return;
      }
      default:
        return;
    }
  };

  /**
   * The stall watchdog: a busy member with no event for the provider's
   * request window is failed, not "busy forever".
   */
  const startWatchdog = () => {
    if (watchdogTimer) return;
    watchdogTimer = setInterval(() => {
      const check = async (team, member) => {
        if (member.status !== 'busy' || member.removed) return;
        if (!Number.isFinite(member.lastActivityAt)) return;
        if (now() - member.lastActivityAt < MEMBER_STALL_TIMEOUT_MS) return;
        member.status = 'failed';
        schedulePersist();
        broadcast('openchamber:team-status', { teamId: team.id, slotId: member.slotId, status: 'failed' });
        await notifyLead(team, {
          from: member.slotId,
          content: `${member.name} went silent beyond the ${Math.round(MEMBER_STALL_TIMEOUT_MS / 1000)}s request window and was marked failed. Interrupt it with a new instruction (team.interrupt_agent), or dismiss it (team.shutdown_agent).`,
        }).catch(() => {});
      };
      for (const team of teams) {
        for (const member of team.members) void check(team, member);
      }
    }, WATCHDOG_INTERVAL_MS);
    if (typeof watchdogTimer.unref === 'function') watchdogTimer.unref();
  };

  const init = async () => {
    await load();
    startWatchdog();
  };

  return {
    init,
    processPayload,
    executeAction,
    /** Entry point for teams the user creates from the app, not from a tool. */
    createFromUi,
    /** The "Edit team" flow: change a live roster from the app itself. */
    addMemberFromUi,
    shutdownMemberFromUi,
    resolveTeamAction,
    /**
     * Test seam: the persisted state as the disk round-trip would render it,
     * including runtime-only flags folded back to their persisted shapes.
     */
    snapshot: async () => {
      await load();
      return teams.map(serializeTeam);
    },
    /**
     * The team board as the work-status panel reads it: roster with unread
     * counts, the live task board, and the last page of the mailbox with
     * clipped content. Nothing here is secret from the client side; the
     * sessions themselves are ordinary sessions the user already owns.
     */
    overview: async () => {
      await load();
      return teams.map((team) => {
        const unreadBySlot = new Map();
        for (const message of team.mailbox) {
          if (message.read === true) continue;
          unreadBySlot.set(message.to, (unreadBySlot.get(message.to) ?? 0) + 1);
        }
        return {
          id: team.id,
          name: team.name,
          directory: team.directory,
          createdAt: team.createdAt,
          members: team.members
            .filter((member) => member.removed !== true || member.slotId === SLOT_LEADER)
            .map((member) => ({
              slotId: member.slotId,
              name: member.name,
              role: member.role,
              domain: member.domain ?? null,
              isDomainLead: member.isDomainLead === true,
              status: member.removed ? 'shut_down' : member.status,
              sessionId: member.sessionId,
              unreadCount: unreadBySlot.get(member.slotId) ?? 0,
            })),
          tasks: team.tasks
            .filter((task) => task.status !== 'deleted')
            .map((task) => ({
              taskId: task.taskId,
              subject: task.subject,
              // The board's card tooltip reads the brief; older clients
              // without the field keep working because they only parse.
              description: task.description ?? null,
              status: task.status,
              owner: task.owner,
              blockedBy: asList(task.blockedBy),
              createdBy: task.createdBy ?? null,
              createdAt: task.createdAt,
              updatedAt: task.updatedAt,
            })),
          recentMessages: team.mailbox.slice(-100).map((message) => ({
            id: message.id,
            to: message.to,
            from: message.from,
            type: message.type,
            content: String(message.content ?? '').slice(0, 400),
            createdAt: message.createdAt,
          })),
        };
      });
    },
    /** Test seam: drain the debounced write so disk state is settled now. */
    flush: async () => {
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      if (loaded) await persist();
    },
  };
};
