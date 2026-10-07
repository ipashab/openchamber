import { beforeEach, describe, expect, mock, test } from 'bun:test';

import type { TeamMember } from '@/lib/team/team-board-api';

type OpenTabDescriptor = { mode: string; dedupeKey: string; label: string };
type OpenTabCall = [string, OpenTabDescriptor];
type PendingTextCall = [string, 'replace', string | null];
type SessionCall = [string, string];

const openTabCalls: OpenTabCall[] = [];
const pendingTextCalls: PendingTextCall[] = [];
const sessionCalls: SessionCall[] = [];

let currentSessionId: string | null = null;

const openContextPanelTab = (directory: string, descriptor: OpenTabDescriptor): void => {
  openTabCalls.push([directory, descriptor]);
};
const setPendingInputText = (text: string, mode: 'replace', target: string | null): void => {
  pendingTextCalls.push([text, mode, target]);
};
const setCurrentSession = (sessionId: string, directory: string): void => {
  sessionCalls.push([sessionId, directory]);
};

mock.module('@/lib/desktop', () => ({
  isVSCodeRuntime: () => false,
}));
mock.module('@/stores/useUIStore', () => ({
  useUIStore: {
    getState: () => ({
      isMobile: false,
      openContextPanelTab,
    }),
  },
}));
mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: {
    getState: () => ({
      currentSessionId,
      setCurrentSession,
    }),
  },
}));
mock.module('@/sync/input-store', () => ({
  useInputStore: {
    getState: () => ({
      setPendingInputText,
    }),
  },
}));

const { askLeadToStaff } = await import('./teamAskLead');

const directory = '/work/project';
const draft = 'Add a teammate suited for: ';
const lead: TeamMember = {
  slotId: 'lead',
  name: 'Team Lead',
  role: 'lead',
  status: 'idle',
  sessionId: 'ses_lead',
  unreadCount: 0,
};

beforeEach(() => {
  openTabCalls.length = 0;
  pendingTextCalls.length = 0;
  sessionCalls.length = 0;
  currentSessionId = null;
});

describe('askLeadToStaff routing', () => {
  test('a pinned chat tab gets the draft targeted at its own session', () => {
    askLeadToStaff(lead, draft, directory);

    expect(openTabCalls.length).toBe(1);
    const [calledDirectory, descriptor] = openTabCalls[0];
    expect(calledDirectory).toBe(directory);
    expect(descriptor.mode).toBe('chat');
    expect(descriptor.dedupeKey).toBe('session:ses_lead');

    expect(pendingTextCalls.length).toBe(1);
    const [text, mode, target] = pendingTextCalls[0];
    expect(text).toBe(draft);
    expect(mode).toBe('replace');
    expect(target).toBe('ses_lead');
  });

  test('the main composer is prefilled when the lead is already the main session', () => {
    currentSessionId = 'ses_lead';
    askLeadToStaff(lead, draft, directory);

    expect(openTabCalls.length).toBe(0);
    expect(pendingTextCalls.length).toBe(1);
    expect(pendingTextCalls[0][2]).toBe(null);
  });

  test('without a directory nothing is opened and no draft is planted', () => {
    askLeadToStaff(lead, draft, null);

    expect(openTabCalls.length).toBe(0);
    expect(sessionCalls.length).toBe(0);
    expect(pendingTextCalls.length).toBe(0);
  });
});
