import { describe, expect, test } from 'bun:test';

import {
  addTeamMember,
  createTeam,
  deleteTeamPreset,
  fetchTeamPresets,
  fetchTeamPresetExport,
  parseTeamPresetImport,
  requestTeamMemberShutdown,
  saveTeamPreset,
  teamPresetSchema,
  teamPresetToPortableJson,
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

  test('addTeamMember posts the card to the live team and parses the answer', async () => {
    const capture: {url?: string; init?: RequestInit} = {};
    const fetches = fakeFetch(201, {
      member: { slotId: 'member_1', name: 'Новый', role: 'teammate', domain: 'qa', isDomainLead: false, status: 'busy' },
    }, capture);
    const member = await addTeamMember('team_1', {
      name: 'Новый',
      agent: null,
      model: null,
      brief: null,
      skills: ['demo'],
      mcpServers: [],
      domain: 'qa',
      isDomainLead: false,
    }, fetches as never);
    expect(member.slotId).toBe('member_1');
    expect(member.domain).toBe('qa');
    expect(capture.url).toContain('/api/openchamber/teams/team_1/members');
    expect(capture.init?.method).toBe('POST');
    expect(String(capture.init?.body)).toContain('"domain":"qa"');
  });

  test('addTeamMember carries the route reason for a duplicate name', async () => {
    const fetches = fakeFetch(409, { error: "A teammate named 'Новый' already exists in this team" });
    await expect(addTeamMember('team_1', { name: 'Новый' }, fetches as never))
      .rejects.toThrow(/already exists in this team/);
  });

  test('requestTeamMemberShutdown posts the handshake request and encodes the slot', async () => {
    const capture: {url?: string; init?: RequestInit} = {};
    const fetches = fakeFetch(200, { requested: true }, capture);
    await requestTeamMemberShutdown('team_1', 'member_x/2', 'не нужен', fetches as never);
    expect(capture.url).toContain('/api/openchamber/teams/team_1/members/');
    expect(capture.url).toContain(encodeURIComponent('member_x/2'));
    expect(capture.url).toContain('/shutdown');
    expect(String(capture.init?.body)).toContain('не нужен');
  });

  test('requestTeamMemberShutdown surfaces a refusal from the route', async () => {
    const fetches = fakeFetch(400, { error: 'The Team Lead cannot be dismissed' });
    await expect(requestTeamMemberShutdown('team_1', 'lead', null, fetches as never))
      .rejects.toThrow(/cannot be dismissed/);
  });

  test('the preset schema round-trips sub-team fields and tolerates their absence', () => {
    const parsed = teamPresetSchema.parse({
      id: 'p1',
      name: 'Студия',
      members: [
        { name: 'Лид', isLead: true },
        { name: 'Лид аналитики', domain: 'analytics', isDomainLead: true },
      ],
    });
    expect(parsed.members[0].domain).toBeUndefined();
    expect(parsed.members[1].domain).toBe('analytics');
    expect(parsed.members[1].isDomainLead).toBe(true);
  });

  test('an unknown sub-team id parses to no sub-team, not a schema error', () => {
    const parsed = teamPresetSchema.parse({
      id: 'p1',
      name: 'Студия',
      members: [{ name: 'Работяга', domain: 'not-a-domain', isDomainLead: true }],
    });
    // The schema only tolerates; the server's preset normalizer is what
    // strips the orphan lead flag from an unknown domain.
    expect(parsed.members[0].domain).toBeNull();
  });
});

describe('team preset recipe files', () => {
  const recipe: TeamPreset = {
    id: 'preset_1',
    name: 'Дуэт',
    description: null,
    members: [
      { name: 'Лид', agent: null, model: null, brief: null, skills: [], mcpServers: [], isLead: true, domain: null, isDomainLead: false },
      { name: 'Лид QA', agent: 'build', model: 'prov/alpha', brief: 'Прогоны', skills: ['demo'], mcpServers: [], isLead: false, domain: 'qa', isDomainLead: true },
    ],
  };

  test('fetchTeamPresetExport parses the recipe route answer', async () => {
    const capture: {url?: string} = {};
    const fetches = fakeFetch(200, { preset: recipe }, capture);
    const exported = await fetchTeamPresetExport('team_1', fetches as never);
    expect(exported.members[1].domain).toBe('qa');
    expect(exported.members[1].skills).toEqual(['demo']);
    expect(capture.url).toContain('/api/openchamber/teams/team_1/preset');
  });

  test('fetchTeamPresetExport surfaces a missing team', async () => {
    const fetches = fakeFetch(404, { error: "No team with id 'team_missing'" });
    await expect(fetchTeamPresetExport('team_missing', fetches as never)).rejects.toThrow(/No team/);
  });

  test('parseTeamPresetImport reads one recipe or a JSON array of them', () => {
    const single = parseTeamPresetImport(teamPresetToPortableJson(recipe));
    expect('presets' in single).toBe(true);
    if ('presets' in single) {
      expect(single.presets[0].name).toBe('Дуэт');
      expect(single.presets[0].members[1].skills).toEqual(['demo']);
      expect(single.presets[0].members[1].domain).toBe('qa');
    }
    const many = parseTeamPresetImport(JSON.stringify([JSON.parse(teamPresetToPortableJson(recipe)), recipe]));
    expect('presets' in many && many.presets).toHaveLength(2);
  });

  test('a recipe file carries no id and imports as a fresh preset', () => {
    const portable = JSON.parse(teamPresetToPortableJson(recipe));
    expect(portable.id).toBeUndefined();
    expect(portable.builtIn).toBeUndefined();
    const result = parseTeamPresetImport(teamPresetToPortableJson(recipe));
    if ('presets' in result) expect(result.presets[0].id).toBe('');
  });

  test('parseTeamPresetImport refuses broken JSON and foreign objects', () => {
    expect(parseTeamPresetImport('{nope')).toEqual({ error: 'invalidJson' });
    expect(parseTeamPresetImport('{"name":"x","members":[]}')).toEqual({ error: 'invalidPreset' });
    expect(parseTeamPresetImport('[42]')).toEqual({ error: 'invalidPreset' });
  });
});
