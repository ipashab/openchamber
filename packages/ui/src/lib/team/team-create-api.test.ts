import { describe, expect, test } from 'bun:test';

import {
  createTeam,
  deleteTeamPreset,
  fetchTeamPresets,
  saveTeamPreset,
  teamPresetSchema,
  type TeamPreset,
} from './team-create-api';

type FetchLike = typeof fetch;

/** Records one request and answers with the given status and body. */
const fakeFetch = (status: number, body: unknown, capture: {url?: string; init?: RequestInit} = {}): FetchLike =>
  async (input, init) => {
    capture.url = String(input);
    capture.init = init;
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };

const preset = {
  id: 'builtin-duo',
  name: 'Дуэт',
  members: [{ name: 'Лид', isLead: true }],
};

describe('teamPresetSchema', () => {
  test('tolerates a server preset that omits the optional fields', () => {
    const parsed = teamPresetSchema.parse({
      id: 'p1',
      name: 'Crew',
      members: [{ name: 'A' }, { name: 'B', isLead: true }],
    });
    expect(parsed.builtIn).toBeUndefined();
    expect(parsed.members[0].agent).toBeUndefined();
    expect(parsed.members[0].skills).toEqual([]);
    expect(parsed.members[0].mcpServers).toEqual([]);
    expect(parsed.members[0].isLead).toBe(false);
    expect(parsed.members[1].isLead).toBe(true);
  });

  test('refuses a preset without a name or members', () => {
    expect(() => teamPresetSchema.parse({ id: 'p1', members: [] })).toThrow();
    expect(() => teamPresetSchema.parse({ id: 'p1', name: 'Crew', members: [{ isLead: true }] })).toThrow();
  });
});

describe('team create api', () => {
  test('fetchTeamPresets parses the route answer', async () => {
    const fetches = fakeFetch(200, { presets: [preset] });
    const presets = await fetchTeamPresets(fetches as never);
    expect(presets).toHaveLength(1);
    expect(presets[0].name).toBe('Дуэт');
  });

  test('fetchTeamPresets refuses a shape the contract does not define', async () => {
    const fetches = fakeFetch(200, { recipes: [] });
    await expect(fetchTeamPresets(fetches as never)).rejects.toThrow(/expected shape/);
  });

  test('saveTeamPreset posts the preset back and returns the stored copy', async () => {
    const capture: {url?: string; init?: RequestInit} = {};
    const fetches = fakeFetch(200, { preset }, capture);
    const saved = await saveTeamPreset(preset as TeamPreset, fetches as never);
    expect(saved.id).toBe('builtin-duo');
    expect(capture.init?.method).toBe('POST');
    expect(String(capture.init?.body)).toContain('"id":"builtin-duo"');
  });

  test('deleteTeamPreset encodes the id into the path', async () => {
    const capture: {url?: string} = {};
    const fetches = fakeFetch(200, { removed: true }, capture);
    await deleteTeamPreset('preset x/1', fetches as never);
    expect(capture.url).toContain(encodeURIComponent('preset x/1'));
  });

  test('createTeam posts the lineup and returns the lead session id', async () => {
    const capture: {url?: string; init?: RequestInit} = {};
    const fetches = fakeFetch(201, {
      team: { id: 'team_1', name: 'Crew', directory: '/work' },
      leadSessionId: 'ses_lead',
      members: [{ slotId: 'lead', name: 'Лид', role: 'lead', status: 'busy' }],
    }, capture);
    const result = await createTeam({
      name: 'Crew',
      directory: '/work',
      task: null,
      members: [{ name: 'Лид', isLead: true }],
    }, fetches as never);
    expect(result.leadSessionId).toBe('ses_lead');
    expect(capture.url).toContain('/api/openchamber/teams');
    expect(String(capture.init?.body)).toContain('"directory":"/work"');
  });

  test('createTeam surfaces the route reason for a refusal', async () => {
    const fetches = fakeFetch(400, { error: 'only one member can be the team lead' });
    await expect(createTeam({ name: 'Crew', directory: '/work', members: [] }, fetches as never))
      .rejects.toThrow(/only one member can be the team lead/);
  });
});
