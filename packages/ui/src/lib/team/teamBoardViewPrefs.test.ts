import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  readTeamBoardView,
  writeTeamBoardView,
} from './teamBoardViewPrefs';

// Изолированный прогон идёт без DOM: подменяем localStorage картой, а после
// файла возвращаем то, что было — прогон в своём процессе, но подмена не
// должна переживать сам тест-файл.
const originalDescriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
      clear: () => {
        values.clear();
      },
    },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  if (originalDescriptor) Object.defineProperty(globalThis, 'localStorage', originalDescriptor);
});

describe('teamBoardViewPrefs', () => {
  test('reads the stored view for one team and the default for strangers', () => {
    writeTeamBoardView('team-a', 'chats');
    expect(readTeamBoardView('team-a')).toBe('chats');
    expect(readTeamBoardView('team-b')).toBe('board');
  });

  test('keeps other teams’ choices when one team changes', () => {
    writeTeamBoardView('team-a', 'chats');
    writeTeamBoardView('team-b', 'activity');
    writeTeamBoardView('team-a', 'board');
    expect(readTeamBoardView('team-b')).toBe('activity');
    expect(readTeamBoardView('team-a')).toBe('board');
  });

  test('falls back to the board on unreadable or malformed storage', () => {
    globalThis.localStorage.setItem('oc.teamBoard.view.v1', '{not json');
    expect(readTeamBoardView('team-a')).toBe('board');
    globalThis.localStorage.setItem('oc.teamBoard.view.v1', JSON.stringify({ 'team-a': 'kanban' }));
    expect(readTeamBoardView('team-a')).toBe('board');
    // Мусор одного не должен ломать запись другого.
    writeTeamBoardView('team-b', 'chats');
    expect(readTeamBoardView('team-b')).toBe('chats');
  });
});
