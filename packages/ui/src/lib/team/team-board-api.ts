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

export const teamTaskStatusSchema = z.enum(['pending', 'in_progress', 'completed']);
export type TeamTaskStatus = z.infer<typeof teamTaskStatusSchema>;

const teamMemberSchema = z.object({
  slotId: z.string(),
  name: z.string(),
  role: z.enum(['lead', 'teammate']),
  status: teamMemberStatusSchema,
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

export const teamBoardSchema = z.object({
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
