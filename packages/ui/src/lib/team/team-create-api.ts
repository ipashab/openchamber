// The "New Team" side of the team routes: presets the dialog offers and the
// create call itself. Parsing lives here, once; the server contract is the
// Team Mode section of `packages/web/server/lib/team/DOCUMENTATION.md`.

import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';

import { teamDomainSchema } from './team-board-api';
import type { TeamDomain } from './team-board-api';

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
  // Sub-team placement: the domain plus the "leads this sub-team" flag.
  // Nullish and caught — older servers omit them and unknown ids mean no
  // sub-team, never a failed fetch.
  domain: teamDomainSchema.nullish().catch(null),
  isDomainLead: z.boolean().nullish().catch(false),
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
    domain: teamDomainSchema.nullish().catch(null),
    isDomainLead: z.boolean().nullish().catch(false),
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
  // Nullish: a preset member may carry the absent state in either flavor,
  // the schema's catch makes no distinction between them.
  domain?: TeamDomain | null;
  isDomainLead?: boolean | null;
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

const teamMemberMutationSchema = z.object({
  slotId: z.string(),
  name: z.string(),
  role: z.enum(['lead', 'teammate']),
  domain: teamDomainSchema.nullish().catch(null),
  isDomainLead: z.boolean().nullish().catch(false),
  status: z.string(),
});

/**
 * The "Edit team" flow: add one member to a live roster. The server walks the
 * spawn path with the same tool allowances the creation dialog applies, so
 * this resolves once the session exists and its briefing was dispatched.
 */
export const addTeamMember = async (
  teamId: string,
  member: TeamCreateMember,
  fetchImpl: typeof runtimeFetch = runtimeFetch,
): Promise<z.infer<typeof teamMemberMutationSchema>> => {
  const response = await fetchImpl(`${TEAMS_ROUTE}/${encodeURIComponent(teamId)}/members`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(member),
  });
  if (!response.ok) {
    throw new Error(await readRouteError(response, 'Adding the member failed'));
  }
  const body = await response.json().catch(() => null);
  const parsed = z.object({ member: teamMemberMutationSchema }).safeParse(body);
  if (!parsed.success) {
    throw new Error('Member add response did not match the expected shape');
  }
  return parsed.data.member;
};

/**
 * Ask a member to shut down. The approval handshake stays on the team channel:
 * resolve only says the request was delivered, not that the member agreed.
 */
export const requestTeamMemberShutdown = async (
  teamId: string,
  slotId: string,
  reason?: string | null,
  fetchImpl: typeof runtimeFetch = runtimeFetch,
): Promise<void> => {
  const response = await fetchImpl(
    `${TEAMS_ROUTE}/${encodeURIComponent(teamId)}/members/${encodeURIComponent(slotId)}/shutdown`,
    {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ reason: reason ?? null }),
    },
  );
  if (!response.ok) {
    throw new Error(await readRouteError(response, 'Shutdown request failed'));
  }
};

/**
 * The live roster of a team as a preset recipe, from the export route. The
 * shape is the shelf's own, so it saves or downloads without conversion.
 */
export const fetchTeamPresetExport = async (
  teamId: string,
  fetchImpl: typeof runtimeFetch = runtimeFetch,
): Promise<TeamPreset> => {
  const response = await fetchImpl(
    `${TEAMS_ROUTE}/${encodeURIComponent(teamId)}/preset`,
    { headers: { accept: 'application/json' } },
  );
  if (!response.ok) {
    throw new Error(await readRouteError(response, 'Team preset export failed'));
  }
  const body = await response.json().catch(() => null);
  const parsed = z.object({ preset: teamPresetSchema }).safeParse(body);
  if (!parsed.success) {
    throw new Error('Team preset export did not match the expected shape');
  }
  return parsed.data.preset;
};

// Recipe files carry no id of their own; a missing id saves as a fresh preset.
// The members floor stays client-side too: the array schema of the shelf is
// read-tolerant, while an import of "no members at all" is a mistake.
const importPresetSchema = teamPresetSchema.extend({
  id: z.string().catch(''),
  members: teamPresetSchema.shape.members.min(1),
});

/**
 * Import side of the recipe files: one JSON object or an array of them.
 * Wrong files come back as a reason code, not an exception, so the caller
 * owns the localized message.
 */
export const parseTeamPresetImport = (
  text: string,
): { presets: TeamPreset[] } | { error: 'invalidJson' | 'invalidPreset' } => {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { error: 'invalidJson' };
  }
  const parsed = z
    .array(importPresetSchema)
    .min(1)
    .safeParse(Array.isArray(body) ? body : [body]);
  if (!parsed.success) {
    return { error: 'invalidPreset' };
  }
  return { presets: parsed.data };
};

/** One recipe as a portable JSON string; instance-local fields never ship. */
export const teamPresetToPortableJson = (preset: TeamPreset): string => JSON.stringify({
  name: preset.name,
  description: preset.description ?? null,
  members: preset.members.map((member) => ({
    name: member.name,
    agent: member.agent ?? null,
    model: member.model ?? null,
    brief: member.brief ?? null,
    skills: member.skills,
    mcpServers: member.mcpServers,
    isLead: member.isLead,
    domain: member.domain ?? null,
    isDomainLead: member.isDomainLead ?? false,
  })),
}, null, 2);

/** Download one recipe as a JSON file; importing it back round-trips. */
export const downloadTeamPresetJson = (preset: TeamPreset): void => {
  const slug = preset.name.trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'team-preset';
  const href = URL.createObjectURL(new Blob([teamPresetToPortableJson(preset)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = `${slug}.team-preset.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(href), 1_000);
};
