// The host's mission routes, `/api/openchamber/missions`, as the missions
// panel calls them. Every answer is parsed here, once, into the types the
// panel renders; a shape the server did not send fails the fetch rather than
// putting half-typed rows on the list. The contract is the missions section
// of `packages/web/server/lib/missions/` (service and routes docblocks).

import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';

const MISSIONS_ROUTE = '/api/openchamber/missions';

const jsonHeaders = { 'content-type': 'application/json', accept: 'application/json' };

const missionModeSchema = z.enum(['session', 'team']);
export type MissionMode = z.infer<typeof missionModeSchema>;

const missionStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']);
export type MissionStatus = z.infer<typeof missionStatusSchema>;export const missionSchema = z.object({
  missionId: z.string(),
  title: z.string(),
  // The goal prompt is kept in full: the list shows the title, the details
  // show what the working session actually received.
  prompt: z.string(),
  mode: missionModeSchema,
  status: missionStatusSchema,
  directory: z.string(),
  // The session carrying the turn (a team mission points at the lead's), and
  // the team itself in team mode; both null until the queue's slot dispatches.
  sessionId: z.string().nullable(),
  teamId: z.string().nullable(),
  model: z.string().nullable(),
  agent: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
});
export type Mission = z.infer<typeof missionSchema>;

// The queue's own settings: how many goals run at once and how long each
// watch waits. Same bounds the server enforces; the form validates first so
// the range in the hint is what the user can actually type.
const missionConfigSchema = z.object({
  maxConcurrent: z.number().int().min(1).max(16),
  maxRunMs: z.number().int().min(60 * 1000).max(24 * 60 * 60 * 1000),
});
export type MissionConfig = z.infer<typeof missionConfigSchema>;

export const MISSION_CONFIG_BOUNDS = {
  maxConcurrent: { min: 1, max: 16 },
  windowMinutes: { min: Math.round((60 * 1000) / 60_000), max: Math.round((24 * 60 * 60 * 1000) / 60_000) },
} as const;

export type MissionConfigInput = {
  maxConcurrent?: number;
  maxRunMs?: number;
};

export type MissionCreateInput = {
  title: string;
  prompt: string;
  mode: MissionMode;
  directory: string;
  model?: string;
  agent?: string;
};

const readRouteError = async (response: Response, fallback: string): Promise<string> => {
  // Best-effort: the server explains its failures in `error`; anything the
  // parse does not recognize falls back to the status code.
  const body = await response.json().catch(() => null);
  const parsed = z.object({ error: z.string().trim().min(1) }).safeParse(body);
  return parsed.success ? parsed.data.error : `${fallback}: ${response.status}`;
};

/** The whole list with the queue settings, newest first — same order the server sends. */
export const fetchMissions = async (
  fetchImpl: typeof runtimeFetch = runtimeFetch,
): Promise<{ missions: Mission[]; config: MissionConfig }> => {
  const response = await fetchImpl(MISSIONS_ROUTE, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(await readRouteError(response, 'Missions request failed'));
  }
  const body = await response.json().catch(() => null);
  const parsed = z.object({ missions: z.array(missionSchema), config: missionConfigSchema }).safeParse(body);
  if (!parsed.success) {
    throw new Error('Missions response did not match the expected shape');
  }
  return parsed.data;
};

/** Save the queue settings; the answer is the config the server kept. */
export const updateMissionConfig = async (
  input: MissionConfigInput,
  fetchImpl: typeof runtimeFetch = runtimeFetch,
): Promise<MissionConfig> => {
  const response = await fetchImpl(`${MISSIONS_ROUTE}/config`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(await readRouteError(response, 'Mission settings update failed'));
  }
  const body = await response.json().catch(() => null);
  const parsed = z.object({ config: missionConfigSchema }).safeParse(body);
  if (!parsed.success) {
    throw new Error('Mission settings response did not match the expected shape');
  }
  return parsed.data.config;
};

/** File a new goal; the answer is the queued mission the list will show. */
export const createMission = async (
  input: MissionCreateInput,
  fetchImpl: typeof runtimeFetch = runtimeFetch,
): Promise<Mission> => {
  const response = await fetchImpl(MISSIONS_ROUTE, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(await readRouteError(response, 'Mission creation failed'));
  }
  const body = await response.json().catch(() => null);
  const parsed = z.object({ mission: missionSchema }).safeParse(body);
  if (!parsed.success) {
    throw new Error('Mission creation response did not match the expected shape');
  }
  return parsed.data.mission;
};

const missionMutation = async (
  suffix: string,
  fallback: string,
  fetchImpl: typeof runtimeFetch,
): Promise<Mission> => {
  const response = await fetchImpl(`${MISSIONS_ROUTE}/${suffix}`, {
    method: 'POST',
    headers: jsonHeaders,
  });
  if (!response.ok) {
    throw new Error(await readRouteError(response, fallback));
  }
  const body = await response.json().catch(() => null);
  const parsed = z.object({ mission: missionSchema }).safeParse(body);
  if (!parsed.success) {
    throw new Error('Mission response did not match the expected shape');
  }
  return parsed.data.mission;
};

/**
 * Cancel waits for a queued mission or stops watching a running one; the
 * session a running mission started keeps going where its own user stops it.
 */
export const cancelMission = (missionId: string, fetchImpl: typeof runtimeFetch = runtimeFetch): Promise<Mission> =>
  missionMutation(`${encodeURIComponent(missionId)}/cancel`, 'Mission cancel failed', fetchImpl);

/** Requeue a finished mission as a fresh run of the same goal. */
export const retryMission = (missionId: string, fetchImpl: typeof runtimeFetch = runtimeFetch): Promise<Mission> =>
  missionMutation(`${encodeURIComponent(missionId)}/retry`, 'Mission retry failed', fetchImpl);

/** Delete the record — the only write that also forgets the goal itself. */
export const deleteMission = async (
  missionId: string,
  fetchImpl: typeof runtimeFetch = runtimeFetch,
): Promise<void> => {
  const response = await fetchImpl(`${MISSIONS_ROUTE}/${encodeURIComponent(missionId)}`, { method: 'DELETE' });
  if (!response.ok) {
    throw new Error(await readRouteError(response, 'Mission delete failed'));
  }
};
