import { describe, expect, test } from 'bun:test';

import { runtimeFetch } from '@/lib/runtime-fetch';

import {
  cancelMission,
  createMission,
  deleteMission,
  fetchMissions,
  missionSchema,
  retryMission,
  updateMissionConfig,
} from './missions-api';

const missionFixture = {
  missionId: 'mission_1',
  title: 'Ship the checklist',
  prompt: 'Walk every step and write doc/deploy.md',
  mode: 'session',
  status: 'running',
  directory: '/projects/app',
  sessionId: 'ses_1',
  teamId: null,
  model: null,
  agent: null,
  error: null,
  createdAt: 1760000000000,
  startedAt: 1760000001000,
  finishedAt: null,
};

const configFixture = {
  maxConcurrent: 2,
  maxRunMs: 60 * 60 * 1000,
};

type FetchLog = { url: string; init?: RequestInit };

const fetchAnswering = (responses: Record<string, { status?: number; body: unknown }>) => {
  const log: FetchLog[] = [];
  const fetchImpl: typeof runtimeFetch = async (rawInput, init) => {
    const path = String(rawInput);
    log.push({ url: path, init });
    const answer = responses[path];
    if (!answer) {
      return new Response(JSON.stringify({ error: 'unexpected route' }), { status: 404 });
    }
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  };
  return { fetchImpl, log };
};

describe('missionSchema', () => {
  test('parses the mission the server sends and rejects the shapes it does not', () => {
    expect(missionSchema.safeParse(missionFixture).success).toBe(true);
    expect(missionSchema.safeParse({ ...missionFixture, status: 'flaming' }).success).toBe(false);
    expect(missionSchema.safeParse({ ...missionFixture, mode: 'swarm' }).success).toBe(false);
  });
});

describe('missions-api', () => {
  test('fetches the list and the queue config, newest first exactly as the server sorted it', async () => {
    const queued = { ...missionFixture, missionId: 'mission_2', status: 'queued' as const };
    const { fetchImpl, log } = fetchAnswering({
      '/api/openchamber/missions': { body: { missions: [missionFixture, queued], config: configFixture } },
    });
    const { missions, config } = await fetchMissions(fetchImpl);
    expect(missions.map((mission) => mission.missionId)).toEqual(['mission_1', 'mission_2']);
    expect(config).toEqual(configFixture);
    expect(log[0].url).toBe('/api/openchamber/missions');
  });

  test('fails the fetch rather than rendering half-typed rows', async () => {
    const { fetchImpl } = fetchAnswering({ '/api/openchamber/missions': { body: { nope: true } } });
    await expect(fetchMissions(fetchImpl)).rejects.toThrow('expected shape');
  });

  test('saves the queue config and parses the config the server kept', async () => {
    const saved = { ...configFixture, maxConcurrent: 5 };
    const { fetchImpl, log } = fetchAnswering({
      '/api/openchamber/missions/config': { body: { config: saved } },
    });
    const config = await updateMissionConfig({ maxConcurrent: 5 }, fetchImpl);
    expect(config).toEqual(saved);
    const init = log[0].init;
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toEqual({ maxConcurrent: 5 });
  });

  test('surfaces the config range errors in the server words', async () => {
    const { fetchImpl } = fetchAnswering({
      '/api/openchamber/missions/config': {
        status: 400,
        body: { error: 'maxConcurrent must be a whole number between 1 and 16' },
      },
    });
    await expect(updateMissionConfig({ maxConcurrent: 99 }, fetchImpl)).rejects.toThrow('whole number');
  });

  test('files a mission with the chosen mode and directory', async () => {
    const { fetchImpl, log } = fetchAnswering({
      '/api/openchamber/missions': { body: { mission: missionFixture } },
    });
    const mission = await createMission(
      { title: 'T', prompt: 'P', mode: 'team', directory: '/projects/app' },
      fetchImpl,
    );
    expect(mission.missionId).toBe('mission_1');
    const init = log[0].init;
    expect(init?.method).toBe('POST');
    expect(String(init?.headers).length).toBeGreaterThan(0);
    expect(JSON.parse(String(init?.body))).toEqual({
      title: 'T',
      prompt: 'P',
      mode: 'team',
      directory: '/projects/app',
    });
  });

  test('surfaces the route error the server explained in its own words', async () => {
    const { fetchImpl } = fetchAnswering({
      '/api/openchamber/missions/mission_1/cancel': {
        status: 400,
        body: { error: 'A completed mission cannot be cancelled' },
      },
    });
    await expect(cancelMission('mission_1', fetchImpl)).rejects.toThrow('cannot be cancelled');
  });

  test('cancel and retry address the mission and parse the answer', async () => {
    const { fetchImpl, log } = fetchAnswering({
      '/api/openchamber/missions/mission%20x/cancel': { body: { mission: { ...missionFixture, status: 'cancelled' } } },
      '/api/openchamber/missions/mission_1/retry': { body: { mission: { ...missionFixture, status: 'queued' } } },
    });
    const cancelled = await cancelMission('mission x', fetchImpl);
    expect(cancelled.status).toBe('cancelled');
    expect(log[0].url).toBe('/api/openchamber/missions/mission%20x/cancel');
    const retried = await retryMission('mission_1', fetchImpl);
    expect(retried.status).toBe('queued');
  });

  test('delete removes the record and encodes the id', async () => {
    const { fetchImpl, log } = fetchAnswering({
      '/api/openchamber/missions/mission%20x': { body: { mission: missionFixture } },
    });
    const removed = await deleteMission('mission x', fetchImpl);
    expect(removed).toBeUndefined();
    expect(log[0].init?.method).toBe('DELETE');
    expect(log[0].url).toBe('/api/openchamber/missions/mission%20x');
  });
});
