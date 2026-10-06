import fs from 'node:fs/promises';
import path from 'node:path';

import { TEAM_DOMAIN_IDS } from './tools.js';

/**
 * Team presets: saved team recipes the "New Team" dialog offers, plus the
 * built-in lineup shipped with the app. A preset describes the roster only —
 * who is in the team, with which agent, brief and tool allowances — never a
 * live team; creating from a preset copies the recipe into the dialog.
 *
 * User presets persist as `<data-dir>/team-presets.json`, written atomically
 * (tmp + rename, mode 0600) the way `teams.json` does. The file is small and
 * written only on explicit user saves, so writes await instead of debouncing.
 */

const PRESET_FILE_NAME = 'team-presets.json';

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const asStringList = (value) => (
  Array.isArray(value) ? value.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim()) : []
);

const shortId = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

/** One roster slot of a preset; the lead is the slot flagged `isLead`. */
const normalizePresetMember = (member) => {
  const name = asNonEmptyString(member?.name);
  if (!name) return null;
  const model = asNonEmptyString(member?.model);
  const isLead = member?.isLead === true;
  // The Team Lead sits outside every sub-team — it talks to sub-team leads,
  // not around them — so its domain fields never survive normalization. An
  // unknown domain cannot carry a lead flag either.
  const domain = isLead ? null : (TEAM_DOMAIN_IDS.includes(member?.domain) ? member.domain : null);
  return {
    name,
    agent: asNonEmptyString(member?.agent),
    model,
    brief: asNonEmptyString(member?.brief),
    skills: asStringList(member?.skills),
    mcpServers: asStringList(member?.mcpServers),
    isLead,
    domain,
    isDomainLead: domain !== null && member?.isDomainLead === true,
  };
};

/** Validate one preset; returns the sanitized record or throws with a reason. */
export const normalizeTeamPreset = (preset, { id } = {}) => {
  const name = asNonEmptyString(preset?.name);
  if (!name) throw new Error('preset name is required');
  const members = Array.isArray(preset?.members)
    ? preset.members.map(normalizePresetMember).filter(Boolean)
    : [];
  if (members.length === 0) throw new Error('a preset needs at least one member');
  if (members.length > 10) throw new Error('a preset cannot exceed 10 members');
  if (!members.some((member) => member.isLead)) {
    // An unmarked preset still needs exactly one lead: the first member takes
    // the role, matching how the "empty team" dialog seeds its editor.
    members[0] = { ...members[0], isLead: true };
  }
  const leads = members.filter((member) => member.isLead);
  if (leads.length > 1) {
    // Only one lead runs a team: keep the first flag, clear the rest.
    let seen = false;
    for (const member of members) {
      if (!member.isLead) continue;
      if (seen) member.isLead = false;
      seen = true;
    }
  }
  return {
    id: asNonEmptyString(id) ?? asNonEmptyString(preset?.id) ?? shortId('preset'),
    name,
    description: asNonEmptyString(preset?.description),
    members,
  };
};

/**
 * The lineup shipped with the app. Agents stay null so a preset resolves to
 * whatever primary agents this OpenCode instance actually offers; briefs are
 * in Russian because this is the language the team's prompts are written in.
 */
export const BUILTIN_TEAM_PRESETS = [
  {
    id: 'builtin-studio',
    name: 'Студия с подкомандами',
    description: 'Лид и лиды четырёх подкоманд — аналитика, разработка, ревью и тестирование. Исполнителей в подкоманды добавляйте позже кнопкой «Изменить состав».',
    builtIn: true,
    members: [
      { name: 'Тим-лид', agent: null, model: null, brief: 'Ставишь задачи лидам подкоманд, собираешь с них готовые результаты по областям и суммируешь финальный ответ пользователю. В детали исполнителей внутри подкоманд не лезешь.', skills: [], mcpServers: [], isLead: true },
      { name: 'Лид аналитики', agent: 'explore', model: null, brief: 'Руководишь подкомандой аналитики: декомпозируешь исследование, раздаёшь исполнителям, проверяешь их выводы и отправляешь лиду команды один сводный результат.', skills: [], mcpServers: [], isLead: false, domain: 'analytics', isDomainLead: true },
      { name: 'Лид разработки', agent: null, model: null, brief: 'Руководишь подкомандой разработки: планируешь правки кода, распределяешь их между исполнителями, ревьюишь их работу внутри подкоманды и сдаёшь лиду команды готовый результат.', skills: [], mcpServers: [], isLead: false, domain: 'development', isDomainLead: true },
      { name: 'Лид ревью', agent: null, model: null, brief: 'Руководишь подкомандой ревью: распределяешь диффы по ревьюерам, собираешь и фильтруешь замечания, отправляешь лиду команды выверенный список.', skills: [], mcpServers: [], isLead: false, domain: 'review', isDomainLead: true },
      { name: 'Лид тестирования', agent: null, model: null, brief: 'Руководишь подкомандой тестирования: планируешь прогоны, раздаёшь тест-задания исполнителям, разбираешь падения и отправляешь лиду команды итог по качеству.', skills: [], mcpServers: [], isLead: false, domain: 'qa', isDomainLead: true },
    ],
  },
  {
    id: 'builtin-engineering',
    name: 'Инженерная команда',
    description: 'Лид-координатор, бэкенд на Java и Python, автотесты и QA-ревью.',
    builtIn: true,
    members: [
      { name: 'Тим-лид', agent: null, model: null, brief: 'Координируешь команду: декомпозируешь задачу, раздаёшь её участникам, сводишь результаты в ответ пользователю.', skills: [], mcpServers: [], isLead: true },
      { name: 'Backend Java', agent: null, model: null, brief: 'Java/Kotlin-код сервисов: правки, ревью чужих изменений, запуск unit-тестов.', skills: [], mcpServers: [], isLead: false },
      { name: 'Backend Python', agent: null, model: null, brief: 'Python-код и pytest: правки, линт ruff, запуск тестов.', skills: [], mcpServers: [], isLead: false },
      { name: 'Автотесты', agent: null, model: null, brief: 'Автотесты на pytest: написание и прогон тестов под задачу, отчёт о падениях.', skills: [], mcpServers: [], isLead: false },
      { name: 'QA Reviewer', agent: null, model: null, brief: 'Ревью результатов команды: стиль, потенциальные ошибки, покрытие тестами.', skills: [], mcpServers: [], isLead: false },
    ],
  },
  {
    id: 'builtin-analysis',
    name: 'Аналитики',
    description: 'Лид и параллельные исследователи кодовой базы с финальным ревью выводов.',
    builtIn: true,
    members: [
      { name: 'Тим-лид', agent: null, model: null, brief: 'Делишь тему анализа на независимые области, раздаёшь исследователям, собираешь единый отчёт.', skills: [], mcpServers: [], isLead: true },
      { name: 'Исследователь 1', agent: 'explore', model: null, brief: 'Исследовать назначенную область кода и прислать лид-выводы со ссылками на файлы.', skills: [], mcpServers: [], isLead: false },
      { name: 'Исследователь 2', agent: 'explore', model: null, brief: 'Исследовать назначенную область кода и прислать лид-выводы со ссылками на файлы.', skills: [], mcpServers: [], isLead: false },
      { name: 'Ревьюер выводов', agent: null, model: null, brief: 'Проверить выводы исследователей по исходникам, отметить спорные места.', skills: [], mcpServers: [], isLead: false },
    ],
  },
  {
    id: 'builtin-duo',
    name: 'Дуэт',
    description: 'Лид и один исполнитель — минимальная команда для парной работы.',
    builtIn: true,
    members: [
      { name: 'Тим-лид', agent: null, model: null, brief: 'Ставишь исполнителю чёткие задачи и проверяешь результат перед ответом пользователю.', skills: [], mcpServers: [], isLead: true },
      { name: 'Исполнитель', agent: null, model: null, brief: 'Выполнять назначенные задачи самостоятельно и отчитываться лиду.', skills: [], mcpServers: [], isLead: false },
    ],
  },
];

export const createTeamPresetStore = ({ fsPromises, path: pathModule, dataDir }) => {
  if (!fsPromises || !pathModule || !dataDir) {
    throw new Error('team preset store needs fsPromises, path and dataDir');
  }
  const presetsFilePath = pathModule.join(dataDir, PRESET_FILE_NAME);

  const readUserPresets = async () => {
    try {
      const raw = await fsPromises.readFile(presetsFilePath, 'utf8');
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed?.presets) ? parsed.presets : [];
      const presets = [];
      for (const entry of list) {
        try {
          presets.push(normalizeTeamPreset(entry));
        } catch {
          // One broken record must not hide the rest of the user's presets.
        }
      }
      return presets;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.warn('[team-presets] could not read the presets file:', error?.message ?? error);
      }
      return [];
    }
  };

  const writeUserPresets = async (presets) => {
    const tempPath = `${presetsFilePath}.${process.pid}.tmp`;
    await fsPromises.mkdir(pathModule.dirname(presetsFilePath), { recursive: true });
    await fsPromises.writeFile(tempPath, `${JSON.stringify({ presets }, null, 2)}\n`, 'utf8');
    await fsPromises.chmod(tempPath, 0o600).catch(() => {});
    await fsPromises.rename(tempPath, presetsFilePath);
  };

  return {
    /** Built-in presets first, then the user's own. */
    async list() {
      const user = await readUserPresets();
      return [...BUILTIN_TEAM_PRESETS, ...user];
    },
    /** Create or update a user preset; built-in ids are read-only recipes. */
    async upsert(input) {
      const preset = normalizeTeamPreset(input);
      if (BUILTIN_TEAM_PRESETS.some((entry) => entry.id === preset.id)) {
        // Saving over a built-in would silently lose it on the next update:
        // store a copy under a fresh id instead, keeping the visible name.
        preset.id = shortId('preset');
      }
      const user = await readUserPresets();
      const index = user.findIndex((entry) => entry.id === preset.id);
      if (index >= 0) user[index] = preset;
      else user.push(preset);
      await writeUserPresets(user);
      return preset;
    },
    async remove(id) {
      const target = asNonEmptyString(id);
      if (!target) throw new Error('preset id is required');
      if (BUILTIN_TEAM_PRESETS.some((entry) => entry.id === target)) {
        throw new Error('a built-in preset cannot be deleted');
      }
      const user = await readUserPresets();
      const next = user.filter((entry) => entry.id !== target);
      if (next.length === user.length) return false;
      await writeUserPresets(next);
      return true;
    },
  };
};
