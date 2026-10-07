// The host's team-board route, `/api/openchamber/teams`, as the work-status
// panel calls it. Every answer is parsed here, once, into the types the section
// renders; a shape the server did not send fails the fetch rather than putting
// half-typed rows on the panel. The contract is the Team Mode section of
// `packages/web/server/lib/team/DOCUMENTATION.md`.

import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';

const TEAM_BOARD_ROUTE = '/api/openchamber/teams';

export const teamMemberStatusSchema = z.enum(['starting', 'busy', 'idle', 'failed', 'shut_down']);
export type TeamMemberStatus = z.infer<typeof teamMemberStatusSchema>;

// One list with the server: sub-team areas a member can belong to. One lead
// per domain; a domain member reports to its lead instead of the Team Lead.
export const TEAM_DOMAIN_IDS = ['analytics', 'development', 'review', 'qa'] as const;
export type TeamDomain = (typeof TEAM_DOMAIN_IDS)[number];

// The i18n key of each area's display label, shared by the editors, the
// roster rows and the board.
export const TEAM_DOMAIN_LABEL_KEYS = {
  analytics: 'team.domain.analytics',
  development: 'team.domain.development',
  review: 'team.domain.review',
  qa: 'team.domain.qa',
} as const;

export const teamDomainSchema = z.enum(TEAM_DOMAIN_IDS);

export const teamTaskStatusSchema = z.enum(['pending', 'in_progress', 'completed']);
export type TeamTaskStatus = z.infer<typeof teamTaskStatusSchema>;

export const teamMemberSchema = z.object({
  slotId: z.string(),
  name: z.string(),
  role: z.enum(['lead', 'teammate']),
  status: teamMemberStatusSchema,
  // Sub-team fields carry the domain chain; catch nulls for servers that
  // predate the concept, the same tolerance `description` uses. Nullish:
  // a server answer may omit them entirely.
  domain: teamDomainSchema.nullish().catch(null),
  isDomainLead: z.boolean().nullish().catch(false),
  // Teammates are ordinary sessions; opening one from the panel needs this.
  sessionId: z.string(),
  unreadCount: z.number().int().min(0),
});

const teamTaskSchema = z.object({
  taskId: z.string(),
  subject: z.string(),
  // The lead's brief for the task; full text on the board's card tooltip.
  // Nullish, not required: the running server may predate the field.
  description: z.string().nullish(),
  status: teamTaskStatusSchema,
  // A slotId, not a display name; the board joins it to the roster client-side.
  owner: z.string().nullable(),
  blockedBy: z.array(z.string()),
  // Same nullish tolerance as `description`.
  createdBy: z.string().nullish(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const teamMessageSchema = z.object({
  id: z.string(),
  to: z.string(),
  from: z.string(),
  type: z.string(),
  content: z.string(),
  createdAt: z.number(),
});

// One page of the activity feed: the merged mailbox and task streams. The
// server pages through exactly the state it retains; the cursor is opaque.
const teamActivityEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('message'),
    id: z.string(),
    at: z.number(),
    from: z.string(),
    to: z.string(),
    type: z.string(),
    content: z.string(),
    summary: z.string().nullable(),
    read: z.boolean(),
  }),
  z.object({
    kind: z.literal('task'),
    id: z.string(),
    at: z.number(),
    taskId: z.string(),
    subject: z.string(),
    status: teamTaskStatusSchema,
    owner: z.string().nullable(),
    createdAt: z.number(),
  }),
]);

const teamActivityPageSchema = z.object({
  teamId: z.string(),
  events: z.array(teamActivityEventSchema),
  nextCursor: z.string().nullable(),
});export const teamBoardSchema = z.object({
  id: z.string(),
  name: z.string(),
  directory: z.string(),
  createdAt: z.number(),
  members: z.array(teamMemberSchema),
  tasks: z.array(teamTaskSchema),
  recentMessages: z.array(teamMessageSchema),
});

export type TeamMember = z.infer<typeof teamMemberSchema>;
export type TeamTask = z.infer<typeof teamTaskSchema>;
export type TeamMessage = z.infer<typeof teamMessageSchema>;
export type TeamBoard = z.infer<typeof teamBoardSchema>;
export type TeamActivityEvent = z.infer<typeof teamActivityEventSchema>;
export type TeamActivityPage = z.infer<typeof teamActivityPageSchema>;

type FetchTeamBoards = (fetchImpl?: typeof runtimeFetch) => Promise<TeamBoard[]>;

/**
 * Every team the server knows. The panel belongs to one session, and which
 * team that is stays a client-side lookup on the roster, so the request needs
 * no parameters and the section can follow the session without refetching.
 */
export const fetchTeamBoards: FetchTeamBoards = async (fetchImpl = runtimeFetch) => {
  const response = await fetchImpl(TEAM_BOARD_ROUTE, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`Team board request failed: ${response.status}`);
  }
  const body = await response.json().catch(() => null);
  const parsed = z.object({ teams: z.array(teamBoardSchema) }).safeParse(body);
  if (!parsed.success) {
    throw new Error('Team board response did not match the expected shape');
  }
  return parsed.data.teams;
};

/**
 * One page of a team's activity feed, newest first. Pass the previous page's
 * `nextCursor` as `before` to walk into retained history until the cursor
 * comes back null. The same strict parse as the board: a shape the server
 * did not send fails the fetch rather than putting half-typed rows in the
 * feed.
 */
export const fetchTeamActivity = async (
  teamId: string,
  options: { before?: string; limit?: number; fetchImpl?: typeof runtimeFetch } = {},
): Promise<TeamActivityPage> => {
  const fetchImpl = options.fetchImpl ?? runtimeFetch;
  const search = new URLSearchParams();
  if (options.before !== undefined) search.set('before', options.before);
  if (options.limit !== undefined) search.set('limit', String(options.limit));
  const query = search.size > 0 ? `?${search.toString()}` : '';
  const response = await fetchImpl(`${TEAM_BOARD_ROUTE}/${encodeURIComponent(teamId)}/activity${query}`, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Team activity request failed: ${response.status}`);
  }
  const body = await response.json().catch(() => null);
  const parsed = teamActivityPageSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error('Team activity response did not match the expected shape');
  }
  return parsed.data;
};

/**
 * One task the user adds to the board from the panel. The board refetches
 * through the team-changed signal the creation broadcast already carried, so
 * the caller needs the failure, not the created row: a thrown error names
 * the server's reason, a resolved promise means the task is on the board.
 */
export const createTeamTask = async (
  teamId: string,
  input: { subject: string; description?: string; owner?: string },
  fetchImpl: typeof runtimeFetch = runtimeFetch,
): Promise<void> => {
  const response = await fetchImpl(`${TEAM_BOARD_ROUTE}/${encodeURIComponent(teamId)}/tasks`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const parsedError = z.object({ error: z.string() }).safeParse(body);
    // The server's reason when it sent one; a non-JSON or shapeless refusal
    // falls back to the status code rather than guessing.
    throw new Error(parsedError.success && parsedError.data.error.trim() ? parsedError.data.error : `Team task creation failed: ${response.status}`);
  }
  const body = await response.json().catch(() => null);
  const parsed = z.object({ task: teamTaskSchema }).safeParse(body);
  if (!parsed.success) {
    throw new Error('Team task creation response did not match the expected shape');
  }
};
