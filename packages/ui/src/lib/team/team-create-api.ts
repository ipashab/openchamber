// The "New Team" side of the team routes: presets the dialog offers and the
// create call itself. Parsing lives here, once; the server contract is the
// Team Mode section of `packages/web/server/lib/team/DOCUMENTATION.md`.

import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';

const PRESETS_ROUTE = '/api/openchamber/team-presets';
const TEAMS_ROUTE = '/api/openchamber/teams';

export const teamPresetMemberSchema = z.object({
  name: z.string(),
  // Null means "the agent's default": the server resolves the catalog.
  agent: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  brief: z.string().nullable().optional(),
  skills: z.array(z.string()).catch([]),
  mcpServers: z.array(z.string()).catch([]),
  isLead: z.boolean().catch(false),
});

export const teamPresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  // Built-in presets ship with the app; only user presets are deletable.
  builtIn: z.boolean().optional(),
  members: z.array(teamPresetMemberSchema),
});

export type TeamPresetMember = z.infer<typeof teamPresetMemberSchema>;
export type TeamPreset = z.infer<typeof teamPresetSchema>;

export const teamCreateResultSchema = z.object({
  team: z.object({ id: z.string(), name: z.string(), directory: z.string() }),
  leadSessionId: z.string(),
  members: z.array(z.object({
    slotId: z.string(),
    name: z.string(),
    role: z.enum(['lead', 'teammate']),
    status: z.string(),
  })),
});

export type TeamCreateResult = z.infer<typeof teamCreateResultSchema>;

/**
 * A member as the create route accepts it: the tool and lead fields may be
 * omitted entirely — the server normalizes what is missing and resolves
 * defaults from the catalog.
 */
export type TeamCreateMember = {
  name: string;
  agent?: string | null;
  model?: string | null;
  brief?: string | null;
  skills?: string[];
  mcpServers?: string[];
  isLead?: boolean;
};

/** A team as the create route wants it: a preset plus where it works. */
export type TeamCreateRequest = {
  name: string;
  description?: string | null;
  directory: string;
  task?: string | null;
  members: TeamCreateMember[];
};

const jsonHeaders = { 'content-type': 'application/json', accept: 'application/json' };

/** The server's reason for refusing a request, when it sent one. */
const readRouteError = async (response: Response, fallback: string): Promise<string> => {
  const body = await response.json().catch(() => null);
  const message = (body as { error?: unknown } | null)?.error;
  return typeof message === 'string' && message.trim() ? message : `${fallback}: ${response.status}`;
};

export const fetchTeamPresets = async (fetchImpl: typeof runtimeFetch = runtimeFetch): Promise<TeamPreset[]> => {
  const response = await fetchImpl(PRESETS_ROUTE, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(await readRouteError(response, 'Team presets request failed'));
  }
  const body = await response.json().catch(() => null);
  const parsed = z.object({ presets: z.array(teamPresetSchema) }).safeParse(body);
  if (!parsed.success) {
    throw new Error('Team presets response did not match the expected shape');
  }
  return parsed.data.presets;
};

/** Create or update a user preset; saving over a built-in id stores a copy. */
export const saveTeamPreset = async (
  preset: TeamPreset,
  fetchImpl: typeof runtimeFetch = runtimeFetch,
): Promise<TeamPreset> => {
  const response = await fetchImpl(PRESETS_ROUTE, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(preset),
  });
  if (!response.ok) {
    throw new Error(await readRouteError(response, 'Preset save failed'));
  }
  const body = await response.json().catch(() => null);
  const parsed = z.object({ preset: teamPresetSchema }).safeParse(body);
  if (!parsed.success) {
    throw new Error('Preset save response did not match the expected shape');
  }
  return parsed.data.preset;
};

export const deleteTeamPreset = async (id: string, fetchImpl: typeof runtimeFetch = runtimeFetch): Promise<void> => {
  const response = await fetchImpl(`${PRESETS_ROUTE}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!response.ok) {
    throw new Error(await readRouteError(response, 'Preset delete failed'));
  }
};

/**
 * Create a live team; the server spawns the sessions and briefs the members,
 * so this resolves only once the lineup exists. The caller opens leadSessionId.
 */
export const createTeam = async (
  request: TeamCreateRequest,
  fetchImpl: typeof runtimeFetch = runtimeFetch,
): Promise<TeamCreateResult> => {
  const response = await fetchImpl(TEAMS_ROUTE, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw new Error(await readRouteError(response, 'Team creation failed'));
  }
  const body = await response.json().catch(() => null);
  const parsed = teamCreateResultSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error('Team creation response did not match the expected shape');
  }
  return parsed.data;
};
