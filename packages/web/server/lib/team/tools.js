/**
 * Team Mode: actions of the `openchamber_team` managed tool.
 *
 * The tool lets an agent run a small team of peer sessions: it becomes the
 * Team Lead, spawns Teammate sessions as children of its own, hands out work
 * over a shared mailbox and task board, and collects the results. Teammates
 * answer through the same tool; role permissions are enforced here, per
 * action, at execution time (the model sees the full action list either way).
 *
 * Names follow the `team.` prefix so a bare name sent by the model resolves
 * inside this set alone.
 */

export const TEAM_ACTION_DEFINITIONS = Object.freeze([
  {
    action: 'team.start',
    title: 'Start a team led by this session',
    leadOnly: false,
    description: 'Make this session the Team Lead of a new team working in this directory. Optional name labels the team and description says what it is for. The result carries your Team Lead briefing; read it before any other team action. Use only when the user explicitly asks for a team, several agents working together on one goal',
  },
  {
    action: 'team.members',
    title: 'List team members',
    leadOnly: false,
    description: 'List all team members with their roles and current status; no parameters. Call it before delegating, spawning, dismissing or referring to teammates',
  },
  {
    action: 'team.read_messages',
    title: 'Read your team mailbox',
    leadOnly: false,
    description: 'Peek at your own unread team messages, oldest first, at most 50 per call; optional sinceMessageId continues after a truncated page. Messages a call returns are marked read only when this turn completes successfully: a failed or cancelled turn keeps them for a later retry. Call once before finishing a turn, and again before assigning work or replying, so you do not act on stale information',
  },
  {
    action: 'team.send_message',
    title: 'Send a team message',
    leadOnly: false,
    description: 'Send a message to one teammate slotId, or broadcast it to every member with to="*"; requires to and message. Wakes the recipient. Teammates report to the Team Lead this way; the exact text shutdown_approved approves a shutdown request and shutdown_rejected: <reason> refuses one',
  },
  {
    action: 'team.task_create',
    title: 'Create a team task',
    leadOnly: false,
    description: 'Add a task to the shared board; requires subject, optional description, owner (a teammate slotId) and blockedBy (task ids that must finish first). Assigning an owner notifies and wakes that teammate with the task details, so no separate message is needed to hand work off',
  },
  {
    action: 'team.task_update',
    title: 'Update a team task',
    leadOnly: false,
    description: 'Update a board task; requires taskId, optional status (pending, in_progress, completed, deleted), description or owner. The owner of a task marks it in_progress when starting and completed when done',
  },
  {
    action: 'team.task_list',
    title: 'List team tasks',
    leadOnly: false,
    description: 'List board tasks, newest first; optional owner or status filters. Pass nothing for the full board',
  },
  {
    action: 'team.list_assistants',
    title: 'List spawnable assistants',
    leadOnly: false,
    description: 'List the agents available for spawning as teammates, with their ids, names and what each is for; no parameters. Use the real ids here; do not guess from names like build or plan',
  },
  {
    action: 'team.describe_assistant',
    title: 'Describe one assistant',
    leadOnly: false,
    description: 'Read one agent in detail before proposing it as a teammate; requires the agent id from team.list_assistants',
  },
  {
    action: 'team.spawn_agent',
    title: 'Spawn a teammate',
    leadOnly: true,
    description: 'Spawn a new teammate session in this team directory; requires a display name and an agent id from team.list_assistants, optional model in provider/model format (omit for the default). Propose the lineup to the user first and wait for their approval in a later message before calling it, unless the user already approved it, the user asked you to create a specific teammate immediately',
  },
  {
    action: 'team.rename_agent',
    title: 'Rename a teammate',
    leadOnly: true,
    description: 'Rename a team member; requires slotId and a new name. The new name appears in the roster and the session list',
  },
  {
    action: 'team.interrupt_agent',
    title: 'Interrupt a teammate',
    leadOnly: true,
    description: 'Stop a teammate\'s active turn at once and deliver a replacement instruction as its next message; requires slotId and message. Use when the plan changed and the teammate must not finish what it is doing',
  },
  {
    action: 'team.shutdown_agent',
    title: 'Dismiss a teammate',
    leadOnly: true,
    description: 'Ask a teammate to shut down; requires slotId, optional reason. Sends a formal shutdown request the teammate approves or refuses; the session stays readable for the user afterwards. Use it whenever the user asks to dismiss, fire, remove or shut down a member',
  },
]);

export const TEAM_ACTIONS = Object.freeze(TEAM_ACTION_DEFINITIONS.map(({ action }) => action));

const TEAM_ACTION_NAMES = new Set(TEAM_ACTIONS);

const LEAD_ONLY_ACTIONS = new Set(
  TEAM_ACTION_DEFINITIONS.filter(({ leadOnly }) => leadOnly === true).map(({ action }) => action),
);

export const isLeadOnlyTeamAction = (action) => LEAD_ONLY_ACTIONS.has(action);

/**
 * The action name this tool asked for: models drop namespaces, and the answer
 * has to say what this set actually contains rather than a bare "unsupported".
 */
export const resolveTeamAction = (requested) => {
  const value = typeof requested === 'string' ? requested.trim() : '';
  const prefixed = value.startsWith('team.') || value === 'team'
    ? value
    : value
      ? `team.${value}`
      : '';
  if (TEAM_ACTION_NAMES.has(prefixed)) return { action: prefixed };
  return {
    error: `Unsupported team action: ${value || 'missing'}. Use one of: ${TEAM_ACTIONS.join(', ')}`,
  };
};

/**
 * One schema carrying only the inputs team actions use. Field names arrive
 * camelCase from the model (both shapes are accepted by the plugin shim), and
 * descriptions stay reserved for behavior a name cannot convey.
 */
export const TEAM_PARAMETER_PROPERTIES = Object.freeze({
  name: { type: 'string', description: 'Display name of the team (team.start) or of the new teammate (team.spawn_agent)' },
  description: { type: 'string', description: 'What the team is for (team.start) or the task details (team.task_create, team.task_update)' },
  agent: { type: 'string', description: 'Agent id from team.list_assistants; spawn only' },
  model: { type: 'string', description: 'Model in provider/model format for the new teammate; omit for the default; spawn only' },
  slotId: { type: 'string', description: 'The member a role action targets, from team.members; use slotId values for every member target, never display names' },
  newName: { type: 'string', description: 'The new name; team.rename_agent only' },
  to: { type: 'string', description: 'Recipient slotId, or "*" for every member; team.send_message only' },
  message: { type: 'string', description: 'The message text; team.send_message or team.interrupt_agent' },
  reason: { type: 'string', description: 'Why; team.shutdown_agent only, optional' },
  sinceMessageId: { type: 'string', description: 'Continue reading after a truncated page; team.read_messages only, optional' },
  subject: { type: 'string', description: 'One-line task title; team.task_create only' },
  taskId: { type: 'string', description: 'The task to update, from team.task_list; team.task_update only' },
  status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'deleted'], description: 'Board status; team.task_update only' },
  owner: { type: 'string', description: 'slotId the task is assigned to; task actions only' },
  blockedBy: { type: 'array', items: { type: 'string' }, description: 'Task ids that must finish before this one starts; team.task_create only' },
});
