import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { BUILTIN_TEAM_PRESETS, createTeamPresetStore, normalizeTeamPreset } from './presets.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const makeStore = async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-presets-'));
  temporaryDirectories.push(dataDir);
  return { store: createTeamPresetStore({ fsPromises: fs, path, dataDir }), dataDir };
};

describe('team preset store', () => {
  it('lists the built-in lineup first and validates it', () => {
    expect(BUILTIN_TEAM_PRESETS.length).toBeGreaterThan(0);
    for (const preset of BUILTIN_TEAM_PRESETS) {
      const leads = preset.members.filter((member) => member.isLead);
      expect(leads).toHaveLength(1);
      expect(preset.members.every((member) => member.name)).toBe(true);
    }
  });

  it('forces exactly one lead when normalizing a preset', () => {
    const preset = normalizeTeamPreset({
      name: 'Шайка',
      members: [{ name: 'А' }, { name: 'Б', isLead: true }, { name: 'В', isLead: true }],
    });
    expect(preset.members.filter((member) => member.isLead).map((member) => member.name)).toEqual(['Б']);

    const unmarked = normalizeTeamPreset({ name: 'Шайка', members: [{ name: 'А' }] });
    expect(unmarked.members[0].isLead).toBe(true);
  });

  it('refuses presets without a name or members', () => {
    expect(() => normalizeTeamPreset({ members: [{ name: 'А' }] })).toThrow(/name is required/);
    expect(() => normalizeTeamPreset({ name: 'X', members: [] })).toThrow(/at least one member/);
  });

  it('persists user presets and merges them after the built-ins', async () => {
    const { store, dataDir } = await makeStore();
    const saved = await store.upsert({ name: 'Моя команда', members: [{ name: 'Лид', isLead: true }] });
    expect(saved.id).toMatch(/^preset_/);

    // A second store over the same data dir reads the preset back from disk.
    const reopened = createTeamPresetStore({ fsPromises: fs, path, dataDir });
    const listed = await reopened.list();
    expect(listed.slice(0, BUILTIN_TEAM_PRESETS.length).map((preset) => preset.id))
      .toEqual(BUILTIN_TEAM_PRESETS.map((preset) => preset.id));
    expect(listed.at(-1)).toMatchObject({ name: 'Моя команда', id: saved.id });
  });

  it('copies instead of overwriting a built-in preset id', async () => {
    const { store } = await makeStore();
    const saved = await store.upsert({
      id: BUILTIN_TEAM_PRESETS[0].id,
      name: 'Похожая',
      members: [{ name: 'Лид', isLead: true }],
    });
    expect(saved.id).not.toBe(BUILTIN_TEAM_PRESETS[0].id);
    const listed = await store.list();
    expect(listed.filter((preset) => preset.id === BUILTIN_TEAM_PRESETS[0].id)).toHaveLength(1);
  });

  it('removes user presets and refuses to remove built-ins', async () => {
    const { store } = await makeStore();
    const saved = await store.upsert({ name: 'Временная', members: [{ name: 'Лид', isLead: true }] });
    expect(await store.remove(saved.id)).toBe(true);
    expect(await store.remove(saved.id)).toBe(false);
    await expect(store.remove(BUILTIN_TEAM_PRESETS[0].id)).rejects.toThrow(/built-in/);
    expect(await store.list()).toHaveLength(BUILTIN_TEAM_PRESETS.length);
  });

  it('keeps sub-team fields on preset members and strips unknown domains', () => {
    const normalized = normalizeTeamPreset({
      name: 'Студия',
      members: [
        { name: 'Тим-лид', isLead: true },
        { name: 'Лид аналитики', domain: 'analytics', isDomainLead: true },
        { name: 'Работяга', domain: 'no-such-domain', isDomainLead: true },
        { name: 'Без домена' },
      ],
    });
    const domainLead = normalized.members.find((member) => member.name === 'Лид аналитики');
    expect(domainLead.domain).toBe('analytics');
    expect(domainLead.isDomainLead).toBe(true);
    // An unknown domain cannot carry a lead flag out of normalization.
    const stranger = normalized.members.find((member) => member.name === 'Работяга');
    expect(stranger.domain).toBeNull();
    expect(stranger.isDomainLead).toBe(false);
    const plain = normalized.members.find((member) => member.name === 'Без домена');
    expect(plain.domain).toBeNull();
    expect(plain.isDomainLead).toBe(false);
  });

  it('ships the studio preset with one lead per sub-team', () => {
    const studio = BUILTIN_TEAM_PRESETS.find((preset) => preset.id === 'builtin-studio');
    expect(studio).toBeTruthy();
    const normalized = normalizeTeamPreset(studio, { id: studio.id });
    const domainLeads = normalized.members.filter((member) => member.isDomainLead === true);
    expect(domainLeads.map((member) => member.domain).sort()).toEqual(['analytics', 'development', 'qa', 'review']);
    for (const domain of domainLeads.map((member) => member.domain)) {
      expect(normalized.members.filter((member) => member.domain === domain && member.isDomainLead === true))
        .toHaveLength(1);
    }
    expect(normalized.members.some((member) => member.isLead && (member.domain || member.isDomainLead))).toBe(false);
  });
});
